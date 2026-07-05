// scripts/probe-vision-backends.mjs — does any OpenCode Zen FREE model actually accept an IMAGE?
//
// WHY: our copy-from-reference pipeline's hard bottleneck is VISION — it must LOOK at the ad and
// return a layout. OpenCode Zen's free tier (mimo-v2.5-free, deepseek-v4-flash-free,
// nemotron-3-ultra-free, north-mini-code-free, big-pickle) is documented as OpenAI-compatible but
// says NOTHING about vision, and they read like text/code models. Rather than guess, this probe
// sends ONE real image + a "read the headline" prompt to each and reports which genuinely see it.
// A vision model returns the actual on-image text; a text-only model errors or admits it can't.
//
// USAGE:
//   1. Get a key at https://opencode.ai/auth and put it in studio/.env as:  OPENCODE_ZEN_API_KEY=sk-...
//      (this script also accepts it inline:  OPENCODE_ZEN_API_KEY=sk-... node scripts/probe-vision-backends.mjs)
//   2. node scripts/probe-vision-backends.mjs  [imagePath]   (default: an ad from IMAGE AD INSPO)
//
// Zero-dep (node built-ins + macOS `sips` to shrink the test image). Never prints your key.

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');

// .env loader (zero-dep): OPENCODE_ZEN_API_KEY may live in studio/.env.
function loadEnvKey() {
  if (process.env.OPENCODE_ZEN_API_KEY) return process.env.OPENCODE_ZEN_API_KEY.trim();
  try {
    const env = readFileSync(join(STUDIO, '.env'), 'utf8');
    const m = env.match(/^\s*OPENCODE_ZEN_API_KEY\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  } catch { /* no .env */ }
  return '';
}

const BASE = process.env.OPENCODE_ZEN_BASE || 'https://opencode.ai/zen/v1';
// Free models per the Zen catalog (2026-07). Edit if the catalog changes; the /models call below
// also prints whatever the live endpoint currently advertises.
const FREE_MODELS = [
  'mimo-v2.5-free',
  'deepseek-v4-flash-free',
  'nemotron-3-ultra-free',
  'north-mini-code-free',
  'big-pickle',
];

function pickDefaultImage() {
  const cli = process.argv[2];
  if (cli && existsSync(cli)) return cli;
  const inspo = join(homedir(), 'Downloads', 'IMAGE AD INSPO');
  try {
    const f = readdirSync(inspo).find((n) => /^0?5?2_|^052/.test(n)) || readdirSync(inspo).find((n) => /\.(png|jpe?g|webp)$/i.test(n));
    if (f) return join(inspo, f);
  } catch { /* folder absent */ }
  return null;
}

// Shrink to ≤512px PNG via sips (keeps the request small + normalizes webp→png), return data URI.
function toDataUri(imgPath) {
  const tmp = join(STUDIO, '.state', `probe-${Date.now().toString(36)}.png`);
  execFileSync('sips', ['-Z', '512', '-s', 'format', 'png', imgPath, '--out', tmp], { stdio: 'ignore' });
  const b64 = readFileSync(tmp).toString('base64');
  try { execFileSync('rm', ['-f', tmp]); } catch { /* leave temp */ }
  return `data:image/png;base64,${b64}`;
}

async function probeModel(model, dataUri, key) {
  const payload = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Reply with ONLY the single largest headline text you can read in this image. If you cannot see any image, reply exactly: NO_IMAGE.' },
        { type: 'image_url', image_url: { url: dataUri } },
      ],
    }],
    max_tokens: 60,
    temperature: 0,
  };
  const t0 = Date.now();
  let res, bodyText;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    bodyText = await res.text();
  } catch (e) {
    return { model, verdict: 'NETWORK_ERROR', detail: String(e.message || e), ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  if (!res.ok) {
    // 400 mentioning image/content, or 404 model-not-found, etc. — capture the reason.
    let reason = bodyText.slice(0, 200);
    try { reason = JSON.parse(bodyText).error?.message || reason; } catch { /* raw */ }
    const visionRejected = /image|multimodal|content.*array|vision|not support/i.test(reason);
    return { model, verdict: visionRejected ? 'NO_VISION (rejected image)' : `HTTP_${res.status}`, detail: reason, ms };
  }
  let text = '';
  try { text = JSON.parse(bodyText).choices?.[0]?.message?.content || ''; } catch { text = bodyText.slice(0, 120); }
  text = String(text).trim();
  const sawImage = text && !/^NO_IMAGE/i.test(text) && !/can'?t see|cannot see|no image|unable to (view|see)/i.test(text);
  return { model, verdict: sawImage ? 'VISION OK ✅' : 'NO_VISION (said NO_IMAGE)', detail: text.slice(0, 100), ms };
}

async function main() {
  const key = loadEnvKey();
  if (!key) {
    console.error('✗ No OPENCODE_ZEN_API_KEY found.');
    console.error('  Get one at https://opencode.ai/auth, then add to studio/.env:');
    console.error('    OPENCODE_ZEN_API_KEY=sk-...');
    console.error('  (I never handle your key — you paste it into .env yourself.)');
    process.exit(2);
  }
  const imgPath = pickDefaultImage();
  if (!imgPath) { console.error('✗ No test image found — pass one: node scripts/probe-vision-backends.mjs <image>'); process.exit(2); }
  console.log(`Probe image: ${imgPath}`);
  console.log(`Endpoint:    ${BASE}`);

  // What does the live catalog actually advertise right now?
  try {
    const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (r.ok) {
      const j = await r.json();
      const ids = (j.data || j.models || []).map((m) => m.id || m).filter(Boolean);
      const free = ids.filter((id) => /free|pickle/i.test(id));
      console.log(`Live free models advertised: ${free.join(', ') || '(none matched /free/)'}`);
    }
  } catch { /* non-fatal */ }

  const dataUri = toDataUri(imgPath);
  console.log(`\nProbing ${FREE_MODELS.length} free models with a real image…\n`);
  const results = [];
  for (const m of FREE_MODELS) {
    const r = await probeModel(m, dataUri, key);
    results.push(r);
    console.log(`  ${r.verdict.padEnd(26)} ${m.padEnd(24)} ${r.ms}ms  ${JSON.stringify(r.detail).slice(0, 80)}`);
  }
  const winners = results.filter((r) => /VISION OK/.test(r.verdict));
  console.log(`\n${winners.length ? '✅ VISION-CAPABLE FREE MODEL(S): ' + winners.map((w) => w.model).join(', ') : '❌ No free OpenCode model accepted the image — extraction must stay on local ornith. (These free models can still power the TEXT reasoning passes.)'}`);
  const out = join(STUDIO, '.state', 'vision-probe-result.json');
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), image: imgPath, results }, null, 2));
  console.log(`\nFull result → ${out}`);
}

main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
