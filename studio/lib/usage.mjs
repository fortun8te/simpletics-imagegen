// lib/usage.mjs — best-effort codex usage/quota probe + windowed budget (backend-owned).
//
// The codex path (ChatGPT-auth, driven through the bridge / gen.mjs) does NOT expose a reliable
// "remaining quota" number anywhere we can read: ~/.codex/auth.json carries the account + plan but
// no usage counter, and the only quota signal codex ever surfaces is a `RATE_LIMIT:` error when the
// window is exhausted. So this module never fabricates a remaining number — but it DOES compute an
// honest WINDOWED usage estimate (used5h / used7d) by merging two local activity sources it can
// actually see: the system-wide chatgpt-unlimited usage log and this app's own completed jobs.
//
// Inputs that feed it:
//   1. sessionGenerated — jobs this process has completed (a real, honest "work done" signal). The
//      server bumps this via `noteGenerated()` whenever a job finishes, passing the finishedAt time.
//   2. a recent RATE_LIMIT note — the worker hands us the latest rate-limit hit (with the cooldown's
//      resumeAt) via `noteRateLimit()`. While that cooldown is live we report a `cooling` window.
//   3. lastAuthFailureAt — a dead-auth signal set by noteAuthFailure() (from gen.mjs failure
//      classification) and CLEARED on any successful generation, so blockers.auth is robust even
//      after failed job records auto-clear.
//   4. ~/.config/chatgpt-unlimited/usage.json — system-wide generation timestamps (other tools too).
//
// Settings ({ graceSeconds, budget }) persist in studio/.state/settings.json (owned here).
// Results are cached for ~30s so /api/state and /api/health don't re-read files on every poll.
// Zero external deps: node:* only.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const CACHE_MS = 30_000;
const AUTH_PATH = join(process.env.HOME || '', '.codex', 'auth.json');
const STUDIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_CLI = process.env.CODEX_CLI
  || (existsSync('/Applications/Codex.app/Contents/Resources/codex')
    ? '/Applications/Codex.app/Contents/Resources/codex'
    : 'codex');
// Codex records the REAL rate-limit snapshot (primary=5h, secondary=weekly; used_percent + resets_at)
// into its session rollout files as an `event_msg` with `payload.rate_limits`. We read the newest one
// — the same source codex's own /usage + statusline read. It's as fresh as codex's last recorded turn.
const CODEX_SESSIONS_DIRS = [
  join(process.env.HOME || '', '.codex', 'sessions'),
  join(process.env.HOME || '', '.codex', 'archived_sessions'),
];
const RATE_LIMITS_CACHE_MS = 60_000;
let rateLimitsCache = { at: 0, value: null };
// System-wide generation log written by the chatgpt-unlimited tooling (shared across apps).
const SYSTEM_USAGE_PATH = join(process.env.HOME || '', '.config', 'chatgpt-unlimited', 'usage.json');
// Settings (grace window + budget caps) persist next to the job state, in studio/.state/settings.json.
const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.state');
const SETTINGS_PATH = join(STATE_DIR, 'settings.json');

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_BLOCK_MS = 5 * 60 * 1000;   // a dead-auth signal blocks for 5 minutes, then re-probes
const DEFAULT_GRACE_SECONDS = 10;

// --- mutable session signals (set by the server/worker, read by getCodexUsage) -------------------
let sessionGenerated = 0;        // count of jobs this process has completed
let lastRateLimit = null;        // { at:number, resumeAt:number|null } — most recent RATE_LIMIT hit
let lastAuthFailureAt = 0;       // epoch ms of the most recent auth-classified failure (0 = never)
// Timestamps (epoch ms) of generations this app completed this process. Merged with the system log
// and deduped to compute used5h / used7d. Persisted implicitly via job records; this is the live
// in-memory view (survives only the process, which is fine — the system log covers the rest).
const localFinishes = [];        // finishedAt times this process observed via noteGenerated()

// --- settings ({ graceSeconds, budget }) ----------------------------------------------------------
function loadSettings() {
  let raw = {};
  try { raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) || {}; } catch { raw = {}; }
  const graceEnv = process.env.GRACE_SECONDS;
  let graceSeconds = Number.isFinite(Number(raw.graceSeconds)) ? Number(raw.graceSeconds) : DEFAULT_GRACE_SECONDS;
  if (graceEnv != null && graceEnv !== '' && Number.isFinite(Number(graceEnv))) graceSeconds = Number(graceEnv);
  if (!Number.isFinite(graceSeconds) || graceSeconds < 0) graceSeconds = DEFAULT_GRACE_SECONDS;
  const b = raw.budget || {};
  const cap = (v) => (typeof v === 'number' && v >= 0 ? Math.floor(v) : null);
  return { graceSeconds, budget: { maxPer5h: cap(b.maxPer5h), maxPer7d: cap(b.maxPer7d) } };
}

