// tools/ocrjson/main.swift — S1 OCR facts CLI (Apple Vision, VNRecognizeTextRequest accurate mode).
//
// Role: deterministic text extraction for the copy engine (COPY-ENGINE-V2 §3.1). Reads one
// image (argv[1]), emits the S1 JSON schema (COPY-ENGINE-V2-CONTRACTS.md) on stdout:
// per-LINE observations (text/conf/quad/axis-aligned box) + per-WORD boxes via
// boundingBox(for:) on the top candidate, whitespace-split.
//
// Invariants:
// - All coordinates are SOURCE-IMAGE PIXELS, origin TOP-LEFT (Vision's normalized
//   bottom-left coords are converted here, using CGImageSource pixel dims).
// - usesLanguageCorrection = false: ad text is full of brand names ("grüns", "Ozempic")
//   that a language model would "correct" away.
// - Line ids L<n> follow reading order: rows top-to-bottom, left-to-right within a row.
// - Errors: JSON {"error":"..."} on stdout + nonzero exit. Never a partial document.
//
// Called by: lib/ocr.mjs (recognizeText), which caches by image sha256. No job coupling —
// pure argv → stdout, so it is independently testable: bin/ocrjson <image>.
//
// Build: tools/ocrjson/build.sh  (swiftc -O tools/ocrjson/main.swift -o bin/ocrjson)

import Foundation
import Vision
import ImageIO
import CoreGraphics

// ---------- output schema ----------

struct Box: Codable { let x: Double; let y: Double; let w: Double; let h: Double }
struct WordOut: Codable { let text: String; let conf: Double; let box: Box; let quad: [[Double]] }
struct LineOut: Codable {
    let id: String; let text: String; let conf: Double
    let box: Box; let quad: [[Double]]; let words: [WordOut]
}
struct SourceOut: Codable { let path: String; let w: Int; let h: Int }
struct S1: Codable { let engine: String; let source: SourceOut; let ms: Int; let lines: [LineOut] }

func emit<T: Encodable>(_ value: T) {
    let enc = JSONEncoder()
    enc.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? enc.encode(value), let s = String(data: data, encoding: .utf8) else {
        print(#"{"error":"json encode failed"}"#); exit(1)
    }
    print(s)
}

func fail(_ msg: String) -> Never {
    emit(["error": msg]); exit(1)
}

// ---------- geometry helpers ----------

func r1(_ v: Double) -> Double { (v * 10).rounded() / 10 } // 0.1 px is plenty

/// Vision quad (normalized, origin bottom-left) → source pixels, origin top-left.
/// Order kept TL,TR,BR,BL (matches VNRectangleObservation's visual corner names).
func pixelQuad(_ o: VNRectangleObservation, w: Double, h: Double) -> [[Double]] {
    [o.topLeft, o.topRight, o.bottomRight, o.bottomLeft].map {
        [r1($0.x * w), r1((1.0 - $0.y) * h)]
    }
}

/// Axis-aligned bbox of a pixel quad.
func quadBox(_ q: [[Double]]) -> Box {
    let xs = q.map { $0[0] }, ys = q.map { $0[1] }
    let x0 = xs.min() ?? 0, y0 = ys.min() ?? 0
    return Box(x: r1(x0), y: r1(y0), w: r1((xs.max() ?? 0) - x0), h: r1((ys.max() ?? 0) - y0))
}

// ---------- main ----------

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: ocrjson <image-path>") }
let path = args[1]
guard FileManager.default.fileExists(atPath: path) else { fail("no such file: \(path)") }

let url = URL(fileURLWithPath: path)
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    fail("could not decode image: \(path)")
}

// Pixel dims + EXIF orientation from the container (webp/jpg/png all supported by ImageIO).
let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] ?? [:]
let rawW = (props[kCGImagePropertyPixelWidth] as? Int) ?? cg.width
let rawH = (props[kCGImagePropertyPixelHeight] as? Int) ?? cg.height
let orientRaw = (props[kCGImagePropertyOrientation] as? UInt32) ?? 1
let orientation = CGImagePropertyOrientation(rawValue: orientRaw) ?? .up
// Orientations 5-8 rotate 90°: the ORIENTED (display) dims swap. Vision's normalized
// coords are relative to the oriented image when the handler is given the orientation.
let (W, H) = orientRaw >= 5 ? (rawH, rawW) : (rawW, rawH)
let dw = Double(W), dh = Double(H)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["en", "nl", "de", "fr", "es"]

let t0 = DispatchTime.now()
let handler = VNImageRequestHandler(cgImage: cg, orientation: orientation, options: [:])
do { try handler.perform([request]) } catch { fail("vision failed: \(error.localizedDescription)") }
let ms = Int(Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6)

struct RawLine { let text: String; let conf: Double; let box: Box; let quad: [[Double]]; let words: [WordOut] }

var raw: [RawLine] = []
for obs in request.results ?? [] {
    guard let cand = obs.topCandidates(1).first else { continue }
    let text = cand.string
    if text.isEmpty { continue }
    let lineQuad = pixelQuad(obs, w: dw, h: dh)
    let lineBox = quadBox(lineQuad)

    // Per-word boxes: split the candidate string on whitespace, ask Vision for the
    // bounding rect of each token's character range.
    var words: [WordOut] = []
    var i = text.startIndex
    while i < text.endIndex {
        while i < text.endIndex, text[i].isWhitespace { i = text.index(after: i) }
        guard i < text.endIndex else { break }
        var j = i
        while j < text.endIndex, !text[j].isWhitespace { j = text.index(after: j) }
        let token = String(text[i..<j])
        if let rect = try? cand.boundingBox(for: i..<j) {
            let q = pixelQuad(rect, w: dw, h: dh)
            words.append(WordOut(text: token, conf: Double(cand.confidence), box: quadBox(q), quad: q))
        } else {
            // Range lookup failed (rare) — fall back to the line box so the word is never lost.
            words.append(WordOut(text: token, conf: Double(cand.confidence), box: lineBox, quad: lineQuad))
        }
        i = j
    }
    raw.append(RawLine(text: text, conf: Double(cand.confidence), box: lineBox, quad: lineQuad, words: words))
}

// Reading order: sort by vertical center, group lines whose centers sit within half the
// taller line's height into a row, then left-to-right within each row.
let byY = raw.sorted { ($0.box.y + $0.box.h / 2) < ($1.box.y + $1.box.h / 2) }
var rows: [[RawLine]] = []
for line in byY {
    let cy = line.box.y + line.box.h / 2
    if let ref = rows.last?.first {
        let refCy = ref.box.y + ref.box.h / 2
        if abs(cy - refCy) < max(line.box.h, ref.box.h) * 0.5 {
            rows[rows.count - 1].append(line)
            continue
        }
    }
    rows.append([line])
}
let ordered = rows.flatMap { $0.sorted { $0.box.x < $1.box.x } }

let lines = ordered.enumerated().map { (n, l) in
    LineOut(id: "L\(n)", text: l.text, conf: min(1, (l.conf * 100).rounded() / 100),
            box: l.box, quad: l.quad, words: l.words)
}

emit(S1(engine: "apple-vision",
        source: SourceOut(path: path, w: W, h: H),
        ms: ms,
        lines: lines))
