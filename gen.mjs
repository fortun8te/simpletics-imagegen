#!/usr/bin/env node
// Agentic single-shot driver for ImageGen.
//
// Drives ONE generation (1..10 variations) through the user's real ChatGPT tab via the bridge +
// extension, with an arbitrary prompt and arbitrary local reference images. No config.json, no
// brand/batch wiring: this is the clean entrypoint for one-off agentic image jobs. Built to be the
// single bulletproof entrypoint for an agent driving this system: it can check readiness, validate
// a job without generating, enqueue, and report structured results plus a per-job run manifest.
//
//   node gen.mjs --prompt "..." --out ~/Downloads/dir/NN-slug.png [--refs /abs/a.png,/abs/b.png]
//                [--variants 4] [--aspect 4:5] [--name NAME] [--project "Project Name"]
//                [--port 8787] [--no-wait]
//
// Flags:
//   --prompt "..."        the image prompt (required for a single job)
//   --out path            where to save; must live under ~/Downloads (required for a single job)
//   --refs a.png,b.png    comma-separated local ref images, order preserved (=> @img1, @img2, ...)
//   --variants N          1..10 variations (default 1)
//   --aspect ratio        one of 16:9 9:16 4:5 5:4 4:3 3:4 1:1 auto ('auto' or omitted = no aspect)
//   --name NAME           job name (default: basename of --out)
//   --project "..."       label shown in status/Telegram
//   --jobs file.json      enqueue a JSON array of { prompt, out, refs?, variants?, aspect?, name? }
//                         together in one batch (multiple distinct prompts in one agentic run)
//   --health              GET /health, print a readiness report + a JSON line, then exit (no enqueue)
//   --dry-run             validate the job(s) AND readiness without enqueuing; print READY/NOT READY
//   --status              print the current bridge queue (human-readable) and exit
//   --abort               POST /command {type:'abort'} to clear the queue + stop the tabs, then exit
//   --port N              bridge port (default 8787)
//   --no-wait             enqueue and return immediately instead of polling to completion
//
// Exit codes:
//   0  success (job(s) done, --health/--dry-run ready, --status/--abort/--no-wait ok)
//   1  usage error, or the bridge is unreachable
//   2  timed out waiting for a job to settle
//   3  a job failed (settled with status 'error')
//   4  not ready (--health or --dry-run readiness check failed)
//
// Result JSON (printed on --wait, one object per job; single job is unwrapped at top level):
//   { name, status, files:[abs paths], chatUrl, aspect, variants, error, errorCode }
//   status     'done' | 'error'
//   files      absolute paths of variation files that exist on disk
//   chatUrl    ChatGPT conversation URL if the bridge surfaced one, else null
//   error      the bridge error string if status is 'error', else null
//   errorCode  classified error: NOT_LOGGED_IN | REFUSED | RATE_LIMITED | TIMEOUT | NO_IMAGE |
//              UPLOAD_FAILED | DOWNLOAD_FAILED | UNKNOWN  (null when status is 'done')
//
// Run manifest (written per job after it settles, at <outdir>/<name>.manifest.json):
//   { name, prompt, aspect, variants, refs:[abs ref paths], files:[abs output paths that exist],
//     chatUrl, status, error, errorCode, startedAt, finishedAt }  (timestamps are ISO strings)
//
// Refs are sent to the bridge as PATHS ([{path}]) so the enqueue payload stays small; the bridge
// reads them from disk. Files are validated to exist locally before sending.
//
// The extension opens its OWN background ChatGPT tab (it never hijacks your foreground tab),
// attaches the refs in order, generates, and saves every variation. --out must live under
// ~/Downloads so all variations land together (variant 1 is written by the bridge, the rest by
// Chrome's downloader, which is rooted at ~/Downloads).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, extname, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';

const HOME = process.env.HOME;
const DOWNLOADS = resolve(HOME, 'Downloads');

const flags = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
  else { flags[a.slice(2)] = next; i++; }
}