let settings = loadSettings();

function persistSettings() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch { /* ignore — best effort */ }
}

/** Current settings snapshot ({ graceSeconds, budget:{maxPer5h,maxPer7d} }). */
export function getSettings() {
  return { graceSeconds: settings.graceSeconds, budget: { ...settings.budget } };
}

/** Grace window (seconds) for the Waiting phase. Env GRACE_SECONDS overrides persisted value. */
export function getGraceSeconds() {
  // Re-honor a live env override without a restart, but let a persisted value win when no env is set.
  const graceEnv = process.env.GRACE_SECONDS;
  if (graceEnv != null && graceEnv !== '' && Number.isFinite(Number(graceEnv))) {
    const n = Number(graceEnv);
    if (n >= 0) return n;
  }
  return settings.graceSeconds;
}

/** Merge a settings patch ({ graceSeconds?, budget?:{maxPer5h?,maxPer7d?} }) and persist. */
export function updateSettings(patch = {}) {
  const next = getSettings();
  if (patch.graceSeconds != null && Number.isFinite(Number(patch.graceSeconds)) && Number(patch.graceSeconds) >= 0) {
    next.graceSeconds = Math.floor(Number(patch.graceSeconds));
  }
  if (patch.budget && typeof patch.budget === 'object') {
    const cap = (v) => (v == null ? null : (typeof v === 'number' && v >= 0 ? Math.floor(v) : null));
    if ('maxPer5h' in patch.budget) next.budget.maxPer5h = cap(patch.budget.maxPer5h);
    if ('maxPer7d' in patch.budget) next.budget.maxPer7d = cap(patch.budget.maxPer7d);
  }
  settings = next;
  persistSettings();
  cache = null; // budget affects usage/blocker readouts
  return getSettings();
}

// --- daily cap (1.5× fair daily share of the weekly window) --------------------------------------
// "If we had 100 credits weekly we'd only be able to spend ~21/day" — the cap is 1.5 × (100/7)
// ≈ 21.4 percentage POINTS of the weekly window per local day, measured against codex's own
// weekly-remaining snapshot (readCodexRateLimits). When the cap is hit the worker holds spawns
// (same mechanism as budget/pause) until the user explicitly Continues — each Continue grants
// +10 more points, then the banner asks again at the next +10.
//
// Measurement is honest best-effort: the weekly% snapshot only refreshes when codex records a
// turn, so spentToday can lag a little behind live spend. If codex has never recorded a weekly
// snapshot we can't measure at all — the cap simply doesn't block (measurable:false).
// State persists in .state/daily-cap.json: { day, baselineWeeklyLeft, bonusPts }. A new local
// day re-baselines and clears the bonus; the weekly window resetting mid-day (remaining jumps
// UP) also re-baselines so a reset never counts as negative spend.
const DAILY_CAP_PATH = join(STATE_DIR, 'daily-cap.json');
const DAILY_CAP_PTS = 150 / 7;   // 1.5 × (100 / 7) ≈ 21.4 pts of the weekly window per day
const BONUS_STEP_PTS = 10;

function localDay(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let dailyCapState = (() => {
  try {
    const raw = JSON.parse(readFileSync(DAILY_CAP_PATH, 'utf8'));
    if (raw && raw.day) return { day: raw.day, baselineWeeklyLeft: raw.baselineWeeklyLeft ?? null, bonusPts: Number(raw.bonusPts) || 0 };
  } catch { /* fresh state */ }
  return { day: null, baselineWeeklyLeft: null, bonusPts: 0 };
})();

function persistDailyCapState() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(DAILY_CAP_PATH, JSON.stringify(dailyCapState, null, 2), 'utf8');
  } catch { /* best effort */ }
}

const round1 = (n) => Math.round(n * 10) / 10;

/** Today's daily-cap readout: { measurable, blocked, spentToday, capPts, bonusPts, allowedPts,
 *  weeklyLeft, asOf }. Points are percentage points of the WEEKLY codex window. */
