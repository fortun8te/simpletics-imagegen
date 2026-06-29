import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function parseCommand(text = '') {
  const [command, name, rawCount] = text.trim().split(/\s+/);
  if (command === '/status') return { type: 'status' };
  if (command === '/pause') return { type: 'pause' };
  if (command === '/resume') return { type: 'resume' };
  if (command === '/skip') return { type: 'skip' };
  if (command === '/help' || command === '/start') return { type: 'help' };
  if (command === '/retry' && name) return { type: 'retry', name };
  if (command === '/regen' && name) return { type: 'regen', name };
  const count = Number(rawCount);
  if (command === '/runs' && name && Number.isInteger(count) && count >= 1 && count <= 10) return { type: 'runs', name, count };
  return null;
}

const HELP_TEXT = [
  'Simpletics ImageGen, from your phone:',
  '/status  live summary of the batch',
  '/regen <name>  regenerate that image',
  '/retry <name>  retry a failed image',
  '/runs <name> <1-10>  set how many runs',
  '/skip  skip the next waiting image',
  '/pause and /resume  hold or continue',
  '/help  show this list',
  'Finished images arrive here automatically.',
].join('\n');

export function helpText() {
  return HELP_TEXT;
}

function config() {
  const values = { ...process.env };
  const envPath = path.join(os.homedir(), '.config', 'static-factory', '.env');
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)=(.*)\s*$/.exec(line);
      if (match && !values[match[1]]) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  return { token: values.TELEGRAM_BOT_TOKEN, chatId: String(values.TELEGRAM_CHAT_ID || '') };
}

// Send a plain text message. Safe to call when Telegram is not configured (no-op).
export async function sendMessage(text) {
  const { token, chatId } = config();
  if (!token || !chatId || !text) return { ok: false, configured: false };
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return { ok: true, configured: true };
  } catch {
    return { ok: false, configured: true };
  }
}

// Send an actual image. dataUrl is a data: URL (data:image/png;base64,....) or a
// bare base64 string. Builds a multipart/form-data body with the photo as a file so
// the user sees the finished render inline in the chat. No-op when not configured.
export async function sendPhoto(dataUrl, caption = '') {
  const { token, chatId } = config();
  if (!token || !chatId || !dataUrl) return { ok: false, configured: !!(token && chatId) };
  const comma = String(dataUrl).indexOf(',');
  const meta = comma === -1 ? '' : String(dataUrl).slice(0, comma);
  const b64 = comma === -1 ? String(dataUrl) : String(dataUrl).slice(comma + 1);
  let buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch {
    return { ok: false, configured: true };
  }
  if (!buffer.length) return { ok: false, configured: true };
  const mime = /data:([^;]+)/.exec(meta)?.[1] || 'image/png';
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
  const filename = `image.${ext}`;
  const blob = new Blob([buffer], { type: mime });
  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption) form.append('caption', caption.slice(0, 1024));
  form.append('photo', blob, filename);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    if (res.ok) return { ok: true, configured: true };
    // Fall back to a text note so the user still hears about it.
    if (caption) await sendMessage(caption);
    return { ok: false, configured: true };
  } catch {
    if (caption) await sendMessage(caption);
    return { ok: false, configured: true };
  }
}

export async function startTelegramControl({ handle, status }) {
  const { token, chatId } = config();
  if (!token || !chatId) return { enabled: false, sendMessage, sendPhoto };
  let offset = 0;
  const send = async (text) => fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }) });
  const loop = async () => {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset}`);
      const body = await response.json();
      for (const update of body.result || []) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message?.text || String(message.chat?.id) !== chatId) continue;
        const command = parseCommand(message.text.replace(/@\w+/, ''));
        if (!command) { await send(HELP_TEXT); continue; }
        if (command.type === 'help') { await send(HELP_TEXT); continue; }
        const result = command.type === 'status' ? status() : handle(command);
        await send(result.message || 'Updated.');
      }
    } catch {}
    setTimeout(loop, 500);
  };
  loop();
  return { enabled: true, sendMessage, sendPhoto };
}