const PORT = Number(flags.port || 8787);
const wait = flags.wait !== false && flags['no-wait'] === undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ASPECTS = ['16:9', '9:16', '4:5', '5:4', '4:3', '3:4', '1:1', 'auto'];
// Validate an aspect. 'auto' or omitted => no aspect (null). Anything else must be in the list.
function normAspect(a) {
  if (a === undefined || a === null || a === '' || a === 'auto') return null;
  if (!ASPECTS.includes(a)) { console.error(`[gen] --aspect must be one of ${ASPECTS.join(' ')}. Got: ${a}`); process.exit(1); }
  return a;
}

const expand = (p) => (p.startsWith('~') ? resolve(HOME, p.slice(1).replace(/^[/\\]/, '')) : resolve(p));
const toPosix = (p) => p.split(sep).join('/');

const post = async (path, payload) => {
  const r = await fetch(`http://localhost:${PORT}${path}`, { method: 'POST', body: JSON.stringify(payload) });
  return r.json();
};
const get = async (path) => (await fetch(`http://localhost:${PORT}${path}`)).json();

// Classify a bridge error string into a stable code. Order matters: most specific phrases first.
// Lowercase the string, then match common phrases. Unknown strings fall through to UNKNOWN.
function classify(errStr) {
  const s = String(errStr || '').toLowerCase();
  if (!s) return 'UNKNOWN';
  if (s.includes('not logged in') || s.includes('logged out') || s.includes('sign in') || s.includes('signed out')) return 'NOT_LOGGED_IN';
  if (s.includes('upload')) return 'UPLOAD_FAILED';
  if (s.includes('download')) return 'DOWNLOAD_FAILED';
  if (s.includes('limit') || s.includes('rate') || s.includes('too many')) return 'RATE_LIMITED';
  if (s.includes('refus')) return 'REFUSED';
  if (s.includes('no image')) return 'NO_IMAGE';
  if (s.includes('timeout') || s.includes('timed out')) return 'TIMEOUT';
  return 'UNKNOWN';
}

// GET /health. Returns { reachable, health } where health is the parsed body (or null). Never throws.
async function fetchHealth() {
  try { return { reachable: true, health: await get('/health') }; }
  catch (e) { return { reachable: false, health: null, error: String(e && e.message || e) }; }
}

// Build one bridge job from { prompt, out, refs?, variants?, aspect?, name?, project? }. Computes
// per-variant relative paths and sends refs as PATHS so the enqueue payload stays small. Exits on
// a bad --out (outside ~/Downloads), a missing ref file, or a bad aspect.
function buildJob(spec) {
  const prompt = spec.prompt;
  const outRaw = spec.out;
  if (!prompt || !outRaw) { console.error('[gen] each job needs a prompt and an out path.'); process.exit(1); }
  const variants = Math.max(1, Math.min(10, Number(spec.variants) || 1));
  const project = spec.project || null;
  const aspect = normAspect(spec.aspect);

  const outAbs = expand(outRaw);
  const rel = relative(DOWNLOADS, outAbs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    console.error(`[gen] out must be inside ~/Downloads so every variation lands together. Got: ${outAbs}`);
    process.exit(1);
  }
  const name = spec.name || basename(outAbs, extname(outAbs));

  // Build per-variant relative paths (relative to ~/Downloads). One variant => the path as-is.
  const ext = extname(outAbs) || '.png';
  const relBase = rel.slice(0, rel.length - extname(rel).length);
  const variantPaths = variants === 1
    ? [toPosix(rel)]
    : Array.from({ length: variants }, (_, i) => toPosix(`${relBase}-v${i + 1}${ext}`));
  const relativePath = variantPaths[0];

  // Refs as paths (order preserved => @img1, @img2, ...). Validate each file exists locally; the
  // bridge reads them from disk so we avoid shipping huge base64 in the enqueue payload.
  const refSpec = Array.isArray(spec.refs) ? spec.refs : (spec.refs ? String(spec.refs).split(',') : []);
  const refPaths = refSpec.map((p) => expand(String(p).trim())).filter(Boolean);
  const refs = [];
  for (const p of refPaths) {
    if (!existsSync(p)) { console.error(`[gen] reference not found: ${p}`); process.exit(1); }
    refs.push({ path: p, name: basename(p) });
  }

  return { name, prompt, refs, project, relativePath, variants, variantPaths, aspect };
}

