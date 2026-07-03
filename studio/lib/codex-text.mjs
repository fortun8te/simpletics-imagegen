// lib/codex-text.mjs — one-shot text completion through the codex CLI (ChatGPT-auth).
//
// The studio has no API key for a hosted LLM; what it DOES have is the user's codex CLI on
// their normal subscription (the same path refreshCodexUsage() already exercises). This wraps
// `codex exec --json` as a plain text-in/text-out call for the Plan + Design agents.
//
// Honesty rules: a codex turn spends the user's Codex quota like any other turn, so callers
// keep prompts short, call this at most a few times per agent run (step caps), and ALWAYS have
// a deterministic fallback — this function failing (no codex, timeout, rate-limit) must never
// fail the run. Returns { ok, text, error }.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_CLI = process.env.CODEX_CLI
  || (existsSync('/Applications/Codex.app/Contents/Resources/codex')
    ? '/Applications/Codex.app/Contents/Resources/codex'
    : 'codex');

/** Pull the agent's final message text out of codex `--json` JSONL output. The event shapes
 *  differ across codex versions, so scan tolerantly: last event that carries a plausible
 *  message-text field wins. Falls back to the raw tail when nothing parses. */
function extractText(out) {
  let text = null;
  for (const line of String(out).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    const candidates = [
      obj?.item?.text,                       // { item: { type:'agent_message', text } }
      obj?.msg?.message,                     // { msg: { type:'agent_message', message } }
      obj?.message?.content,
      typeof obj?.text === 'string' ? obj.text : null,
    ];
    const kind = obj?.item?.type || obj?.msg?.type || obj?.type || '';
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim() && /agent|assistant|message/i.test(String(kind))) {
        text = c;
      }
    }
  }
  return text;
}

export function codexText(prompt, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const args = [
      '-a', 'never',
      '-s', 'read-only',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ignore-rules',
      '-C', STUDIO_DIR,
      String(prompt),
    ];
    const child = spawn(CODEX_CLI, args, {
      cwd: STUDIO_DIR,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let done = false;
    const finish = (ok, error = null) => {
      if (done) return;
      done = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const text = extractText(out);
      resolve(text
        ? { ok: true, text: text.trim(), error: null }
        : { ok: false, text: null, error: error || 'no message in codex output' });
    };
    const t = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    const collect = (d) => {
      out += d.toString();
      if (out.length > 400_000) out = out.slice(-400_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => { clearTimeout(t); finish(false, String(e && e.message || e)); });
    child.on('close', () => { clearTimeout(t); finish(true); });
  });
}
