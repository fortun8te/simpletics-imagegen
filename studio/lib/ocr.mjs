// lib/ocr.mjs — S1 OCR facts producer (COPY-ENGINE-V2 §3.1, CONTRACTS "S1").
//
// recognizeText(imagePath, {cache=true}) spawns the compiled Apple Vision CLI
// (bin/ocrjson, source tools/ocrjson/main.swift) and returns the S1 schema object
// with an added `ok:true` — or `{ok:false, error}` on ANY failure. It never throws
// for model/engine reasons; callers can always destructure `{ok}`.
//
// Invariants:
// - Cache: sha256 of the image BYTES → .state/ocr-cache/<sha>.json (atomic writes via
//   lib/atomic-write.mjs; corrupt cache entries are treated as misses, never fatal).
//   Cache hits are marked `cached:true`; fresh runs `cached:false`.
// - Binary bootstrap: if bin/ocrjson is missing and /usr/bin/swiftc exists, build it
//   via tools/ocrjson/build.sh once (best-effort, ~10 s).
// - Vision/ImageIO reads webp/jpg/png natively (verified against the harness corpus),
//   so non-PNG inputs pass through unchanged. If the CLI still fails to decode, we
//   transcode with `sips -s format png` to a temp file and retry (same pattern as
//   lib/layout-extract.mjs); coordinates are unchanged (sips keeps pixel dims) and
//   source.path is rewritten back to the original.
//
// Called by: the S1 stage of the copy pipeline (and standalone tests/harnesses).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from './atomic-write.mjs';

const STUDIO = path.dirname(fileURLToPath(new URL('.', import.meta.url))); // .../studio
const BIN = path.join(STUDIO, 'bin', 'ocrjson');
const BUILD_SH = path.join(STUDIO, 'tools', 'ocrjson', 'build.sh');
const CACHE_DIR = path.join(STUDIO, '.state', 'ocr-cache');
const SWIFTC = '/usr/bin/swiftc';
const CLI_TIMEOUT_MS = 60_000;

/** Ensure bin/ocrjson exists; build it via build.sh when swiftc is available.
 *  Returns true when the binary is present afterwards. */
function ensureBinary() {
  if (existsSync(BIN)) return true;
  if (!existsSync(SWIFTC) || !existsSync(BUILD_SH)) return false;
  try {
    const r = spawnSync('sh', [BUILD_SH], { encoding: 'utf8', timeout: 180_000 });
    if (r.status !== 0) return false;
  } catch { return false; }
  return existsSync(BIN);
}

/** Run the CLI once. Returns { ok, json?, error? }. */
function runCli(imagePath) {
  let r;
  try {
    r = spawnSync(BIN, [imagePath], { encoding: 'utf8', timeout: CLI_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    return { ok: false, error: `ocrjson spawn failed: ${err?.message || err}` };
  }
  if (r.error) return { ok: false, error: `ocrjson spawn failed: ${r.error.message}` };
  let json = null;
  try { json = JSON.parse(r.stdout || ''); } catch { /* handled below */ }
  if (r.status !== 0) {
    return { ok: false, error: json?.error || `ocrjson exit ${r.status}: ${String(r.stderr || '').slice(0, 300)}` };
  }
  if (!json || !Array.isArray(json.lines)) {
    return { ok: false, error: 'ocrjson produced no parsable S1 JSON' };
  }
  return { ok: true, json };
}

/** Transcode a non-PNG input to a temp PNG via sips (same fallback pattern as
 *  lib/layout-extract.mjs). Returns the temp path, or null when sips fails. */
function sipsToPng(imagePath) {
  const tmp = path.join(CACHE_DIR, `transcode-${process.pid}-${Date.now()}.png`);
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const r = spawnSync('sips', ['-s', 'format', 'png', imagePath, '--out', tmp], { encoding: 'utf8', timeout: 15_000 });
    if (r.status === 0 && existsSync(tmp)) return tmp;
  } catch { /* sips unavailable → give up gracefully */ }
  try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
  return null;
}

/**
 * OCR an image via Apple Vision. Returns the S1 schema object (CONTRACTS.md) plus
 * `ok:true, cached:boolean`, or `{ok:false, error}` — never throws for engine reasons.
 * @param {string} imagePath  png/webp/jpg on disk
 * @param {{cache?: boolean}} [opts]
 */
export async function recognizeText(imagePath, { cache = true } = {}) {
  let bytes;
  try { bytes = readFileSync(imagePath); } catch (err) {
    return { ok: false, error: `cannot read image: ${err?.message || err}` };
  }
  const sha = createHash('sha256').update(bytes).digest('hex');
  const cachePath = path.join(CACHE_DIR, `${sha}.json`);

  if (cache && existsSync(cachePath)) {
    try {
      const hit = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (hit && Array.isArray(hit.lines)) return { ok: true, cached: true, ...hit };
    } catch { /* corrupt cache entry → recompute */ }
  }

  if (!ensureBinary()) {
    return { ok: false, error: `ocr binary missing at ${BIN} and swiftc unavailable to build it` };
  }

  let res = runCli(imagePath);

  // Decode failure on a non-PNG container → transcode via sips and retry once.
  if (!res.ok && /could not decode/i.test(res.error || '') && !/\.png$/i.test(imagePath)) {
    const tmp = sipsToPng(imagePath);
    if (tmp) {
      const retry = runCli(tmp);
      try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
      if (retry.ok) {
        retry.json.source.path = imagePath; // report the caller's path, not the temp file
        res = retry;
      }
    }
  }

  if (!res.ok) return { ok: false, error: res.error };

  const s1 = res.json;
  s1.source.path = path.resolve(imagePath);
  if (cache) {
    try { writeAtomic(cachePath, JSON.stringify(s1)); } catch { /* cache is best-effort */ }
  }
  return { ok: true, cached: false, ...s1 };
}