// --health: GET /health, print a readable readiness report + a JSON line, then exit. Exit 0 if
// ready (bridge && extensionConnected && loggedIn), 4 if reachable but not ready, 1 if unreachable.
if (flags.health) {
  const { reachable, health, error } = await fetchHealth();
  if (!reachable) {
    console.error(`[gen] bridge not reachable on :${PORT} (${error || 'unknown'}). Is bridge.mjs running?`);
    console.log(JSON.stringify({ ready: false, reachable: false, error: error || 'unreachable' }));
    process.exit(1);
  }
  const h = health || {};
  const bridge = !!(h.bridge ?? h.ok);
  const extensionConnected = !!h.extensionConnected;
  const loggedIn = !!h.loggedIn;
  const ready = bridge && extensionConnected && loggedIn;
  const mark = (b) => (b ? 'OK ' : 'XX ');
  const lines = [`ImageGen readiness on :${PORT}: ${ready ? 'READY' : 'NOT READY'}`];
  lines.push(`  ${mark(bridge)} bridge up`);
  lines.push(`  ${mark(extensionConnected)} extension connected`);
  lines.push(`  ${mark(loggedIn)} logged in to ChatGPT`);
  if (h.queue !== undefined) lines.push(`  -- queue: ${typeof h.queue === 'object' ? JSON.stringify(h.queue) : h.queue}`);
  console.error(lines.join('\n'));
  console.log(JSON.stringify({ ready, reachable: true, bridge, extensionConnected, loggedIn, queue: h.queue ?? null }));
  process.exit(ready ? 0 : 4);
}

// --status: print the live queue and exit.
if (flags.status) {
  const s = await get('/status').catch((e) => ({ error: String(e.message || e) }));
  if (!s || s.error) { console.error(`[gen] bridge not reachable on :${PORT} (${s && s.error || 'unknown'}). Is bridge.mjs running?`); process.exit(1); }
  const lines = [`ImageGen: ${s.done}/${s.total} done, ${s.pending} waiting, ${s.running} running, ${s.error} failed, ${s.skipped} skipped${s.paused ? ', paused' : ''}.`];
  if (s.current) lines.push(`Now: ${s.current}`);
  for (const j of s.jobs || []) lines.push(`  ${j.status.padEnd(8)} ${j.name}${j.path ? ' -> ' + j.path : ''}${j.error ? ' (' + j.error + ')' : ''}`);
  console.log(lines.join('\n'));
  process.exit(0);
}

// --abort: clear the queue and signal the extension to stop its tabs, then exit.
if (flags.abort) {
  const r = await post('/command', { type: 'abort' }).catch((e) => ({ ok: false, error: String(e.message || e) }));
  if (!r || r.error) { console.error(`[gen] bridge not reachable on :${PORT} (${r && r.error || 'unknown'}). Is bridge.mjs running?`); process.exit(1); }
  console.log(r.message || 'Aborted.');
  process.exit(0);
}

// Assemble the job list: --jobs file.json (a batch of distinct prompts) or a single --prompt/--out.
let specs;
if (flags.jobs) {
  const jobsFile = expand(String(flags.jobs));
  if (!existsSync(jobsFile)) { console.error(`[gen] --jobs file not found: ${jobsFile}`); process.exit(1); }
  let parsed;
  try { parsed = JSON.parse(readFileSync(jobsFile, 'utf8')); } catch (e) { console.error(`[gen] --jobs is not valid JSON: ${e.message || e}`); process.exit(1); }
  if (!Array.isArray(parsed) || !parsed.length) { console.error('[gen] --jobs must be a non-empty JSON array of { prompt, out, ... }.'); process.exit(1); }
  specs = parsed;
} else {
  if (!flags.prompt || !flags.out) {
    console.error('usage: node gen.mjs --prompt "..." --out ~/Downloads/dir/NN-slug.png [--refs a.png,b.png] [--variants N] [--aspect 4:5] [--name NAME] [--project "..."]  |  --jobs file.json  |  --health  |  --dry-run  |  --status  |  --abort');
    process.exit(1);
  }
  specs = [{ prompt: flags.prompt, out: flags.out, refs: flags.refs, variants: flags.variants, aspect: flags.aspect, name: flags.name, project: flags.project }];
}

