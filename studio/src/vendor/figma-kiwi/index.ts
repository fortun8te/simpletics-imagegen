// figma-kiwi — minimal encoder/decoder for Figma's clipboard payload format.
//
// Figma's clipboard is `text/html` wrapping a base64 ".fig-style" binary archive:
//
//   <meta charset="utf-8">
//   <span data-metadata="<!--(figmeta)BASE64_JSON(/figmeta)-->"></span>
//   <span data-buffer="<!--(figma)BASE64_ARCHIVE(/figma)-->"></span>
//
// The archive is: 8-byte magic "fig-kiwi" + uint32 LE version + repeated
// [uint32 LE length][chunk] — chunk 0 is the deflate-raw-compressed kiwi BINARY SCHEMA,
// chunk 1 is the deflate-raw-compressed kiwi-encoded Message. Because the payload carries
// its own schema, Figma can decode data produced by any writer whose schema it understands;
// we reuse a schema chunk captured from a real Figma copy (see ./schema.ts) verbatim and
// only encode the message chunk ourselves.
//
// Dependencies: kiwi-schema (MIT, by Figma co-founder Evan Wallace) and pako (MIT).
// Format knowledge: reverse-engineering write-ups + the OSS projects fig-kiwi (darknoon)
// and fig-kiwi-toolbox (interlace-app). See ./README.md for attribution.

import { compileSchema, decodeBinarySchema } from 'kiwi-schema';
import { deflateRaw, inflateRaw } from 'pako';
import { FIG_SCHEMA_DEFLATED_BASE64, FIG_VERSION } from './schema';

// ── loosely-typed message shapes (only the fields we produce) ────────────────────────────────────

export interface FigGUID { sessionID: number; localID: number }
export interface FigColor { r: number; g: number; b: number; a: number }
export interface FigMatrix { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number }

/** Figma NodeChange — open-ended; the kiwi schema tolerates any subset of fields. */
export type FigNodeChange = { guid: FigGUID; type: string } & Record<string, unknown>;

export interface FigMessage {
  type: 'NODE_CHANGES';
  sessionID: number;
  ackID: number;
  pasteID: number;
  pasteFileKey: string;
  pasteIsPartiallyOutsideEnclosingFrame: boolean;
  pastePageId: FigGUID;
  isCut: boolean;
  pasteEditorType: 'DESIGN';
  publishedAssetGuids: FigGUID[];
  nodeChanges: FigNodeChange[];
  blobs: Array<{ bytes: Uint8Array }>;
}

export interface FigMeta { fileKey: string; pasteID: number; dataType: 'scene' }

// ── base64 (browser + node) ──────────────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8ToBase64(s: string): string {
  return bytesToBase64(new TextEncoder().encode(s));
}

// ── schema (compiled lazily, once) ───────────────────────────────────────────────────────────────

interface CompiledFigSchema {
  encodeMessage(msg: unknown): Uint8Array;
  decodeMessage(bytes: Uint8Array): FigMessage;
}

let cached: { chunk: Uint8Array; compiled: CompiledFigSchema } | null = null;

function figSchema(): { chunk: Uint8Array; compiled: CompiledFigSchema } {
  if (!cached) {
    const chunk = base64ToBytes(FIG_SCHEMA_DEFLATED_BASE64);
    const schema = decodeBinarySchema(inflateRaw(chunk));
    cached = { chunk, compiled: compileSchema(schema) as unknown as CompiledFigSchema };
  }
  return cached;
}

// ── archive read/write ───────────────────────────────────────────────────────────────────────────

const MAGIC = 'fig-kiwi';

function writeArchive(chunks: Uint8Array[]): Uint8Array {
  let total = 8 + 4;
  for (const c of chunks) total += 4 + c.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) out[i] = MAGIC.charCodeAt(i);
  view.setUint32(8, FIG_VERSION, true);
  let off = 12;
  for (const c of chunks) {
    view.setUint32(off, c.length, true);
    out.set(c, off + 4);
    off += 4 + c.length;
  }
  return out;
}

function readArchive(data: Uint8Array): Uint8Array[] {
  const magic = String.fromCharCode(...data.subarray(0, 8));
  if (magic !== MAGIC) throw new Error(`bad archive magic "${magic}"`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const chunks: Uint8Array[] = [];
  let off = 12;
  while (off + 4 <= data.length) {
    const len = view.getUint32(off, true);
    chunks.push(data.subarray(off + 4, off + 4 + len));
    off += 4 + len;
  }
  return chunks;
}

// ── public API ───────────────────────────────────────────────────────────────────────────────────

/** Encode a Figma message + meta into the text/html clipboard string Figma pastes natively. */
export function encodeFigmaClipboardHtml(meta: FigMeta, message: FigMessage): string {
  const { chunk, compiled } = figSchema();
  const dataChunk = deflateRaw(compiled.encodeMessage(message));
  const archive = writeArchive([chunk, dataChunk]);
  const metaB64 = utf8ToBase64(JSON.stringify(meta));
  const bufB64 = bytesToBase64(archive);
  return (
    '<meta charset="utf-8">' +
    `<span data-metadata="<!--(figmeta)${metaB64}(/figmeta)-->"></span>` +
    `<span data-buffer="<!--(figma)${bufB64}(/figma)-->"></span>`
  );
}

/** Decode a Figma clipboard HTML string back to meta + message (used for roundtrip tests). */
export function decodeFigmaClipboardHtml(html: string): { meta: FigMeta; message: FigMessage } {
  const metaMatch = html.match(/<!--\(figmeta\)([\s\S]*?)\(\/figmeta\)-->/);
  const bufMatch = html.match(/<!--\(figma\)([\s\S]*?)\(\/figma\)-->/);
  if (!metaMatch || !bufMatch) throw new Error('not a Figma clipboard payload');
  const meta = JSON.parse(new TextDecoder().decode(base64ToBytes(metaMatch[1]))) as FigMeta;
  const chunks = readArchive(base64ToBytes(bufMatch[1]));
  if (chunks.length < 2) throw new Error('archive missing schema/data chunks');
  // Decode with the EMBEDDED schema (chunk 0), like Figma does — not our cached one.
  const schema = decodeBinarySchema(inflateRaw(chunks[0]));
  const compiled = compileSchema(schema) as unknown as CompiledFigSchema;
  const message = compiled.decodeMessage(inflateRaw(chunks[1]));
  return { meta, message };
}
