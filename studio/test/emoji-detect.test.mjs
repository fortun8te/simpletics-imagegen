// test/emoji-detect.test.mjs — lib/emoji-detect.mjs (zero-framework, tiny assert harness).
//
// Synthetic cases:
//   - colorfulness gate: a colorful square passes, a gray square fails (isColorfulSquare).
//   - Apple round-trip: an atlas Apple glyph pasted on a background is recovered top-1 with
//     codepoint + set:'apple'. (skip-marked if the Apple atlas didn't build — Twemoji path
//     is exercised instead.)
//   - a colorful non-emoji swatch (random noise) → no confident emoji (or set:'unknown').
// Real-corpus cases (skip gracefully if ~/Downloads/IMAGE AD INSPO/ absent): run 009, 010,
//   017 with hand-eyeballed fractional boxes (spec §3 ground truth) and PRINT recovered
//   codepoints/sets + write debug crops to .state/emoji-atlas/debug/.
//
// Run:  node test/emoji-detect.test.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { detectEmoji, isColorfulSquare, loadEmojiAtlases } from '../lib/emoji-detect.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUDIO = join(__dirname, '..');
const ATLAS_DIR = join(STUDIO, '.state', 'emoji-atlas');
const DEBUG_DIR = join(ATLAS_DIR, 'debug');

// ── tiny harness ──
let pass = 0, fail = 0, skip = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }
function skipped(msg) { skip++; console.log(`  skip ${msg}`); }
async function section(name, fn) { console.log(`\n# ${name}`); try { await fn(); } catch (e) { fail++; console.log(`  FAIL (threw) ${name}: ${e?.stack || e}`); } }

// paste a 64×64-ish glyph PNG (with alpha) onto a solid background at (x,y)
async function pasteGlyph(glyphPng, bg, W, H, x, y, size) {
  const g = await sharp(glyphPng).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const base = await sharp({ create: { width: W, height: H, channels: 4, background: bg } })
    .composite([{ input: g, left: x, top: y }])
    .png().toBuffer();
  return base;
}