// Validate one spec WITHOUT exiting (used by --dry-run). Returns { name, checks:[{ ok, label }] }.
// Mirrors buildJob's checks: prompt non-empty, out under ~/Downloads, aspect in the allowed set,
// every ref exists locally. Never enqueues, never calls process.exit.
function validateSpec(spec, idx) {
  const checks = [];
  const promptOk = !!(spec.prompt && String(spec.prompt).trim());
  checks.push({ ok: promptOk, label: 'prompt non-empty' });

  let name = spec.name || `job${idx + 1}`;
  const outRaw = spec.out;
  if (!outRaw) {
    checks.push({ ok: false, label: 'out path given' });
  } else {
    const outAbs = expand(String(outRaw));
    const rel = relative(DOWNLOADS, outAbs);
    const outOk = !(rel.startsWith('..') || isAbsolute(rel));
    checks.push({ ok: outOk, label: `out under ~/Downloads (${outAbs})` });
    if (!spec.name) name = basename(outAbs, extname(outAbs));
  }

  if (spec.aspect !== undefined && spec.aspect !== null && spec.aspect !== '' && spec.aspect !== 'auto') {
    checks.push({ ok: ASPECTS.includes(spec.aspect), label: `aspect in set (${spec.aspect})` });
  }

  const refSpec = Array.isArray(spec.refs) ? spec.refs : (spec.refs ? String(spec.refs).split(',') : []);
  for (const raw of refSpec) {
    const p = expand(String(raw).trim());
    checks.push({ ok: existsSync(p), label: `ref exists (${p})` });
  }
  return { name, checks };
}

// --dry-run: validate every job spec AND bridge readiness, print READY/NOT READY, then exit.
// NEVER enqueues. Exit 0 if fully ready, 4 if not ready, 1 if the bridge is unreachable.
if (flags['dry-run']) {
  const specReports = specs.map((s, i) => validateSpec(s, i));
  const specsOk = specReports.every((r) => r.checks.every((c) => c.ok));

  const { reachable, health, error } = await fetchHealth();
  const h = health || {};
  const bridge = !!(h.bridge ?? h.ok);
  const extensionConnected = !!h.extensionConnected;
  const loggedIn = !!h.loggedIn;
  const readyHealth = reachable && bridge && extensionConnected && loggedIn;
  const ready = specsOk && readyHealth;

  const mark = (b) => (b ? 'OK ' : 'XX ');
  const lines = [`Dry run on :${PORT}: ${ready ? 'READY' : 'NOT READY'}`];
  for (const r of specReports) {
    lines.push(`  job "${r.name}":`);
    for (const c of r.checks) lines.push(`    ${mark(c.ok)} ${c.label}`);
  }
  lines.push('  readiness:');
  if (!reachable) {
    lines.push(`    XX  bridge reachable (${error || 'unreachable'})`);
  } else {
    lines.push(`    ${mark(bridge)} bridge up`);
    lines.push(`    ${mark(extensionConnected)} extension connected`);
    lines.push(`    ${mark(loggedIn)} logged in to ChatGPT`);
  }
  console.error(lines.join('\n'));
  console.log(JSON.stringify({
    ready, specsOk, reachable,
    bridge, extensionConnected, loggedIn,
    jobs: specReports.map((r) => ({ name: r.name, ok: r.checks.every((c) => c.ok), checks: r.checks })),
  }));
  if (!reachable) process.exit(1);
  process.exit(ready ? 0 : 4);
}

const builtJobs = specs.map(buildJob);

