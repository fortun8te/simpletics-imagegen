#!/usr/bin/env node
// Self-resuming codex runner — "if it runs out, set a timer and run it again after that time."
// Runs codexbatch in RESUME mode (skips finished slots) for the given batches. If images remain
// because the codex usage limit was hit (HTTP 429 / "usage limit" / "too many requests"), it waits
// a cooldown and retries — repeating until every slot is generated or a cycle cap is reached. When
// everything is present it runs the friendly-name export. Fully self-contained: keeps going on its
// own timer even if nothing is watching.
//
//   node codex-runner.mjs                       # b1,b2 ; 60-min cooldown ; 12 cycles max
//   BATCHES=b1 COOLDOWN_MIN=90 MAX_CYCLES=8 node codex-runner.mjs
// Progress is appended to codex-runner.log.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(process.env.HOME, 'Downloads', 'static-factory-b1', 'renders');
const LOG = join(HERE, 'codex-runner.log');
const BATCHES = (process.env.BATCHES || 'b1,b2').split(',').map((s) => s.trim()).filter(Boolean);
const COOLDOWN_MIN = Math.max(1, Number(process.env.COOLDOWN_MIN) || 60);
const MAX_CYCLES = Math.max(1, Number(process.env.MAX_CYCLES) || 12);
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const nx = cfg.brands.find((b) => b.id === 'nanox');
const LIMIT_RE = /HTTP 429|usage limit|too many requests|rate.?limit|quota|insufficient|exceeded/i;

const part = (v) => String(v || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { appendFileSync(LOG, line + '\n'); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A "slot" is one concept (ad/variation, p1). Done = its base run-1.png exists.
function missingSlots() {
  let missing = 0, total = 0;
  for (const code of BATCHES) {
    const ba = nx.batches.find((b) => b.code === code);
    if (!ba) continue;
    for (const ad of ba.ads) {
      if (ad.kind !== 'product') continue;
      for (const v of ad.variations) {
        total++;
        const base = join(OUT, part(nx.id), part(code), 'ads', part(ad.id), part(v.id), 'p1', 'run-1.png');
        if (!existsSync(base)) missing++;
      }
    }
  }
  return { missing, total };
}

function run(cmdArgs, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', cmdArgs, { cwd: HERE, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, text: out + err }));
  });
}

(async () => {
  log(`runner start — batches ${BATCHES.join(',')}, cooldown ${COOLDOWN_MIN}m, max ${MAX_CYCLES} cycles`);
  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    const before = missingSlots();
    if (before.missing === 0) { log(`all ${before.total} slots present — nothing to generate.`); break; }
    log(`cycle ${cycle}/${MAX_CYCLES}: ${before.missing}/${before.total} slots missing — generating…`);
    let limited = false;
    for (const code of BATCHES) {
      const r = await run([join(HERE, 'codexbatch.mjs'), 'edu', '--brand=nanox', `--batch=${code}`], { RESUME: '1', VARIANTS: process.env.VARIANTS || '1' });
      if (LIMIT_RE.test(r.text)) limited = true;
    }
    const after = missingSlots();
    log(`cycle ${cycle} result: ${after.missing}/${after.total} still missing${limited ? ' (usage limit detected)' : ''}`);
    if (after.missing === 0) break;
    if (cycle < MAX_CYCLES) {
      const progressed = after.missing < before.missing;
      // Limit hit → wait the full cooldown ("after that time"). Transient errors with progress →
      // short retry. Stuck with no progress and no limit signal → also wait the cooldown.
      const waitMin = limited ? COOLDOWN_MIN : (progressed ? 2 : COOLDOWN_MIN);
      log(`waiting ${waitMin} min before retry…`);
      await sleep(waitMin * 60 * 1000);
    }
  }
  const fin = missingSlots();
  if (fin.missing === 0) {
    log('complete — running friendly-name export.');
    await run([join(HERE, 'codexexport.mjs')]);
  }
  log(`runner exit — ${fin.total - fin.missing}/${fin.total} generated, ${fin.missing} missing.`);
  process.exit(fin.missing ? 2 : 0);
})();