export function getDailyCap() {
  const snap = readCodexRateLimits();
  const weeklyLeft = snap && Number.isFinite(snap.weeklyLeft) ? snap.weeklyLeft : null;
  const bonusPts = Number(dailyCapState.bonusPts) || 0;
  if (weeklyLeft == null) {
    return {
      measurable: false, blocked: false, spentToday: 0,
      capPts: round1(DAILY_CAP_PTS), bonusPts, allowedPts: round1(DAILY_CAP_PTS + bonusPts),
      weeklyLeft: null, asOf: null,
    };
  }
  const today = localDay();
  if (dailyCapState.day !== today) {
    dailyCapState = { day: today, baselineWeeklyLeft: weeklyLeft, bonusPts: 0 };
    persistDailyCapState();
  } else if (dailyCapState.baselineWeeklyLeft == null || weeklyLeft > dailyCapState.baselineWeeklyLeft) {
    // First reading of the day, or the weekly window reset mid-day (remaining jumped up).
    dailyCapState.baselineWeeklyLeft = weeklyLeft;
    persistDailyCapState();
  }
  const spentToday = Math.max(0, dailyCapState.baselineWeeklyLeft - weeklyLeft);
  const allowedPts = DAILY_CAP_PTS + (Number(dailyCapState.bonusPts) || 0);
  return {
    measurable: true,
    blocked: spentToday >= allowedPts,
    spentToday: round1(spentToday),
    capPts: round1(DAILY_CAP_PTS),
    bonusPts: Number(dailyCapState.bonusPts) || 0,
    allowedPts: round1(allowedPts),
    weeklyLeft,
    asOf: snap.asOf ?? null,
  };
}

/** Worker gate — true when today's spend is at/over the cap (+granted bonus). */
export function isDailyCapReached() {
  return getDailyCap().blocked;
}

/** User hit Continue on the daily-cap banner: allow BONUS_STEP_PTS more of the weekly window
 *  today, then the cap asks again. Returns the fresh readout. */
export function grantDailyBonus(pts = BONUS_STEP_PTS) {
  getDailyCap(); // ensure today's baseline exists before bumping the bonus
  dailyCapState.bonusPts = (Number(dailyCapState.bonusPts) || 0) + (Number(pts) > 0 ? Number(pts) : BONUS_STEP_PTS);
  persistDailyCapState();
  cache = null; // blockers readout changes immediately
  return getDailyCap();
}

// --- cache ---------------------------------------------------------------------------------------
let cache = null;                // { value:CodexUsage, at:number }

/**
 * Record a completed generation (one image). Called by the server on each job 'done'. `finishedAt`
 * (epoch ms) lets us fold this generation into the windowed used5h/used7d estimate; defaults to now.
 * A successful generation also proves auth is alive, so it clears any dead-auth signal.
 */
export function noteGenerated(n = 1, finishedAt = Date.now()) {
  const count = Number(n) || 0;
  sessionGenerated += count;
  for (let i = 0; i < count; i++) localFinishes.push(Number(finishedAt) || Date.now());
  // Bound the in-memory list to a week so it can't grow without limit across a long-lived process.
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  while (localFinishes.length && localFinishes[0] < cutoff) localFinishes.shift();
  lastAuthFailureAt = 0; // a real success means the refresh token is working again
  cache = null;          // invalidate so the next read reflects the new count
}

/** Record a codex RATE_LIMIT hit so usage can report a 'rate-limited' state during the cooldown. */
export function noteRateLimit({ resumeAt = null } = {}) {
  lastRateLimit = { at: Date.now(), resumeAt: resumeAt == null ? null : Number(resumeAt) };
  cache = null;
}

/** Clear the in-memory rate-limit note after a successful live quota check. */
export function clearRateLimit() {
  lastRateLimit = null;
  cache = null;
}

/**
 * Probe Codex for a fresh quota reading and decide if generation can resume.
 * Returns { ok, reason?, usage?, error? } — ok:true only when the probe succeeded and quota looks available.
 */
export async function verifyCodexQuota() {
  const r = await refreshCodexUsage();
  if (!r.ok) {
    return { ok: false, reason: 'probe_failed', error: r.error || 'Codex check failed', usage: r.usage };
  }
  const usage = r.usage;
  const now = Date.now();
  const rl = lastRateLimit;
  if (rl && rl.resumeAt != null && rl.resumeAt > now) {
    return { ok: false, reason: 'still_cooling', resetAt: rl.resumeAt, usage };
  }
  const fiveh = usage?.codex?.fivehLeft;
  if (fiveh != null && fiveh <= 0) {
    return { ok: false, reason: 'still_limited', usage };
  }
  clearRateLimit();
  return { ok: true, usage };
}

/** Record an auth-classified failure (dead refresh token). Sets lastAuthFailureAt to now. */
export function noteAuthFailure() {
  lastAuthFailureAt = Date.now();
  cache = null;
}

/** True while a recent auth failure is still within the block window (5 min). */
export function isAuthBlocked() {
  return lastAuthFailureAt > 0 && (Date.now() - lastAuthFailureAt) < AUTH_BLOCK_MS;
}

