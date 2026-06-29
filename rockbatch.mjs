// One-off builder: 5 rock/Sea-Salt-Spray prompts x 10 separate generations each = 50 jobs.
// Writes <run>/jobs.json for `node gen.mjs --jobs <run>/jobs.json --no-wait`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sizeAnchor } from './products.mjs';

const HOME = process.env.HOME;
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
const RUN = join(HOME, 'Downloads', 'simpletics-lifestyle', `${stamp}-rock5`);
mkdirSync(RUN, { recursive: true });

const REFS = [
  '/Users/mk/Downloads/Pasted 2026-06-25 at 1.16.09 AM.png',
  '/Users/mk/Downloads/Screenshot 2026-06-25 at 01.14.20.png',
  '/Users/mk/.claude/skills/simpletics-lifestyle/assets/sea-salt-spray.png',
];

// Shared tail clauses, lifted from the original prompt, applied to every shot.
const TAIL = "Color: match image one's exact color, white balance, contrast and saturation, do not apply your own grade, not more yellow, saturated or washed-out. Texture: a casual film snapshot, soft and slightly grainy, lower fidelity, real skin with pores and sun, not sharp, not glossy, not HDR clean. 16:9. No watermark, no extra text. Use this prompt exactly as written, do not modify or enhance it.";

const PRODUCT = `Keep the Sea Salt Spray from image three on the rock beside his hand or foot: small, ${sizeAnchor('sea-salt-spray')}, partly turned, sitting in the same light with a few water droplets, its label, colors and proportions exact, not staged, not facing the camera, just there.`;

const MODEL = "the exact same man from image two: keep his real face, bone structure, jaw, nose, wide-set eyes, freckles and his blonde wavy hair exactly, this specific person and not a different or more handsome model, do not idealize, beautify, slim or smooth him, a normal good-looking guy with real skin, not a glossy oiled airbrushed campaign model.";

const prompts = [
  {
    slug: 'original',
    text: `Use image one as the base. Edit it, do not generate a new scene from scratch. Keep image one's layout, composition, framing and lighting, shift the camera angle only slightly so it is not a one-to-one copy. Replace the man with ${MODEL} He stays on the rock in the same casual seated pose, looking back over his shoulder. Add the Sea Salt Spray from image three on the rock right beside his foot, replacing any bottle already there: small, ${sizeAnchor('sea-salt-spray')}, partly turned, catching the same light with a few water droplets, label, colors and proportions exact, not staged, not facing the camera. ${TAIL}`,
  },
  {
    slug: 'waterline',
    text: `Match the exact look of image one: its color, white balance, contrast, saturation and grainy film texture, hard Mediterranean sun, sea and stone. A new candid 35mm film shot of ${MODEL} He is standing in the shallow water at the waterline, wet, pushing his wet hair back with one hand, stepping out of the sea. Wider shot. ${PRODUCT.replace('beside his hand or foot', 'on a flat rock in the foreground beside him')} ${TAIL}`,
  },
  {
    slug: 'wringing',
    text: `Match the exact look of image one: its color, white balance, contrast, saturation and grainy film texture, hard Mediterranean sun on wet stone. A new candid 35mm film shot of ${MODEL} He is crouched low on the rocks wringing seawater from a t-shirt with both hands, looking down at it. Closer, candid framing. ${PRODUCT.replace('beside his hand or foot', 'on the rock ledge right beside him')} ${TAIL}`,
  },
  {
    slug: 'towel',
    text: `Match the exact look of image one: its color, white balance, contrast, saturation and grainy film texture, hard midday Mediterranean sun. A new candid 35mm film shot of ${MODEL} He is lying back on a towel on the warm flat rock, one forearm resting over his eyes to shield them from the sun, relaxed. Slight high angle looking down at him. ${PRODUCT.replace('beside his hand or foot', 'standing on the stone near his hand')} ${TAIL}`,
  },
  {
    slug: 'profile',
    text: `Match the exact look of image one: its color, white balance, contrast, saturation and grainy film texture, hard Mediterranean sun, sea behind. A new candid 35mm film shot of ${MODEL} Side profile, sitting on the rocks looking out to sea, drying off, his hair salt-dried and textured. Medium shot. ${PRODUCT.replace('beside his hand or foot', 'low in the corner of the frame on the stone beside him')} ${TAIL}`,
  },
];

const NUM = Number(process.argv[2]) || prompts.length;
const VARIANTS = Number(process.argv[3]) || 10;
const jobs = [];
for (const p of prompts.slice(0, NUM)) {
  jobs.push({
    name: p.slug,
    prompt: p.text,
    out: join(RUN, `${p.slug}.png`),
    refs: REFS,
    variants: VARIANTS,
    aspect: '16:9',
  });
}

const jobsFile = join(RUN, 'jobs.json');
writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
console.log(RUN);
console.log(jobsFile);
console.log(`${jobs.length} jobs (${jobs.length} prompts x ${VARIANTS} variations)`);