async function run() {
  const atlas = loadEmojiAtlases();
  const haveAtlas = atlas.entries.length > 0;
  const haveApple = (atlas.setCounts?.apple || 0) > 0;
  console.log(`atlas: ${atlas.entries.length} entries, sets=${JSON.stringify(atlas.setCounts)}`);

  await section('colorfulness gate', () => {
    const W = 40, H = 40;
    // colorful square (rainbow-ish blocks)
    const c = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      c[i * 4] = (i * 7) % 256; c[i * 4 + 1] = (i * 13) % 256; c[i * 4 + 2] = (i * 29) % 256; c[i * 4 + 3] = 255;
    }
    const gate1 = isColorfulSquare({ data: c, width: W, height: H }, { x: 0, y: 0, w: W, h: H });
    ok(gate1.pass, `colorful square passes gate (nonGray=${gate1.nonGrayFraction.toFixed(2)}, dom=${gate1.domColors})`);
    // gray square
    const g = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { const v = 120; g[i * 4] = v; g[i * 4 + 1] = v; g[i * 4 + 2] = v; g[i * 4 + 3] = 255; }
    const gate2 = isColorfulSquare({ data: g, width: W, height: H }, { x: 0, y: 0, w: W, h: H });
    ok(!gate2.pass, `gray square fails gate (nonGray=${gate2.nonGrayFraction.toFixed(2)}, dom=${gate2.domColors})`);
    // wide non-square colorful bar fails the aspect part
    const gate3 = isColorfulSquare({ data: c, width: W, height: H }, { x: 0, y: 0, w: W, h: 6 });
    ok(!gate3.square, `wide bar flagged non-square (aspect=${gate3.aspect.toFixed(1)})`);
  });

  if (!haveAtlas) {
    console.log('\n(no atlas built — run scripts/build-emoji-atlas.mjs; synthetic ID + corpus cases skipped)');
  } else {
    // pick a stable test glyph that exists: prefer apple hourglass, else any entry with apple, else any
    const pickSet = haveApple ? 'apple' : ['twemoji', 'noto', 'openmoji'].find((s) => (atlas.setCounts?.[s] || 0) > 0);
    const target = atlas.entries.find((e) => e.codepoint === '231b' && e.byGray[pickSet])
      || atlas.entries.find((e) => e.byGray[pickSet]);

    await section(`synthetic round-trip (set=${pickSet}, glyph=${target.codepoint} "${target.char}")`, async () => {
      const glyphPng = join(ATLAS_DIR, pickSet, `${target.codepoint}.png`);
      const W = 300, H = 200, size = 60, x = 120, y = 70;
      const bg = { r: 245, g: 245, b: 245, alpha: 1 };
      const png = await pasteGlyph(glyphPng, bg, W, H, x, y, size);
      const box = { x: x - 4, y: y - 4, w: size + 8, h: size + 8 };
      const res = await detectEmoji(png, [box], { atlas });
      const top = res.emoji[0];
      ok(top && top.codepoint === target.codepoint, `recovers codepoint ${target.codepoint} (got ${top ? top.codepoint + ' "' + top.char + '"' : 'none'}, conf=${top?.confidence})`);
      if (haveApple && pickSet === 'apple') {
        ok(top && (top.set === 'apple' || top.set === 'other'), `identifies set apple/other (got ${top?.set}, margin=${top?.setMargin})`);
      } else {
        skipped('apple-set identity (apple atlas absent) — used ' + pickSet + ' path');
      }
    });

    await section('colorful non-emoji swatch → no confident emoji', async () => {
      const W = 200, H = 200;
      const noise = new Uint8Array(W * H * 4);
      for (let i = 0; i < W * H; i++) {
        noise[i * 4] = (Math.sin(i) * 127 + 128) & 255;
        noise[i * 4 + 1] = (Math.cos(i * 1.7) * 127 + 128) & 255;
        noise[i * 4 + 2] = (Math.sin(i * 0.3) * 127 + 128) & 255;
        noise[i * 4 + 3] = 255;
      }
      const png = await sharp(Buffer.from(noise), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
      const res = await detectEmoji(png, [{ x: 60, y: 60, w: 70, h: 70 }], { atlas });
      ok(res.emoji.length === 0, `no confident emoji on noise swatch (got ${res.emoji.length})`);
    });
  }

  // ── real corpus ──
  const INSPO = join(homedir(), 'Downloads', 'IMAGE AD INSPO');
  const findImg = (prefix) => {
    if (!existsSync(INSPO)) return null;
    const f = readdirSync(INSPO).find((n) => n.startsWith(prefix) && /\.(png|jpe?g|webp)$/i.test(n));
    return f ? join(INSPO, f) : null;
  };

  const corpus = [
    { id: '009', truth: [['231b', '⏳'], ['1f440', '👀']],
      boxes: [{ x: 0.655, y: 0.295, w: 0.050, h: 0.055 }, { x: 0.566, y: 0.682, w: 0.040, h: 0.030 }] },
    { id: '010', truth: [['1f979', '🥹'], ['1f62a', '😪'], ['1f91d', '🤝'], ['1f64c-1f3fb', '🙌🏻']],
      // the 3-emoji inline cluster after "WAT. EEN. JAAR. " split into thirds + the toned hands
      boxes: [
        { x: 0.398, y: 0.287, w: 0.038, h: 0.024 },
        { x: 0.436, y: 0.287, w: 0.038, h: 0.024 },
        { x: 0.474, y: 0.289, w: 0.038, h: 0.024 },
        { x: 0.356, y: 0.657, w: 0.041, h: 0.023 },
      ] },
    { id: '017', truth: [['1f624', '😤']],
      boxes: [{ x: 0.450, y: 0.115, w: 0.090, h: 0.055 }] },
  ];

  if (!existsSync(INSPO)) {
    console.log('\n(corpus dir absent — real cases skipped)');
  } else if (!haveAtlas) {
    console.log('\n(atlas absent — corpus cases skipped)');
  } else {
    mkdirSync(DEBUG_DIR, { recursive: true });
    for (const cse of corpus) {
      const img = findImg(cse.id + '_');
      await section(`corpus ${cse.id}  (truth: ${cse.truth.map((t) => t[1]).join(' ')})`, async () => {
        if (!img) { skipped(`image ${cse.id} not found`); return; }
        const meta = await sharp(img).metadata();
        const res = await detectEmoji(img, cse.boxes, { atlas, keepUnknown: true });
        const foundCps = new Set(res.emoji.map((e) => e.codepoint));
        for (const e of res.emoji) {
          // debug crop
          const px = e.box;
          try {
            await sharp(img).extract({ left: px.x, top: px.y, width: px.w, height: px.h })
              .resize(96, 96, { fit: 'contain', background: '#fff' })
              .toFile(join(DEBUG_DIR, `${cse.id}_${e.codepoint}_${e.set}.png`));
          } catch {}
          console.log(`    → ${e.codepoint} "${e.char}"  set=${e.set}  conf=${e.confidence}  margin=${e.setMargin}`);
        }
        let hit = 0;
        for (const [cp, ch] of cse.truth) if (foundCps.has(cp)) hit++;
        console.log(`    recovered ${hit}/${cse.truth.length} ground-truth codepoints  (${meta.width}x${meta.height})`);
        ok(hit >= 1, `at least one ground-truth emoji recovered in ${cse.id}`);
      });
    }
    console.log(`\ndebug crops → ${DEBUG_DIR}`);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed, ${skip} skipped ===`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