/** The honest session-work signal (images generated this process). */
export function getSessionGenerated() {
  return sessionGenerated;
}

// Read the codex account/plan from ~/.codex/auth.json (best-effort). Returns { email, plan } or {}.
// We decode the id_token's middle (JWT payload) only to label the meter — no quota number lives here.
function readAccount() {
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
    const token = auth && auth.tokens && auth.tokens.id_token;
    if (!token || typeof token !== 'string') return {};
    const seg = token.split('.')[1];
    if (!seg) return {};
    const payload = JSON.parse(Buffer.from(seg, 'base64').toString('utf8'));
    const claims = payload['https://api.openai.com/auth'] || {};
    return {
      email: payload.email || null,
      plan: claims.chatgpt_plan_type || null,
    };
  } catch {
    return {}; // missing / unreadable / not a JWT — fine, we just won't have a label
  }
}

// Read generation timestamps (epoch ms) from the system-wide chatgpt-unlimited usage log. The file
// format isn't guaranteed, so we probe the common shapes and coerce anything date-like to epoch ms:
//   - an array of numbers / ISO strings
//   - an array of objects with a timestamp-ish field (at / ts / time / finishedAt / createdAt / date)
//   - an object with an `entries`/`events`/`generations` array of the above
// Anything we can't parse is silently skipped — this is a best-effort merge source.
function readSystemUsageTimestamps() {
  let raw;
  try { raw = JSON.parse(readFileSync(SYSTEM_USAGE_PATH, 'utf8')); } catch { return []; }
  const out = [];
  const toMs = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000; // seconds → ms heuristic
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? t : null;
  };
  const pushFrom = (item) => {
    if (item == null) return;
    if (typeof item === 'number' || typeof item === 'string') { const ms = toMs(item); if (ms) out.push(ms); return; }
    if (typeof item === 'object') {
      const v = item.at ?? item.ts ?? item.time ?? item.finishedAt ?? item.createdAt ?? item.date ?? item.timestamp;
      const ms = toMs(v);
      if (ms) out.push(ms);
    }
  };
  const arr = Array.isArray(raw) ? raw
    : Array.isArray(raw && raw.entries) ? raw.entries
    : Array.isArray(raw && raw.events) ? raw.events
    : Array.isArray(raw && raw.generations) ? raw.generations
    : [];
  for (const item of arr) pushFrom(item);
  return out;
}

// Merge system + local timestamps, dedupe (same-ms collisions), and count those within a window.
function countWindows() {
  const now = Date.now();
  const merged = new Set();
  for (const t of readSystemUsageTimestamps()) if (Number.isFinite(t)) merged.add(t);
  for (const t of localFinishes) if (Number.isFinite(t)) merged.add(t);
  let used5h = 0, used7d = 0;
  for (const t of merged) {
    if (now - t <= SEVEN_DAYS_MS) used7d++;
    if (now - t <= FIVE_HOURS_MS) used5h++;
  }
  return { used5h, used7d };
}

export function parseCodexRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const win = (name, minutes) => {
    const w = rateLimits[name];
    if (!w || Number(w.window_minutes) !== minutes) return null;
    const used = Number(w.used_percent);
    const resetsAt = Number(w.resets_at);
    if (!Number.isFinite(used) || !Number.isFinite(resetsAt)) return null;
    return {
      left: Math.max(0, Math.min(100, Math.round(100 - used))),
      resetsAt: Math.floor(resetsAt) * 1000,
    };
  };
  const primary = win('primary', 300);
  const secondary = win('secondary', 10080);
  if (!primary && !secondary) return null;
  return {
    fivehLeft: primary ? primary.left : null,
    fivehResetsAt: primary ? primary.resetsAt : null,
    weeklyLeft: secondary ? secondary.left : null,
    weeklyResetsAt: secondary ? secondary.resetsAt : null,
  };
}

/**
 * Window-aware budget gate. Returns true if a self-imposed cap is currently at/over its window count.
 * Used by the worker to hold new spawns (same mechanism as pause). `null` caps never block.
 */
export function isLimitReached() {
  const { maxPer5h, maxPer7d } = settings.budget;
  if (maxPer5h == null && maxPer7d == null) return false;
  const { used5h, used7d } = countWindows();
  return (maxPer5h != null && used5h >= maxPer5h) || (maxPer7d != null && used7d >= maxPer7d);
}

