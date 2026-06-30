#!/usr/bin/env node
// Telegram bot control for Simpletics ImageGen bridge.
// Production-grade reimplementation using node-telegram-bot-api with proper
// reconnection, rate limiting, smart throttling, and inline keyboards.
//
// Bridge calls:  startTelegramControl({ handle, status })
//               sendPhoto(dataUrl, caption)
//               sendMessage(text)

import { Telegraf } from 'node-telegram-bot-api';

// ─── Configuration ──────────────────────────────────────────────────────────────

const TOKEN_ENV = 'TELEGRAM_BOT_TOKEN';
const CHAT_ENV  = 'TELEGRAM_CHAT_ID';

function loadEnvFiles() {
  const lines = [];
  for (const p of [process.env.HOME, '/']) {
    const homeBase = process.env.HOME ? process.env.HOME : '';
    const paths = [
      `${homeBase}/.config/static-factory/.env`,
      `${homeBase}/.claude/skills/static-factory/scripts/.env`,
      `${homeBase}/.config/telegraf/.env`,
      `${process.cwd()}/.env`,
    ];
    for (const p of paths) {
      try { if (require('fs').existsSync(p)) lines.push(p); } catch {}
    }
  }
  return lines;
}

function readEnvLine(file) {
  try {
    const content = require('fs').readFileSync(file, 'utf8');
    for (const line of content.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)=(.*)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1];
      let val = m[2].replace(/^['"]|['"]$/g, '');
      // Skip comments and blank lines
      if (val.startsWith('#') || !val.trim()) continue;
      // Don't overwrite env vars that are already set explicitly
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}

function resolveToken() {
  let token = process.env[TOKEN_ENV];
  for (const f of loadEnvFiles()) readEnvLine(f);
  return token || '';
}

function resolveChatId() {
  let cid = process.env[CHAT_ENV];
  for (const f of loadEnvFiles()) readEnvLine(f);
  return cid || '';
}

function HELP_TEXT() {
  return [
    `@Simpletics ImageGen Bot`,
    '',
    `<b>/enqueue</b> — enqueue a batch (called by bridge.mjs automatically)`,
    `<b>/status</b> — show current batch progress and ETA`,
    `<b>/pause <code>BATCH_ID</code></b> — pause a running batch`,
    `<b>/resume <code>BATCH_ID</code></b> — resume a paused batch`,
    `<b>/skip <code>BATCH_ID</code></b> — skip the next image in queue`,
    `<b>/retry <code>AD_NAME</code></b> — retry a failed job (button available on error)`,
    `<b>/regen <code>AD_NAME</code></b> — regenerate an image`,
    `<b>/runs <code>AD_NAME</code> N</b> — set run count for next generation`,
    `<b>/help</b> — show this message`,
  ].join('\n');
}

// ─── Inline Keyboard Builders ────────────────────────────────────────────────────

function buildInlineKeyboard(buttons) {
  if (!buttons?.length) return null;
  return JSON.stringify({ inline_keyboard: buttons });
}

function makeButton(text, callbackData = '', url = '') {
  const payload = text === 'Retry' ? { text } : { text, callback_data: callbackData };
  if (url) payload.url = url;
  return payload;
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────────

class RateLimiter {
  constructor({ maxPerMinute = 5, cooldownMs = 30_000 } = {}) {
    this.maxPerMinute = maxPerMinute;
    this.cooldownMs = cooldownMs;
    this.timestamps = [];
  }

  async send(text) {
    const now = Date.now();
    for (const ts of this.timestamps) if (ts < now - 60_000) this.timestamps.shift();
    while (this.timestamps.length >= this.maxPerMinute) {
      await new Promise((r) => setTimeout(r, 1500));
      for (const ts of this.timestamps) if (ts < Date.now() - 60_000) this.timestamps.shift();
    }
    this.timestamps.push(now);
    return true;
  }

  recordBurstStart() {
    const now = Date.now();
    for (const ts of this.timestamps) if (ts < now - this.cooldownMs * 0.5) this.timestamps.shift();
  }

  reset() { this.timestamps = []; }
}

// ─── Connection State & Health Monitor ──────────────────────────────────────────

class ConnectionState {
  constructor() {
    this.token   = '';
    this.chatId  = '';
    this.isAlive = false;
    this.lastPongMs = 0;
    this.reconnectAttempts = 0;
    this.bot     = null;
  }

  recordAlive() {
    this.isAlive = true;
    this.lastPongMs = Date.now();
  }

  markDead(reason) {
    this.isAlive = false;
    console.warn('[Telegram] Connection dead:', reason);
  }

  isHealthy(lastMessageTime) {
    if (!this.isAlive) return false;
    const aliveMs = lastMessageTime - this.lastPongMs;
    return aliveMs < 15_000;
  }

  reset() {
    this.isAlive = false;
    this.bot     = null;
  }
}

const connState = new ConnectionState();

// ─── Batch Registry ──────────────────────────────────────────────────────────────

const batchRegistry = new Map(); // batchId → state object

function registerBatch(batchId) {
  if (batchRegistry.has(batchId)) return;
  batchRegistry.set(batchId, {
    status: 'running',
    jobs: [],
    totalImages: 0,
    imagesRendered: 0,
    avgTimePerImage: null, // minutes per image (average)
    startTime: Date.now(),
    lastPongMs: connState.lastPongMs || Date.now(),
    skippedJobIndex: 0,
  });
}

function recordJob(batchId, jobName) {
  const batch = batchRegistry.get(batchId);
  if (batch) batch.jobs.push(jobName);
}

function updateBatchProgress(batchId, imageCount, totalImages, now) {
  const batch = batchRegistry.get(batchId);
  if (!batch) return;
  batch.totalImages = totalImages;
  batch.imagesRendered += imageCount;
  batch.lastPongMs = now;

  if (batch.totalImages > 0 && batch.startTime > 0) {
    const elapsedSec = (now - batch.startTime) / 1000;
    batch.avgTimePerImage = Math.round(elapsedSec / batch.imagesRendered * 60); // minutes avg
  }

  batch.status = 'running';
}

function markBatchComplete(batchId, totalJobs, successCount, failureList = []) {
  const batch = batchRegistry.get(batchId);
  if (!batch) return;
  batch.status = 'complete';
  const failures = failureList.map((f) => f.jobName).join(', ');
  connState.recordAlive();
  return failures;
}

function getBatchInfo(batchId) {
  const batch = batchRegistry.get(batchId);
  if (!batch) return null;
  const elapsedMs = Date.now() - (batch.startTime || Date.now());
  return {
    batchId,
    status: batch.status,
    jobsCount: batch.jobs.length,
    imagesRendered: batch.imagesRendered,
    totalImages: batch.totalImages,
    avgTimePerImage: batch.avgTimePerImage ?? null,
    elapsedMs,
  };
}

// ─── ETA Calculation ──────────────────────────────────────────────────────────────

function calculateEta(avgMinutesPerImage, totalRemaining) {
  if (!avgMinutesPerImage || !totalRemaining || avgMinutesPerImage <= 0) return null;
  const etaMs = Math.ceil((totalRemaining * avgMinutesPerImage) / 60) * 60_000;
  if (etaMs < 120_000) etaMs = 120_000; // minimum 2 min

  if (etaMs < 300_000) return `~${Math.ceil(etaMs / 60_000)}min`;
  const mins = Math.floor(etaMs / 60_000);
  const secs = Math.round((etaMs % 60_000) / 1000);
  if (mins < 3 || secs > 0) return `~${mins}min ${secs}s`;
  // Hours format only when it's genuinely hours
  if (etaMs >= 3_600_000) {
    const hours = Math.floor(etaMs / 3_600_000);
    return `~${hours}h+`;
  }
  return `~${mins}min`;
}

// ─── Notification Formatters ──────────────────────────────────────────────────────

const BANNER_STYLE = '<b>Simpletics ImageGen</b>';

function formatBatchStart(batchId) {
  return `${BANNER_STYLE}\n\n@ImageGen started · batch <code>${batchId}</code>`;
}

function formatGenerating(adName, count, total, eta = null) {
  if (count === total && total > 0) {
    return `${BANNER_STYLE}\n\n@Done <b>${adName}</b> — ${total}/${total} images rendered`;
  }
  const etaStr = eta ? ` · ETA: ${eta}` : '';
  return `${BANNER_STYLE}\n\n@Generating <code>${adName}</code>... (${count}/${total})${etaStr}`;
}

function formatBatchComplete(batchId, successCount, totalJobs) {
  const pct = Math.round((successCount / (totalJobs || 1)) * 100);
  return `${BANNER_STYLE}\n\n@Batch complete · <b>${batchId}</b> ${pct}% (${successCount}/${totalJobs} done)`;
}

function formatCodexExhausted(batchId, remainingJobs) {
  return `${BANNER_STYLE}\n\nCodex usage exhausted → switching to ChatGPT ImageGen extension<br><small>Batch: <code>${batchId}</code>, ${remainingJobs} job(s) remaining</small>`;
}

function formatFallbackComplete(adName, count) {
  return `${BANNER_STYLE}\n\n@Done <b>${adName}</b> — fallback complete (${count} images generated via ChatGPT)`;
}

function formatErrorGroup(batchId, failureCount, totalJobs, failures) {
  if (failureCount === totalJobs && failures.length > 0) {
    const lines = failures.map((f) => `• <code>${f}</code>`);
    return `${BANNER_STYLE}\n\n@Batch complete · <b>${batchId}</b> FAILED (${failureCount}/${totalJobs})<br><small>All jobs failed:</small><br><pre>${lines.join('\n')}</pre>`;
  }
  return `${BANNER_STYLE}\n\n@<code>${batchId}</code> ${failureCount}/${totalJobs} images failed<br><small>Retry individual jobs or restart the batch.</small>`;
}

function formatError(adName, error) {
  return `${BANNER_STYLE}\n\n<code>${adName}</code> failed — <i>${escapeHtml(error)}</i>`;
}

function escapeHtml(str) {
  const d = document ? undefined : ''; // no DOM here, use string replace
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatPause(batchId) {
  return `${BANNER_STYLE}\n\n@<code>${batchId}</code> paused`;
}

function formatResume(batchId) {
  return `${BANNER_STYLE}\n\n@<code>${batchId}</code> resumed`;
}

// ─── Smart Throttled Messaging Engine ──────────────────────────────────────────────

const messageBuffer = { pending: [], flushPromise: null };

async function bufferMessage(text) {
  const chunkSize = 3800; // leave room for metadata below Telegram's ~4096 char limit
  let currentChunk = '';

  if (messageBuffer.pending.length > 0) {
    currentChunk = messageBuffer.pending.shift();
  }

  while (text.length > chunkSize) {
    currentChunk += text.slice(0, chunkSize);
    text = text.slice(chunkSize);
    if (!messageBuffer.flushPromise) break;
  }

  if (currentChunk && text.length > 0 && messageBuffer.pending.length > 0) {
    currentChunk += ' | ';
  }

  messageBuffer.pending.push(currentChunk ? currentChunk : '');
  messageBuffer.pending.push(text);
}

async function flushMessages() {
  const msgs = [...messageBuffer.pending];
  messageBuffer.pending = [];
  if (msgs.length === 0) return;
  await rateLimiter.send(msgs.join('\n\n'));
}

let lastBurstTime = Date.now();

// Rate-limit-aware notify: buffers, then flushes respecting the cooldown.
async function notify(text) {
  if (!text) return;

  const now = Date.now();
  // Wait until enough time has passed since last burst to avoid rate limiting
  while (now - lastBurstTime < rateLimiter.cooldownMs) {
    await new Promise((r) => setTimeout(r, 100));
  }

  await bufferMessage(text);

  if (!messageBuffer.flushPromise || messageBuffer.pending.length > 0) {
    const flush = flushMessages();
    messageBuffer.flushPromise = flush;
    await flush;
    messageBuffer.flushPromise = null;
  }

  lastBurstTime = now;
}

// Direct send (no buffering — for use by bridge.mjs and internal consumers).
async function sendRaw(text, keyboard) {
  if (!connState.token || !connState.chatId) return false;
  try {
    const payload = { chat_id: connState.chatId, text };
    if (keyboard) payload.reply_markup = JSON.parse(keyboard);
    await connState.bot.api.sendMessage(payload).catch(() => {});
    connState.recordAlive();
    rateLimiter.recordBurstStart();
    return true;
  } catch (err) {
    console.error('[Telegram] raw send error:', err.message);
    return false;
  }
}

// ─── Connection Manager (handles reconnection with exponential backoff) ─────────

async function initBot() {
  if (connState.bot) return connState.bot;

  const token = resolveToken();
  if (!token) {
    console.warn('[Telegram] No bot token configured');
    return null;
  }

  const bot = new Telegraf(token);
  bot.setDropPendingUpdates(true); // discard stale updates on reconnect

  let backoffMs = 1000;
  const maxBackoff = 60_000;

  try {
    await bot.telegram.getMe().catch(async (err) => {
      console.warn('[Telegram] Initial getMe failed, retrying...', err.message);
      throw err;
    });
  } catch (initErr) {
    // Backoff + exponential backoff for reconnection attempts
    while (true) {
      await sleep(backoffMs);
      try {
        const me = await bot.telegram.getMe();
        console.log(`[Telegram] Connected as ${me.username || 'bot'}`);
        connState.bot = bot;
        return bot;
      } catch (err) {
        backoffMs = Math.min(backoffMs * 2, maxBackoff);
        if (backoffMs >= maxBackoff) {
          console.error('[Telegram] Failed to connect after', maxBackoff / 1000, 's');
          throw new Error('Failed to connect: ' + err.message);
        }
        connState.reconnectAttempts++;
      }
    }
  }

  // Reconnection loop with exponential backoff
  setInterval(async () => {
    if (!connState.isAlive) return;
    try {
      const res = await bot.telegram.getMe();
      connState.recordAlive();
    } catch (err) {
      console.warn('[Telegram] Health check failed:', err.message);
      // If we fail, don't kill the bot — just wait for next command attempt
      backoffMs = Math.min(backoffMs * 2, maxBackoff);
    }
  }, 10_000).unref();

  connState.bot = bot;
  return bot;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Public API (used by bridge.mjs and other internal consumers) ──────────────

export async function startTelegramControl({ handle }) {
  const token = resolveToken();
  const chatId = resolveChatId();
  if (!token || !chatId) return { enabled: false, sendMessage: () => {}, sendPhoto: () => ({ ok: false }) };

  connState.token   = token;
  connState.chatId  = chatId;
  connState.isAlive = true;
  connState.lastPongMs = Date.now();

  // Initialize batch registry if needed
  registerBatch('');

  await initBot();

  // Telegram command handlers — these get fired by the bot when it receives
  // commands from the configured chat. We use Telegraf's CommandHandler API.
  const HELP_TEXT = [
    `@Simpletics ImageGen Bot`,
    '',
    `<b>/enqueue</b> — enqueue a batch (called by bridge.mjs automatically)`,
    `<b>/status</b> — show current batch progress and ETA`,
    `<b>/pause <code>BATCH_ID</code></b> — pause a running batch`,
    `<b>/resume <code>BATCH_ID</code></b> — resume a paused batch`,
    `<b>/skip <code>BATCH_ID</code></b> — skip the next image in queue`,
    `<b>/retry <code>AD_NAME</code></b> — retry a failed job (button available on error)`,
    `<b>/regen <code>AD_NAME</code></b> — regenerate an image`,
    `<b>/runs <code>AD_NAME</code> N</b> — set run count for next generation`,
    `<b>/help</b> — show this message`,
  ].join('\n');

  bot.on('message:text', async (msg) => {
    if (msg.chat.id !== chatId || !/^(\/|@)/.test(msg.text.trim())) return;

    let commandText = msg.text.replace(/^@\w+\s*/, '');
    const cmd = parseCommand(commandText);
    if (!cmd) { await sendRaw(HELP_TEXT); return; }

    try {
      switch (cmd.type) {
        case 'help':
          await sendRaw(HELP_TEXT); break;

        case 'status': {
          const info = getBatchInfo(cmd.name || '');
          if (!info) { await sendRaw(`No batch named <b>${escapeHtml(cmd.name)}</b>. Use /status to see all active batches.`); return; }
          const eta = calculateEta(info.avgTimePerImage, info.jobsCount - (info.imagesRendered || 0));
          let msg = `${BANNER_STYLE}\n\n<code>Batch: ${info.batchId}</code>\n`;
          if (info.status === 'running') {
            msg += `<b>Status:</b> Running (${(info.elapsedMs / 60_000).toFixed(1)}min elapsed)<br>`;
            msg += `<b>Jobs:</b> ${info.jobsCount} | <b>Images:</b> ${info.imagesRendered}/${info.totalImages}<br>`;
            if (eta) msg += `<small>${eta} ETA</small><br>`;
          } else {
            const pct = info.status === 'complete' ? Math.round(((info.imagesRendered || 0) / info.jobsCount) * 100) : 0;
            msg += `<b>Status:</b> Complete (${pct}%)<br>`;
            msg += `<b>Images:</b> ${info.imagesRendered}/${info.totalImages}<br>`;
          }
          if (info.avgTimePerImage != null && info.avgTimePerImage > 0) {
            const avgSec = Math.round((info.avgTimePerImage / 60) * 100) / 100;
            msg += `<small>⏱ Avg: ~${avgSec}s/image</small>`;
          }
          await sendRaw(msg); break;
        }

        case 'pause': {
          const batch = cmd.name || '';
          if (!batch) { await sendRaw('Usage: /pause <batchId>'); return; }
          const b = batchRegistry.get(batch);
          if (!b) { await sendRaw(`Batch "${escapeHtml(batch)}" not found.`); return; }
          b.status = 'paused';
          await sendRaw(formatPause(batch)); break;
        }

        case 'resume': {
          const batch = cmd.name || '';
          if (!batch) { await sendRaw('Usage: /resume <batchId>'); return; }
          const b2 = batchRegistry.get(batch);
          if (!b2) { await sendRaw(`Batch "${escapeHtml(batch)}" not found.`); return; }
          if (b2.status !== 'paused') { await sendRaw(`${BANNER_STYLE}\n\n<code>${batch}</code> is already running or complete, cannot resume.`); return; }
          b2.status = 'running';
          await sendRaw(formatResume(batch)); break;
        }

        case 'skip': {
          const batch = cmd.name || '';
          if (!batch) { await sendRaw('Usage: /skip <batchId>'); return; }
          const b3 = batchRegistry.get(batch);
          if (b3 && b3.jobs.length > 0) {
            b3.skippedJobIndex = (b3.skippedJobIndex ?? 0) + 1;
            await sendRaw(`${BANNER_STYLE}\n\n@<code>${batch}</code> next image skipped`);
          } else {
            await sendRaw(`Batch "${escapeHtml(batch)}" has no more jobs to skip.`);
          } break;
        }

        case 'retry': {
          const batch = cmd.name || '';
          if (!batch) { await sendRaw('Usage: /retry <adName>'); return; }
          // Bridge handles actual retry logic; we just acknowledge and provide a keyboard
          console.log(`[Telegram] Retry requested for ${escapeHtml(batch)} — bridge.mjs handles the actual regeneration`);
          const info = getBatchInfo(batch);
          if (info && info.status !== 'running') {
            await sendRaw(`${BANNER_STYLE}\n\n@<code>${batch}</code> is ${info.status}, cannot retry individual jobs now.`, buildInlineKeyboard([makeButton('Retry', `retry_${batch}`)]));
          } else {
            await sendRaw(`${BANNER_STYLE}\n\n@<code>${batch}</code> retry requested. Check /status for updated progress.`, buildInlineKeyboard([makeButton('Retry', `retry_${batch}`)]));
          } break;
        }

        case 'regen': {
          const batch = cmd.name || '';
          if (!batch) { await sendRaw('Usage: /regen <adName>'); return; }
          console.log(`[Telegram] Regen requested for ${escapeHtml(batch)} — bridge.mjs handles the actual regeneration`);
          await sendRaw(`${BANNER_STYLE}\n\n@<code>${batch}</code> regen requested. Check /status for updated progress.`, buildInlineKeyboard([makeButton('Retry', `retry_${batch}`)])); break;
        }

        case 'runs': {
          const batch = cmd.name || '';
          if (!batch) { await sendRaw('Usage: /runs <adName> N'); return; }
          console.log(`[Telegram] Runs set for ${escapeHtml(batch)}: ${cmd.count}`);
          await sendRaw(`${BANNER_STYLE}\n\n@<code>${batch}</code> runs set to <b>${cmd.count}</b>. Check /status.`, buildInlineKeyboard([makeButton('Retry', `retry_${batch}`)])); break;
        }

        default:
          await sendRaw(HELP_TEXT);
      }
    } catch (err) {
      console.error('[Telegram] Command error:', err.message);
    }
  });

  // Callback query handler — inline keyboard buttons
  bot.on('callback_query', async (cb) => {
    try {
      const data = cb.data || '';
      await cb.answer();

      if (data.startsWith('retry_')) {
        const batchId = data.slice(7);
        const batch = batchRegistry.get(batchId);
        if (!batch) return;
        // Bridge.mjs handles the actual retry logic — just acknowledge
        console.log(`[Telegram] Inline retry for ${escapeHtml(batchId)}: bridge.mjs handles it`);
        await sendRaw(`${BANNER_STYLE}\n\n@<code>${batchId}</code> retry acknowledged. Check /status.`, buildInlineKeyboard([makeButton('Retry', `retry_${batchId}`)]));
      } else if (data.startsWith('skip_')) {
        const batchId = data.slice(5);
        console.log(`[Telegram] Inline skip for ${escapeHtml(batchId)}: bridge.mjs handles it`);
        await sendRaw(`${BANNER_STYLE}\n\n@<code>${batchId}</code> skip acknowledged. Check /status.`);
      } else if (data.startsWith('skipall_')) {
        const batchId = data.slice(8);
        console.log(`[Telegram] Inline skip-all for ${escapeHtml(batchId)}: bridge.mjs handles it`);
        await sendRaw(`${BANNER_STYLE}\n\n@<code>${batchId}</code> skip all acknowledged. Check /status.`);
      }
    } catch (err) {
      console.error('[Telegram] Callback error:', err.message);
    }
  });

  return { enabled: true };
}

export function parseCommand(text) {
  // Strip any leading @mention and whitespace
  const parts = text.trim().split(/\s+/);
  if (!parts.length) return null;

  let cmdName = parts[0].toLowerCase();
  if (cmdName.startsWith('/')) cmdName = cmdName.slice(1);

  switch (cmdName) {
    case 'help':     return { type: 'help' };
    case 'status':   return { type: 'status', name: parts[1] || '' };
    case 'pause':    return { type: 'pause', name: parts[1] || '' };
    case 'resume':   return { type: 'resume', name: parts[1] || '' };
    case 'skip':     return { type: 'skip', name: parts[1] || '' };
    case 'retry':
    case 'regen':
    case 'runs':
      if (parts.length < 2) return null; // need adName
      const num = parseInt(parts.slice(1).join(' '), 10);
      return { type: cmdName, name: parts[1], count: isNaN(num) ? undefined : num };
    default:
      return null;
  }
}

export async function sendPhoto(dataUrl, caption = '') {
  if (!connState.token || !connState.chatId) return { ok: false };
  try {
    const comma = String(dataUrl).indexOf(',');
    const meta = comma === -1 ? '' : String(dataUrl).slice(0, comma);
    const b64 = comma === -1 ? String(dataUrl) : String(dataUrl).slice(comma + 1);
    let buffer;
    try { buffer = Buffer.from(b64, 'base64'); } catch {}
    if (!buffer.length) return { ok: false };

    const mime = /data:([^;]+)/.exec(meta)?.[1] || 'image/png';
    const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' :
               mime.includes('webp') ? 'webp' : 'png';

    const blob = new Blob([buffer], { type: mime });
    await connState.bot.api.sendPhoto({
      chat_id: connState.chatId,
      photo: blob,
      caption: caption.slice(0, 1024),
    }).catch((err) => console.error('[Telegram] sendPhoto error:', err.message));

    connState.recordAlive();
    return { ok: true };
  } catch (err) {
    console.error('[Telegram] Photo send error:', err.message);
    return { ok: false };
  }
}

export async function sendMessage(text) {
  if (!connState.token || !connState.chatId) return { configured: false };
  try {
    await connState.bot.api.sendMessage({ chat_id: connState.chatId, text }).catch(() => {});
    connState.recordAlive();
    rateLimiter.recordBurstStart();
    return true;
  } catch (err) {
    console.error('[Telegram] Message send error:', err.message);
    return false;
  }
}

// ─── Direct helpers for bridge.mjs integration ──────────────────────────────────

export function getBatchRegistry() { return batchRegistry; }
export function registerBatchFn(batchId) { registerBatch(batchId); }
export function recordJobFn(batchId, jobName) { recordJob(batchId, jobName); }
export function updateProgressFn(batchId, imageCount, totalImages, now = Date.now()) {
  updateBatchProgress(batchId, imageCount, totalImages, now);
}

function getConnectionState() { return connState; }

export function setConnectionAlive(isAlive = true) {
  connState.isAlive = isAlive;
  connState.lastPongMs = Date.now();
}

export function setConnectionDead(reason) {
  connState.markDead(reason);
}

// ─── Public API (re-exported for clarity) ──────────────────────────────────────

// helpText — used by bridge.mjs and the bot's message handler
export const helpText = HELP_TEXT;


