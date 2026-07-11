// why didn't the masked page re-fit fire for 013 / 016?
import { recognizeText } from '../../lib/ocr.mjs';
import { loadPixels, fitRegionFill } from '../../lib/fill-fit.mjs';
import { detectElements } from '../../lib/element-detect.mjs';
import { dilateBoxPx } from '../../lib/copy-pipeline.mjs';

for (const id of ['013', '016']) {
  const png = `/private/tmp/claude-501/-Users-michael-Downloads-NEUEGEN/f33286ff-d54b-41ab-acc6-dcc39aae3fe7/scratchpad/${id}.png`;
  const s1 = await recognizeText(png);
  const pixels = await loadPixels(png);
  const W = pixels.width, H = pixels.height;
  const ocrLines = s1.lines.filter((l) => l?.box && l.box.w > 0 && l.box.h > 0);
  const { elements: el0 } = detectElements(pixels, { textLines: ocrLines.map((l) => l.box), background: null, photoRegions: [] });
  const mask = new Uint8Array(W * H).fill(1);
  const zero = (b, dx, dy) => {
    const d = dilateBoxPx(b, dx, dy, W, H);
    for (let y = d.y; y < d.y + d.h; y++) mask.fill(0, y * W + d.x, y * W + d.x + d.w);
  };
  for (const l of ocrLines) zero(l.box, l.box.w * 0.06 + 4, l.box.h * 0.2 + 4);
  let elCount = 0;
  for (const el of el0) if ((el.coverage ?? 0) >= 0.0005) { zero(el.box, 4, 4); elCount++; }
  let valid = 0;
  for (let i = 0; i < mask.length; i++) valid += mask[i];
  const validFrac = valid / mask.length;
  const refit = fitRegionFill(pixels, { x: 0, y: 0, w: W, h: H, mask });
  console.log(`${id}: validFrac=${validFrac.toFixed(3)} elZeroed=${elCount} refit=${refit.kind} residual=${refit.residual} conf=${refit.confidence}`, refit.kind === 'linear' ? refit.stops : refit.color || refit.detail || '');
}