/**
 * Best-effort codex usage, windowed. Cached ~30s.
 *
 * @returns {import('../src/types').CodexUsage}
 *   `known:true` (we have real local counts now). `plan` from the JWT, `authOk` false when a recent
 *   auth failure is still live, `used5h`/`used7d` the merged+deduped windowed counts, `cap5h`/`cap7d`
 *   the budget caps, `cooling` the active rate-limit window (or null), `label` a short human summary.
 */
// Walk the codex session dirs, newest file first, and return the freshest rate_limits snapshot as
// { fivehLeft, fivehResetsAt, weeklyLeft, weeklyResetsAt, asOf } (percents 0..100 REMAINING; resets
// in epoch ms). Null if codex hasn't recorded one. Cached ~60s (file scan is cheap but not free).
function readCodexRateLimits({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - rateLimitsCache.at < RATE_LIMITS_CACHE_MS) return rateLimitsCache.value;
  let value = null;
  try {
    const files = [];
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && e.name.endsWith('.jsonl')) {
          try { files.push({ p, mtime: statSync(p).mtimeMs }); } catch {}
        }
      }
    };
    for (const d of CODEX_SESSIONS_DIRS) walk(d);
    files.sort((a, b) => b.mtime - a.mtime);
    for (const { p, mtime } of files.slice(0, 40)) {
      let text;
      try { text = readFileSync(p, 'utf8'); } catch { continue; }
      if (!text.includes('used_percent')) continue;
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line || !line.includes('used_percent')) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const parsed = parseCodexRateLimits(obj && obj.payload && obj.payload.rate_limits);
        if (!parsed) continue;
        value = {
          ...parsed,
          asOf: Number.isFinite(Date.parse(obj.timestamp)) ? Date.parse(obj.timestamp) : mtime,
        };
        break;
      }
      if (value) break;
    }
  } catch { value = null; }
  rateLimitsCache = { at: now, value };
  return value;
}

export function getCodexUsage({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_MS) return cache.value;

  // Is a rate-limit cooldown still in effect? (resumeAt in the future, or hit within the last hour.)
  const rl = lastRateLimit;
  const cooling = !!rl && (
    (rl.resumeAt != null && rl.resumeAt > now) ||
    (rl.resumeAt == null && now - rl.at < 60 * 60 * 1000)
  );

  const account = readAccount();
  const { used5h, used7d } = countWindows();
  const { maxPer5h, maxPer7d } = settings.budget;

  let label;
  if (cooling) label = 'rate-limited';
  else label = `${used5h} in last 5h`;

  const value = {
    known: true,
    plan: account.plan ? capitalize(account.plan) : null,
    authOk: !isAuthBlocked(),
    used5h,
    used7d,
    cap5h: maxPer5h,
    cap7d: maxPer7d,
    sessionGenerated,
    cooling: (cooling && rl.resumeAt != null) ? { resetAt: rl.resumeAt } : (cooling ? { resetAt: rl.at + 60 * 60 * 1000 } : null),
    label,
    // Real codex rate-limit snapshot (5h + weekly % remaining), or null if codex hasn't recorded one.
    codex: readCodexRateLimits({ force }),
  };

  cache = { value, at: now };
  return value;
}

export function refreshCodexUsage() {
  return new Promise((resolve) => {
    const args = [
      '-a', 'never',
      '-s', 'read-only',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ignore-rules',
      '-C', STUDIO_DIR,
      'Do not run tools. Reply exactly: OK',
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
      try { child.kill('SIGTERM'); } catch {}
      cache = null;
      rateLimitsCache = { at: 0, value: null };
      const usage = getCodexUsage({ force: true });
      resolve({ ok, usage, error, output: out.slice(-600) });
    };
    const t = setTimeout(() => finish(false, 'timeout'), 25_000);
    const collect = (d) => {
      out += d.toString();
      if (out.length > 4_000) out = out.slice(-4_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => {
      clearTimeout(t);
      finish(false, String(e && e.message || e));
    });
    child.on('close', (code) => {
      clearTimeout(t);
      finish(code === 0, code === 0 ? null : `codex exited ${code}`);
    });
  });
}

/**
 * The blockers object surfaced in /api/health and /api/state. `auth` is driven by the module-level
 * lastAuthFailureAt (robust after failed records auto-clear); `cooling` mirrors a live rate-limit
 * window; `budget` is true when a self-imposed cap is currently blocking new spawns.
 */
export function getBlockers() {
  const usage = getCodexUsage();
  const daily = getDailyCap();
  return {
    auth: isAuthBlocked(),
    cooling: usage.cooling,
    budget: isLimitReached(),
    // Full readout only while it's actually blocking — the banner needs the numbers.
    dailyCap: daily.blocked ? daily : null,
  };
}

function capitalize(s) {
  s = String(s || '');
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
