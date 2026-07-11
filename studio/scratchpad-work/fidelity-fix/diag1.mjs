// diagnostic: per-ad pageFit, subjects, element kinds, text-origin verdicts
import { join } from 'node:path';
import { homedir } from 'node:os';
import { recognizeText } from '/Users/michael/Downloads/NEUEGEN/studio/lib/ocr.mjs';
import { loadPixels, fitRegionFill } from '/Users/michael/Downloads/NEUEGEN/studio/lib/fill-fit.mjs';
import { detectElements } from '/Users/michael/Downloads/NEUEGEN/studio/lib/element-detect.mjs';

const DIR = join(homedir(), 'Downloads', 'IMAGE AD INSPO');
const files = {
  '004': '004_attached_361e00093ff2bcb3.webp',
  '013': '013_attached_a32b069cce97685c.webp',
  '016': '016_attached_ac1eeeabce759396.webp',
  '018': '018_attached_38bcb499c6d517d0.webp',
};
const sharp = (await import('sharp')).default;

for (const [id, f] of Object.entries(files)) {
  const p = join(DIR, f);
  const png = `/tmp/claude-501/-Users-michael-Downloads-NEUEGEN/f33286ff-d54b-41ab-acc6-dcc39aae3fe7/scratchpad/${id}.png`;
  await sharp(p).toColourspace('srgb').png().toFile(png);
  const meta = await sharp(png).metadata();
  const s1 = await recognizeText(png);
  const pixels = await loadPixels(png);
  const pageFit = fitRegionFill(pixels, { x: 0, y: 0, w: meta.width, h: meta.height });
  console.log(`\n=== ${id} ${meta.width}x${meta.height} pageFit=${pageFit.kind} residual=${pageFit.residual} conf=${pageFit.confidence}`);
  if (pageFit.kind === 'linear') console.log('  stops:', JSON.stringify(pageFit.stops), 'angle', pageFit.angleDeg);
  const { elements } = detectElements(pixels, {
    textLines: (s1.lines || []).map((l) => l.box),
    background: pageFit.kind === 'flat' ? pageFit.color : (pageFit.kind !== 'photo' ? pageFit : null),
    photoRegions: [],
  });
  for (const el of elements.slice(0, 12)) {
    console.log(`  el ${el.id} kind=${el.kind} cov=${el.coverage} box=${JSON.stringify(el.box)} sol=${el.stats.solidity} dom=${el.stats.domColors} edge=${el.stats.edgeDensity}`);
  }
  console.log('  lines:', (s1.lines || []).length);
  for (const l of (s1.lines || []).slice(0, 20)) console.log(`    "${l.text}" box=${JSON.stringify(l.box)}`);
}
