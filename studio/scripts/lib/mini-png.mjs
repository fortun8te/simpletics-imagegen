// mini-png.mjs — zero-dep PNG encode/decode used ONLY by the cutout parity harness.
// Encodes/decodes non-interlaced 8-bit RGBA (colorType 6). Enough to build synthetic test
// images, feed them through the real renderers, and sample the pixels that come back out.
// Not a general PNG library — deliberately minimal and dependency-free (node:zlib only), so the
// harness never needs `canvas`/`sharp`/`pngjs`.

import { deflateSync, inflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC32 (PNG polynomial).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode { width, height, data (RGBA Uint8) } → PNG Buffer (no line prediction, filter 0). */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (none)
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode a PNG Buffer → { width, height, data (RGBA Uint8Array) }. Handles 8-bit RGB(2)/RGBA(6),
 *  all 5 line filters, non-interlaced. Throws on anything else. */
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === 'IEND') break;
    off = dataStart + len + 4;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (bd=${bitDepth} il=${interlace})`);
  const srcCh = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!srcCh) throw new Error(`unsupported colorType ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * srcCh;
  const un = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = un.subarray(y * stride, y * stride + stride);
    for (let i = 0; i < stride; i++) {
      const x = raw[pos++];
      const a = i >= srcCh ? row[i - srcCh] : 0;
      const b = prev[i];
      const c = i >= srcCh ? prev[i - srcCh] : 0;
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else v = x + paeth(a, b, c);
      row[i] = v & 0xff;
    }
    prev = row;
  }
  // Expand to RGBA.
  const data = new Uint8Array(width * height * 4);
  for (let p = 0, q = 0; p < un.length; p += srcCh, q += 4) {
    data[q] = un[p];
    data[q + 1] = un[p + 1];
    data[q + 2] = un[p + 2];
    data[q + 3] = srcCh === 4 ? un[p + 3] : 255;
  }
  return { width, height, data };
}

/** Sample the RGBA at fractional position (fx, fy in 0..1) of a decoded image. */
export function sampleFrac(img, fx, fy) {
  const x = Math.min(img.width - 1, Math.max(0, Math.floor(fx * img.width)));
  const y = Math.min(img.height - 1, Math.max(0, Math.floor(fy * img.height)));
  const p = (y * img.width + x) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2], img.data[p + 3]];
}

/** Sample the RGBA at integer pixel (px, py). */
export function samplePx(img, px, py) {
  const x = Math.min(img.width - 1, Math.max(0, Math.round(px)));
  const y = Math.min(img.height - 1, Math.max(0, Math.round(py)));
  const p = (y * img.width + x) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2], img.data[p + 3]];
}

/** Parse a `data:image/png;base64,...` URL into a decoded image. */
export function decodeDataUrl(dataUrl) {
  const m = /^data:image\/png;base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw new Error('not a png data url: ' + String(dataUrl).slice(0, 40));
  return decodePng(Buffer.from(m[1], 'base64'));
}
