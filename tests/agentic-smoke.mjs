#!/usr/bin/env node
// Non-generating smoke test for the ImageGen agentic plumbing.
// Proves the bridge is up, the extension is connected and logged in, and a dry-run validates,
// WITHOUT enqueuing or generating any image. Exits non-zero if any check fails.
//
//   node tests/agentic-smoke.mjs
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = Number(process.env.PORT || 8787);
const HOME = process.env.HOME;

let failed = 0;
const line = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// 1. Health: bridge reachable, extension polling, ChatGPT logged in.
let health = null;
try {
  const r = await fetch(`http://localhost:${PORT}/health`);
  health = await r.json();
} catch (e) {
  line(false, 'bridge reachable', String(e.message || e));
}
if (health) {
  line(true, 'bridge reachable');
  line(!!health.extensionConnected, 'extension connected (polling /next)');
  line(!!health.loggedIn, 'ChatGPT logged in');
}

// 2. Dry-run a harmless sample. This validates refs + readiness and NEVER generates.
let ref = null;
try { ref = readdirSync(join(ROOT, 'assets')).find((f) => f.endsWith('.png')) || null; } catch {}
const out = join(HOME, 'Downloads', 'simpletics-lifestyle', '_smoke', 'test.png');
const args = ['gen.mjs', '--dry-run', '--prompt', 'smoke test prompt', '--out', out];
if (ref) args.push('--refs', join(ROOT, 'assets', ref));
const dry = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' });
const dryReady = dry.status === 0;
line(dryReady, 'gen.mjs --dry-run READY', dryReady ? '' : `(exit ${dry.status})`);
if (!dryReady && dry.stderr) console.log(dry.stderr.trim().split('\n').slice(-6).join('\n'));

console.log(failed ? `\nSMOKE FAILED: ${failed} check(s) failed.` : `\nSMOKE PASS: plumbing healthy.`);
process.exit(failed ? 1 : 0);