const startedAt = new Date().toISOString();
const enq = await post('/enqueue', { jobs: builtJobs, out: DOWNLOADS }).catch((e) => ({ ok: false, error: String(e.message || e) }));
if (!enq.ok) { console.error(`[gen] bridge not reachable on :${PORT} (${enq.error || 'unknown'}). Is bridge.mjs running?`); process.exit(1); }
for (const j of builtJobs) console.error(`[gen] enqueued "${j.name}" x${j.variants}  refs=${j.refs.length}${j.aspect ? '  aspect=' + j.aspect : ''}  -> ~/Downloads/${j.variantPaths.join('  ')}`);

if (!wait) process.exit(0);

// Poll until every enqueued job settles, then wait briefly for all variation files to hit disk.
const names = new Set(builtJobs.map((j) => j.name));
const DEADLINE = Date.now() + 6 * 60 * 1000;
let lastStatus = null;
const settledByName = new Map();
while (Date.now() < DEADLINE && settledByName.size < names.size) {
  await sleep(3000);
  const s = await get('/status').catch(() => null);
  if (!s) continue;
  lastStatus = s;
  for (const mine of (s.jobs || [])) {
    if (names.has(mine.name) && (mine.status === 'done' || mine.status === 'error')) settledByName.set(mine.name, mine);
  }
}
if (settledByName.size < names.size) { console.error('[gen] timed out waiting for the job(s) to settle.'); process.exit(2); }

// A chat/conversation URL is included per job only if the bridge surfaces one (status.reported or
// the settled job carry it); never block on a URL that may not exist.
const urlForName = (name) => {
  const r = (lastStatus && lastStatus.reported) ? lastStatus.reported.find((x) => x.name === name) : null;
  const settled = settledByName.get(name) || {};
  return settled.chatUrl || settled.conversationUrl || (r && (r.chatUrl || r.conversationUrl || r.url)) || null;
};

// All settled; give Chrome a moment to flush the extra variation files, then build the structured
// result + write a run manifest next to each job's outputs. Manifest is written whether the job
// succeeded or failed so an agent always has a record on disk.
const finishedAt = new Date().toISOString();
const fileDeadline = Date.now() + 30000;
const results = [];
let anyFailed = false;
for (const j of builtJobs) {
  const settled = settledByName.get(j.name) || {};
  const status = settled.status === 'error' ? 'error' : 'done';
  const abs = j.variantPaths.map((p) => resolve(DOWNLOADS, p));
  if (status === 'done') { while (Date.now() < fileDeadline && !abs.every((p) => existsSync(p))) await sleep(1000); }
  const got = abs.filter((p) => existsSync(p));
  const chatUrl = urlForName(j.name);
  const error = status === 'error' ? (settled.error || 'unknown error') : null;
  const errorCode = status === 'error' ? classify(error) : null;
  if (status === 'error') anyFailed = true;

  const entry = { name: j.name, status, files: got, chatUrl, aspect: j.aspect || null, variants: j.variants, error, errorCode };
  results.push(entry);

  // Write <outdir>/<name>.manifest.json next to the outputs.
  const outAbs = resolve(DOWNLOADS, j.variantPaths[0]);
  const manifestPath = join(dirname(outAbs), `${j.name}.manifest.json`);
  const manifest = {
    name: j.name,
    prompt: j.prompt,
    aspect: j.aspect || null,
    variants: j.variants,
    refs: j.refs.map((r) => r.path),
    files: got,
    chatUrl,
    status,
    error,
    errorCode,
    startedAt,
    finishedAt,
  };
  try { writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)); }
  catch (e) { console.error(`[gen] could not write manifest ${manifestPath}: ${e.message || e}`); }
}

console.log(JSON.stringify(builtJobs.length === 1 ? results[0] : { jobs: results }, null, 2));
if (anyFailed) {
  const failed = results.filter((r) => r.status === 'error');
  console.error(`[gen] FAILED: ${failed.map((r) => `${r.name}: ${r.error} [${r.errorCode}]`).join('; ')}`);
  process.exit(3);
}
