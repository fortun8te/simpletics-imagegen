// Probe: trace crops from inspo ads, dump raw stats to calibrate the quality gate.
import sharp from 'sharp';
import ImageTracer from 'imagetracerjs';
import { writeFileSync } from 'node:fs';

const OPTS = {
  ltres: 1, qtres: 1, pathomit: 12, numberofcolors: 6,
  colorsampling: 2, mincolorratio: 0, colorquantcycles: 3,
  blurradius: 0, rightangleenhance: true, roundcoords: 2,
  strokewidth: 0, linefilter: false, viewbox: true, desc: false, scale: 1,
};

async function probe(src, crop, name) {
  const meta = await sharp(src).metadata();
  const left = Math.round(crop.x * meta.width), top = Math.round(crop.y * meta.height);
  const width = Math.round(crop.w * meta.width), height = Math.round(crop.h * meta.height);
  const { data, info } = await sharp(src).extract({ left, top, width, height }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const imgData = { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
  const svg = ImageTracer.imagedataToSVG(imgData, OPTS);
  writeFileSync(`/Users/michael/Downloads/NEUEGEN/studio/scratchpad-work/trace-bench/${name}-raw.svg`, svg);

  // parse paths
  const re = /<path [^>]*fill="rgb\((\d+),(\d+),(\d+)\)"[^>]*opacity="([\d.]+)"[^>]*d="([^"]+)"/g;
  let m; const paths = [];
  while ((m = re.exec(svg))) paths.push({ r: +m[1], g: +m[2], b: +m[3], a: +m[4], d: m[5] });

  // border color
  let br = 0, bg = 0, bb = 0, bn = 0;
  const px = (x, y) => (y * info.width + x) * 4;
  for (let x = 0; x < info.width; x++) for (const y of [0, info.height - 1]) { const i = px(x, y); if (data[i + 3] > 32) { br += data[i]; bg += data[i + 1]; bb += data[i + 2]; bn++; } }
  for (let y = 0; y < info.height; y++) for (const x of [0, info.width - 1]) { const i = px(x, y); if (data[i + 3] > 32) { br += data[i]; bg += data[i + 1]; bb += data[i + 2]; bn++; } }
  const border = bn ? [br / bn, bg / bn, bb / bn] : null;

  // per-path area via shoelace on M/L/Q endpoints
  const areaOf = (d) => {
    const toks = d.trim().split(/[\s,]+/);
    let i = 0, total = 0, pts = [];
    const flush = () => {
      if (pts.length >= 3) { let s = 0; for (let k = 0; k < pts.length; k++) { const [x1, y1] = pts[k], [x2, y2] = pts[(k + 1) % pts.length]; s += x1 * y2 - x2 * y1; } total += s / 2; }
      pts = [];
    };
    while (i < toks.length) {
      const t = toks[i];
      if (t === 'M') { flush(); pts.push([+toks[i + 1], +toks[i + 2]]); i += 3; }
      else if (t === 'L') { pts.push([+toks[i + 1], +toks[i + 2]]); i += 3; }
      else if (t === 'Q') { pts.push([+toks[i + 3], +toks[i + 4]]); i += 5; }
      else if (t === 'Z') { i += 1; }
      else i += 1;
    }
    flush();
    return total; // signed
  };

  const cropArea = info.width * info.height;
  const byFill = new Map();
  for (const p of paths) {
    const key = `${p.r},${p.g},${p.b},${p.a}`;
    const e = byFill.get(key) || { paths: 0, area: 0, subpaths: 0 };
    e.paths++; e.area += Math.abs(areaOf(p.d)); e.subpaths += (p.d.match(/M /g) || []).length;
    byFill.set(key, e);
  }
  console.log(`\n=== ${name} (${info.width}x${info.height}, border rgb ${border?.map(v => v.toFixed(0))})`);
  for (const [k, e] of byFill) console.log(`  fill ${k}: ${e.paths} paths, ${e.subpaths} subpaths, area ${(e.area / cropArea * 100).toFixed(1)}% of crop`);
  console.log(`  total path elements: ${paths.length}`);
}

const INSPO = '/Users/michael/Downloads/IMAGE AD INSPO';
await probe(`${INSPO}/002_attached_5885519ba4359843.webp`, { x: 0.442, y: 0.055, w: 0.122, h: 0.066 }, '002-emblem');
