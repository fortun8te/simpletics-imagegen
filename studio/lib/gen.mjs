// lib/gen.mjs — single-slot codex generation.
//
// Factored from the PROVEN codexbatch.mjs `generate()` core: it spawns the chatgpt-imagegen
// python tool against the codex backend (a headless POST to chatgpt.com that bills the separate
// Codex-usage bucket), writing into the SAME local renders tree the extension uses. Never
// overwrites — every write routes through logic.js's `versionedRelPath` (run-N.png ->
// run-N-v2.png -> ...), so "regenerate" always adds a new version and an earlier image is never
// replaced. Zero external deps: node:* + createRequire only.
//
// --status output format (for the bridge / status endpoint): when gen.mjs reports job state,
// each entry includes `queuedAt`, `startedAt` (when pulled off "pending" by a /next call), and
// `position` — the 1-based index in the queue at report time. A job with position=1 is about to
// be served next; higher numbers are waiting behind it. The bridge recomputes positions from the
// pending Map on every /status query, so queuedAt/startedAt are stable timestamps while position
// moves as jobs get claimed by /next.
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// Sanitize one path segment the same way codexbatch/logic do: collapse any run of non
// [a-zA-Z0-9_-] characters to a single '-'. Keeps the renders tree filesystem-safe.
const part = (value) => String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');

// Codex usage-limit / HTTP 429 surface text. When the tool's error matches this, the returned
// error is PREFIXED with 'RATE_LIMIT: ' so the worker can cool down and retry later.
const RATE_LIMIT_RE = /HTTP 429|usage limit|too many requests|rate.?limit|quota|exceeded/i;

/**
 * Generate one image slot through the codex backend.
 *
 * @param {{brand,batch,ad,variation,prompt,run,promptText,size,ref}} job
 * @param {{renders:string, repoDir:string}} ctx
 * @returns {Promise<{ok:boolean, relPath?:string, error?:string}>}
 */
export async function generateSlot(job, { renders, repoDir }) {
  // Reuse logic.js's never-overwrite path versioning (single source of truth, shared with the
  // extension and codexbatch). Resolve it relative to the repo dir the server injects.
  const require = createRequire(import.meta.url);
  const { versionedRelPath } = require(join(repoDir, 'logic.js'));

  // The chatgpt-imagegen CLI. Override with CHATGPT_IMAGEGEN if it lives elsewhere.
  const TOOL = process.env.CHATGPT_IMAGEGEN
    || join(process.env.HOME, 'Downloads', 'chatgpt-unlimited', 'tools', 'chatgpt-imagegen.py');

  // Some Python builds (e.g. homebrew python) ship with NO CA bundle, so the codex backend's HTTPS
  // call to chatgpt.com fails with CERTIFICATE_VERIFY_FAILED. Point the child at a real CA bundle:
  // an explicit SSL_CERT_FILE if set, else the macOS system bundle. Harmless if python already
  // has certs. Override with SSL_CERT_FILE=/path if your machine differs.
  const CA_BUNDLE = process.env.SSL_CERT_FILE || (existsSync('/etc/ssl/cert.pem') ? '/etc/ssl/cert.pem' : null);

  // Build the base relative path from the job coords (each segment sanitized), then version it so
  // we NEVER overwrite an existing render.
  const baseRel = `${part(job.brand)}/${part(job.batch)}/ads/${part(job.ad)}/${part(job.variation)}/${part(job.prompt)}/run-${part(job.run)}.png`;
  const finalRel = versionedRelPath(baseRel, (rel) => existsSync(join(renders, rel)));
  const out = join(renders, finalRel);

  if (!existsSync(TOOL)) {
    return { ok: false, error: `chatgpt-imagegen tool not found at ${TOOL} (set CHATGPT_IMAGEGEN)` };
  }

  const size = /^\d+x\d+$/.test(String(job.size || '')) ? job.size : '1024x1024';

  return new Promise((resolve) => {
    mkdirSync(dirname(out), { recursive: true });
    const args = [TOOL, job.promptText, '-o', out, '--backend', 'codex', '--size', size];
    if (job.ref) args.push('-i', job.ref);
    // Codex on LOW reasoning: just execute the prompt, don't think (faster, less metered spend).
    // Overridable via CHATGPT_IMAGEGEN_EFFORT / _VERBOSITY.
    const env = {
      ...process.env,
      CHATGPT_IMAGEGEN_EFFORT: process.env.CHATGPT_IMAGEGEN_EFFORT || 'low',
      CHATGPT_IMAGEGEN_VERBOSITY: process.env.CHATGPT_IMAGEGEN_VERBOSITY || 'low',
      ...(CA_BUNDLE ? { SSL_CERT_FILE: CA_BUNDLE, REQUESTS_CA_BUNDLE: CA_BUNDLE } : {}),
    };
    const child = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let err = '', sout = '';
    child.stdout.on('data', (d) => { sout += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      if (code === 0 && existsSync(out)) {
        resolve({ ok: true, relPath: finalRel });
        return;
      }
      // Capture BOTH streams: the codex usage-limit / HTTP 429 notice can surface on stdout, so
      // include stdout in the error text the rate-limit detector greps.
      let error = (err + '\n' + sout).trim().split('\n').slice(-4).join(' | ') || `exit ${code}`;
      if (RATE_LIMIT_RE.test(error)) error = `RATE_LIMIT: ${error}`;
      resolve({ ok: false, error });
    });
    child.on('error', (e) => {
      let error = String(e.message || e);
      if (RATE_LIMIT_RE.test(error)) error = `RATE_LIMIT: ${error}`;
      resolve({ ok: false, error });
    });
  });
}
