// ImageGen content script. It runs in the user's normal ChatGPT session.
//
// Failure behavior (one bad job never crashes the extension or the tab):
//   - Blocked / refused: if ChatGPT posts a policy refusal ("I can't help with that",
//     "against our policies", etc.) and no new image appears, runJob returns
//     { ok:false, error:'ChatGPT refused this prompt' } within a few seconds instead of
//     waiting out the full 240s timeout.
//   - No image: if generation times out with no new image, returns
//     { ok:false, error:'no image was generated' }.
//   - Multiple images: if ChatGPT renders 2+ new images, we keep the last fresh one
//     (newest), so this is treated as success, not an error.
//   - Network / upload error: any thrown error (reference upload failed, image fetch failed,
//     composer never ready, rate limit reached) is caught and returned as
//     { ok:false, error:<message> }. The page is left usable for the next job.
//   - Stop / abort: user stop sets `aborted`; in-flight waits throw 'stopped', which is
//     returned as { ok:false, error:'stopped' }. `aborted` is reset at the start of every
//     job so a prior stop never poisons the next one.
// In all cases runJob resolves a plain object (never throws), so background's listener
// always gets a clean { ok, ... } response and the tab stays ready for the next job.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let aborted = false;
// Sleep that bails the moment a stop lands, so a long poll interval cannot delay an abort by more
// than ~150ms. Throws 'stopped' if aborted during the sleep.
async function abortableWait(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (aborted) throw new Error('stopped');
    await wait(Math.min(150, ms - (Date.now() - start)));
  }
  if (aborted) throw new Error('stopped');
}
const GEN_TIMEOUT_MS = 240000;
// When ChatGPT renders N images in a single reply, they stream in one after another, so the
// overall wait must scale with N or later images get cut off. Base budget plus ~90s per extra
// image, capped so a wedged tab can't hang forever. N<=1 returns the flat single-image budget.
function genBudgetMs(expected) {
  const n = Math.max(1, expected | 0);
  if (n <= 1) return GEN_TIMEOUT_MS;
  return Math.min(GEN_TIMEOUT_MS + (n - 1) * 90000, 600000);
}
// How long to keep watching for a refusal (no image) before giving up early. ChatGPT shows
// a refusal almost immediately, so this stays well under the full generation timeout.
const REFUSAL_WATCH_MS = 30000;

function visible(element) { return !!(element && element.offsetParent !== null); }
function findComposer() { return document.querySelector('#prompt-textarea, div[contenteditable="true"].ProseMirror, div[contenteditable="true"]'); }
// Best-effort logged-out check: no usable composer AND a visible login affordance (log in / sign
// up button or the auth page URL). Used only to fail fast when the composer never appears, so a
// false negative just falls back to the normal timeout path.
function looksLoggedOut() {
  if (findComposer()) return false;
  if (/\/(auth|login)\b/i.test(location.pathname)) return true;
  const loginUI = [...document.querySelectorAll('a, button, [role="button"]')].some((el) => {
    if (!visible(el)) return false;
    const label = textOf(el).toLowerCase();
    return /^(log in|login|sign in|log in to chatgpt|sign up|stay logged out)$/.test(label);
  });
  return loginUI && !document.querySelector('main, [role="main"]');
}
function textOf(element) { return (element && element.textContent || '').trim(); }
function buttonsWithText(text) { return [...document.querySelectorAll('button, [role="button"]')].filter((button) => visible(button) && textOf(button) === text); }
async function waitFor(check, timeout = 20000, interval = 250) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // Bail at the TOP of each iteration so a stop halts within one interval, even before the check.
    if (aborted) throw new Error('stopped');
    const value = check();
    if (value) return value;
    if (aborted) throw new Error('stopped');
    await wait(interval);
  }
  return null;
}

function setInputValue(input, value) {
  // Use the matching prototype setter so React-controlled textareas work too (a textarea is not
  // an HTMLInputElement, so HTMLInputElement.prototype's setter would throw on it).
  const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function currentProjectName() {
  const composer = document.querySelector('[aria-label^="New chat in "]');
  const composerName = ImageGenLogic.projectNameFromComposerLabel(composer?.getAttribute('aria-label'));
  if (composerName) return composerName;
  const titleControl = document.querySelector('[aria-label^="Edit the title of "]');
  const match = (titleControl?.getAttribute('aria-label') || '').match(/^Edit the title of (.+)$/);
  return match ? match[1].trim() : null;
}

// Whitespace-tolerant text match. Project names built by the panel contain DOUBLE spaces
// (e.g. "Brand Batch  v1  2026-06-24 14:30"), but ChatGPT renders the row with collapsed
// single spaces, so a raw `.includes()` would never match the just-created project and we
// would create a duplicate. Collapsing both sides makes the substring check reliable.
function collapseWs(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function rowMatchesProject(row, project) {
  return visible(row) && collapseWs(textOf(row)).includes(collapseWs(project));
}
function projectListed(project) {
  const rows = [...document.querySelectorAll('main [role="row"], [role="main"] [role="row"]')];
  return rows.some((row) => rowMatchesProject(row, project));
}

async function findExistingProject(project) {
  const search = await waitFor(() => {
    const input = document.querySelector('input[aria-label="Search projects"]');
    return visible(input) ? input : null;
  }, 12000);
  if (!search) return null;
  // Clear any stale text a prior search left in the field, then type the name so the list filters
  // down to this project. Without clearing, a leftover query can keep the just-created project
  // hidden and push us into creating a duplicate.
  setInputValue(search, '');
  await wait(120);
  setInputValue(search, project);
  const listed = await waitFor(() => projectListed(project), 12000);
  if (!listed) return null;
  // open the project so chats can be created inside it; capture its URL
  const link = await waitFor(() => {
    const rows = [...document.querySelectorAll('main [role="row"], [role="main"] [role="row"]')];
    const row = rows.find((r) => rowMatchesProject(r, project));
    return row ? (row.querySelector('a[href*="/g/"]') || row.querySelector('a') || row) : null;
  }, 6000);
  if (!link) return null;
  link.click();
  return await waitFor(() => ImageGenLogic.projectNameMatches(currentProjectName(), project) ? location.href : null, 15000) || null;
}

// Find the project-name field in an open New-project dialog, trying every shape ChatGPT has
// shipped: aria-labelled input, placeholder input, a dialog-scoped input/textarea/contenteditable,
// or a generic visible text input inside the dialog. Returns the field element or null.
function findProjectNameField() {
  const byLabel = document.querySelector('input[aria-label="Project name"], input[placeholder="Copenhagen Trip"], input[aria-label*="project name" i], input[placeholder*="project" i]');
  if (byLabel && visible(byLabel)) return byLabel;
  const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal')].filter(visible);
  for (const dialog of dialogs) {
    const scoped = dialog.querySelector('input[aria-label*="project name" i], input[placeholder*="project" i], textarea[aria-label*="project name" i]');
    if (scoped && visible(scoped)) return scoped;
    const editable = dialog.querySelector('[contenteditable="true"]');
    if (editable && visible(editable)) return editable;
    const anyInput = [...dialog.querySelectorAll('input')].find((field) => visible(field) && (!field.type || /^(text|search)$/i.test(field.type)));
    if (anyInput) return anyInput;
    const anyTextarea = [...dialog.querySelectorAll('textarea')].find(visible);
    if (anyTextarea) return anyTextarea;
  }
  return null;
}

// Find the dialog's confirm button. Prefer the exact "Create project" label, then fall back to a
// bare "Create" button inside the open dialog so a label tweak does not strand the flow.
function findCreateProjectButton() {
  const exact = buttonsWithText('Create project')[0];
  if (exact) return exact;
  const dialog = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal')].find(visible);
  if (dialog) {
    const create = [...dialog.querySelectorAll('button, [role="button"]')].find((button) => visible(button) && /^create( project)?$/i.test(textOf(button)));
    if (create) return create;
  }
  return null;
}

// Set a value into a project-name field that may be an input, a textarea, or a contenteditable.
function setProjectFieldValue(field, value) {
  field.focus();
  if (field.isContentEditable) {
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, value);
  } else {
    setInputValue(field, value);
  }
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

async function ensureProject(project) {
  if (ImageGenLogic.projectNameMatches(currentProjectName(), project)) return { ok: true, created: false, projectUrl: location.href };
  const existingUrl = await findExistingProject(project);
  if (existingUrl) return { ok: true, created: false, projectUrl: existingUrl };

  const newButtons = await waitFor(() => {
    const buttons = [...document.querySelectorAll('main button, [role="main"] button')].filter((button) => visible(button) && textOf(button) === 'New');
    return buttons.length ? buttons : null;
  }, 12000);
  if (!newButtons) return { ok: false, error: 'the New project button was not available' };
  let input = findProjectNameField();
  if (!input) {
    for (const button of newButtons) {
      button.click();
      // Try several dialog shapes before giving up on this button. ChatGPT has shipped the
      // name field as a labelled input, a placeholder input, a textarea, and a contenteditable
      // inside a [role="dialog"]/modal, so probe all of them with a short retry per button.
      input = await waitFor(findProjectNameField, 2600);
      if (input) break;
    }
  }
  if (!input) return { ok: false, error: 'the project-name field did not open' };
  setProjectFieldValue(input, project);

  const createButton = await waitFor(findCreateProjectButton, 8000);
  if (!createButton) return { ok: false, error: 'the Create project button did not appear' };
  const enabled = await waitFor(() => {
    const button = findCreateProjectButton();
    return ImageGenLogic.canSubmitProject(button) ? button : null;
  }, 8000);
  if (!enabled) return { ok: false, error: 'the project name was not accepted' };
  enabled.click();
  const projectUrl = await waitFor(() => ImageGenLogic.projectNameMatches(currentProjectName(), project) ? location.href : null, 30000);
  return projectUrl ? { ok: true, created: true, projectUrl } : { ok: false, error: 'ChatGPT created the project but did not open it' };
}

async function newChat() {
  if (location.pathname !== '/') {
    const control = document.querySelector('[data-testid="new-chat-button"], button[aria-label*="New chat"], nav a[href="/"]');
    if (!control) throw new Error('New chat control was not available');
    control.click();
    const home = await waitFor(() => location.pathname === '/', 10000);
    if (!home) throw new Error('ChatGPT did not open a new chat');
  }
  // Return the composer or null. runJob's caller-side check turns a null into either a fast
  // logged-out error (looksLoggedOut) or the normal "composer did not become ready" throw, so a
  // logged-out tab no longer waits out the full generation timeout.
  return await waitFor(findComposer, 20000);
}

function dataUrlToFile(dataUrl, name) {
  const [meta, b64] = dataUrl.split(',');
  const mime = (meta.match(/data:(.*?);/) || [, 'image/png'])[1];
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], name || 'reference.png', { type: mime });
}

// Dedupe refs so the SAME image is never attached twice in one chat. We key first on the
// dataUrl content (the actual bytes) and, as a secondary guard, on the lowercased name, so a
// caller passing the same picture twice (e.g. product == subject, or an extra ref equal to the
// layout ref) only uploads it once. Order is preserved by keeping the first occurrence.
function dedupeRefs(refs) {
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    if (!ref || !ref.dataUrl) continue;
    const nameKey = (ref.name || '').trim().toLowerCase();
    const key = `url:${ref.dataUrl}`;
    const altKey = nameKey ? `name:${nameKey}` : null;
    if (seen.has(key) || (altKey && seen.has(altKey))) continue;
    seen.add(key);
    if (altKey) seen.add(altKey);
    out.push(ref);
  }
  return out;
}

async function attachRefs(refs) {
  if (!refs || !refs.length) return;
  // Dedupe BEFORE building the DataTransfer so a duplicate is never double-pasted. If dedupe
  // leaves nothing (shouldn't happen with a non-empty input), skip upload exactly as today.
  const unique = dedupeRefs(refs);
  if (!unique.length) return;
  // Prefer the composer's own file input, not the first hidden input on the page (ChatGPT ships
  // several: avatar, settings, etc). Probe image-accepting inputs first, then any input inside the
  // composer form, then fall back to the first file input exactly as before so nothing regresses.
  const fileInputs = [...document.querySelectorAll('input[type="file"]')];
  const composer = findComposer();
  const form = composer ? composer.closest('form') : null;
  const input = fileInputs.find((el) => form && form.contains(el) && /image|\*/.test(el.accept || ''))
    || fileInputs.find((el) => /image|\*/.test(el.accept || ''))
    || (form && fileInputs.find((el) => form.contains(el)))
    || fileInputs[0];
  if (!input) throw new Error('ChatGPT reference upload is unavailable');
  const transfer = new DataTransfer();
  unique.forEach((ref, index) => transfer.items.add(dataUrlToFile(ref.dataUrl, ref.name || `reference-${index}.png`)));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // Wait for the uploads to ACTUALLY settle instead of guessing a fixed time. Large refs (a
  // 2.3MB texture plus product plus layout = 3 refs) can take much longer than a flat delay,
  // and sending the prompt before they finish makes ChatGPT generate with missing references.
  // Strategy: small minimum settle, then poll the composer for the expected number of attachment
  // previews/thumbnails until it reaches refs.length, capped by a hard timeout so we can never
  // hang. If we cannot reliably count previews, fall back to the old fixed wait, scaled up.
  await abortableWait(700); // minimum settle so the previews have a chance to start rendering
  await waitForAttachments(form, unique.length);
}

// Count the attachment previews/thumbnails ChatGPT renders in the composer for queued uploads.
// ChatGPT has shipped these as image thumbnails plus a per-file remove button inside the composer
// form, so we count whichever signal is present and take the larger. Returns a best-effort count;
// 0 means we found no recognizable previews (the caller then falls back to a fixed wait).
function countComposerAttachments(form) {
  const scope = form || findComposer()?.closest('form') || document;
  if (!scope || !scope.querySelectorAll) return 0;
  // Remove-file buttons are the most reliable per-attachment signal (one per queued file).
  const removeButtons = [...scope.querySelectorAll('button[aria-label*="remove" i], button[aria-label*="delete" i], button[data-testid*="remove" i], button[aria-label*="Remove file" i]')]
    .filter(visible).length;
  // Thumbnails: attachment preview images rendered for the queued files (exclude the generated
  // output area, which lives outside the composer form, so scoping to the form keeps this clean).
  const thumbs = [...scope.querySelectorAll('img')]
    .filter((image) => visible(image) && !/Generated image/i.test(image.getAttribute('alt') || '')).length;
  return Math.max(removeButtons, thumbs);
}

// Poll until the composer shows `expected` attachment previews, or a hard cap elapses, then return.
// Never throws except on a real stop (via abortableWait). If no previews are ever detectable we
// fall back to the original fixed wait, scaled up for large ref counts, so behavior never regresses.
async function waitForAttachments(form, expected) {
  if (!expected) return;
  const HARD_CAP_MS = 10000;
  const start = Date.now();
  let sawAny = false;
  while (Date.now() - start < HARD_CAP_MS) {
    if (aborted) throw new Error('stopped');
    const count = countComposerAttachments(form);
    if (count > 0) sawAny = true;
    if (count >= expected) { await abortableWait(250); return; } // settled: brief extra beat, then go
    await abortableWait(300);
  }
  // Hard cap reached. If we never saw a single preview, the selectors likely did not match this
  // ChatGPT build: fall back to the original fixed wait, scaled up so large refs still settle.
  if (!sawAny) await abortableWait(1500 + expected * 650);
}

function findSendButton() {
  return [...document.querySelectorAll('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label*="Send"], #composer-submit-button')].find(visible) || null;
}

// Insert a SOFT line break into the composer without submitting. In ChatGPT's ProseMirror a
// plain Enter submits, so a newline must go in as Shift+Enter. We dispatch a real Shift+Enter
// keydown/keyup on the composer (what ProseMirror listens for); if for some reason the break did
// not land we fall back to execCommand('insertLineBreak'). Never submits.
function insertSoftBreak(composer) {
  const target = composer || findComposer();
  if (!target) return;
  const before = textOf(target).length;
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: true, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent('keydown', opts));
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
  // Fallback: if the Shift+Enter did not change the composer at all, force a line break.
  if (textOf(target).length === before) document.execCommand('insertLineBreak', false, null);
}

async function typeNaturally(prompt, composer) {
  // Type char by char with variation instead of pasting the whole string (which reads as
  // automated). Fast: short runs, occasional small pause, a rare think-beat. Newlines are NOT
  // typed as characters: a plain newline/Enter submits the ProseMirror composer, which would
  // split a multi-paragraph prompt into several messages. Instead each run of newlines becomes a
  // single SOFT break (Shift+Enter), so the whole prompt stays one message. Collapsing 3+
  // consecutive newlines to one soft break is fine.
  const target = composer || findComposer();
  for (let i = 0; i < prompt.length; i++) {
    if (aborted) throw new Error('stopped');
    const ch = prompt[i];
    if (ch === '\n' || ch === '\r') {
      // Swallow the rest of this newline run so 2+ blank lines collapse to one soft break.
      while (i + 1 < prompt.length && (prompt[i + 1] === '\n' || prompt[i + 1] === '\r')) i++;
      insertSoftBreak(target);
      await wait(14 + Math.random() * 20);
      continue;
    }
    document.execCommand('insertText', false, ch);
    // Slowed, more human cadence (~9.5ms/char mean) instead of the old ~5ms machine-gun pace.
    let delay = 4 + Math.random() * 9;
    if (Math.random() < 0.14) delay += Math.random() * 26;
    if (Math.random() < 0.03) delay += 55 + Math.random() * 140;
    if (delay > 2) await wait(delay);
  }
}
// Count user turns currently in the thread, so we can tell whether a send actually landed and
// whether it created exactly one new message (best-effort, never throws).
function userTurnCount() {
  return document.querySelectorAll('[data-message-author-role="user"]').length;
}

async function typeAndSend(composer, prompt) {
  composer.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  // Enter the ENTIRE prompt first (newlines become soft breaks, so nothing submits mid-typing),
  // then submit exactly once at the end. This is what keeps a multi-paragraph prompt as one message.
  const beforeTurns = userTurnCount();
  await typeNaturally(prompt, composer);
  await abortableWait(250);
  const sendButton = findSendButton();
  if (sendButton) sendButton.click();
  else composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await abortableWait(800);
  // Single guarded retry: only fire again if NOTHING was sent (no new user turn) AND the composer
  // still clearly holds the full prompt. This recovers a missed click without ever creating a
  // second message mid-prompt. If a turn already landed, do not click again.
  const sent = userTurnCount() > beforeTurns;
  if (!sent && textOf(findComposer()).length > 8) findSendButton()?.click();
}

function generatedCandidates() {
  // Scope to the LAST assistant turn so composer attachment thumbnails and earlier-turn images can
  // never be scraped as the generated output (the ref-echo bug). Fall back to the whole document
  // only if no assistant turn exists yet. Same scoping refusalDetected() already uses.
  const turns = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const scope = turns.length ? turns[turns.length - 1] : document;
  const buttons = [...scope.querySelectorAll('button[aria-label*="Generated image" i]')];
  const fromButtons = buttons.map((button) => button.querySelector('img')).filter(Boolean).map((image) => ({ src: image.currentSrc || image.src, generated: true }));
  const fromImages = [...scope.querySelectorAll('img[alt*="Generated image" i]')].map((image) => ({ src: image.currentSrc || image.src, generated: true }));
  const unique = new Map();
  [...fromButtons, ...fromImages].forEach((candidate) => { if (candidate.src) unique.set(candidate.src, candidate); });
  return [...unique.values()];
}

function rateLimited() {
  const text = (document.body.innerText || '').toLowerCase();
  return /too many requests|try again later|please wait a moment/.test(text) || (/(reached|hit|exceeded)[^.]{0,40}(limit|cap)/.test(text) && /(image|generat|message)/.test(text));
}

// Look at the most recent assistant turn for a policy refusal. We only sample the tail of the
// page text so an old refusal earlier in the thread does not produce a false positive.
function refusalDetected() {
  const turns = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const scope = turns.length ? turns[turns.length - 1] : document.querySelector('main, [role="main"]');
  const text = (scope?.innerText || '').toLowerCase();
  if (!text) return false;
  return /\bi can'?t help\b/.test(text)
    || /\bi'?m not able to\b/.test(text)
    || /\bi am not able to\b/.test(text)
    || /\bi can'?t create (that|this) image\b/.test(text)
    || /\bi'?m unable to\b/.test(text)
    || /\bcan'?t (create|generate|make) (that|this|the requested)\b/.test(text)
    || /against (our|the) (content )?polic/.test(text)
    || /\bviolates? (our|the)\b/.test(text)
    || /\bthis (request|prompt|image) (goes against|violates|isn'?t allowed)\b/.test(text);
}

async function waitForGeneratedImage(baseline) {
  const start = Date.now();
  let last = null;
  let stable = 0;
  while (Date.now() - start < GEN_TIMEOUT_MS) {
    if (aborted) throw new Error('stopped');
    // freshGeneratedSrc returns the NEWEST fresh image, so if ChatGPT renders 2+ new images
    // we naturally settle on the last one (no error for multiple images).
    const src = ImageGenLogic.freshGeneratedSrc(generatedCandidates(), baseline);
    if (src && src === last) { if (++stable >= 2) return src; }
    else { last = src; stable = 0; }
    if (!src && rateLimited()) throw new Error('ChatGPT reached its image limit');
    // Fast-fail on a policy refusal while no image has appeared, instead of waiting 240s.
    if (!src && Date.now() - start < REFUSAL_WATCH_MS && refusalDetected()) {
      throw new Error('ChatGPT refused this prompt');
    }
    await abortableWait(2200);
  }
  // No image after the full window. Distinguish a late refusal from a silent no-show.
  if (refusalDetected()) throw new Error('ChatGPT refused this prompt');
  throw new Error('no image was generated');
}

// Collect EVERY new generated image that appears in the assistant turn (one chat asked for N
// variations). We keep accumulating fresh srcs in order, deduping by src, until the count
// stops growing for a couple of poll cycles, reaches `expected`, or we time out. Refusal and
// rate-limit handling mirror waitForGeneratedImage so callers behave the same on failure.
async function waitForGeneratedImages(baseline, expected) {
  const start = Date.now();
  // Multi-image replies stream in serially, so scale the overall budget with N (a single image
  // keeps the flat GEN_TIMEOUT_MS timing). This keeps later variants in one reply from being cut off.
  const budget = genBudgetMs(expected);
  let lastKey = null;
  let stable = 0;
  while (Date.now() - start < budget) {
    if (aborted) throw new Error('stopped');
    // Read the LIVE set of fresh (non-baseline) generated srcs currently in the DOM, in DOM order.
    // We do NOT accumulate a growing union across cycles: ChatGPT swaps a streaming preview src for
    // the final src on the same image, so a union would count one image twice (a "duplicate of one
    // image N times" bug). Reading the live set each cycle and waiting for it to settle gives the
    // true count of distinct final images.
    const fresh = [];
    const liveSeen = new Set();
    for (const candidate of generatedCandidates()) {
      if (!candidate || !candidate.generated || !candidate.src) continue;
      if (baseline && baseline.has(candidate.src)) continue;
      if (liveSeen.has(candidate.src)) continue;
      liveSeen.add(candidate.src);
      fresh.push(candidate.src);
    }
    // Settle gate: the live set must hold identical (same srcs, same order) across two poll cycles
    // before we trust it. This absorbs the placeholder->final swap and avoids returning a half-baked
    // streaming preview. Once stable, return either the first N (if we have >= N) or all we have
    // (ChatGPT gave fewer than N, e.g. a single grid). The full-window timeout still bounds the wait.
    const key = fresh.join('|');
    if (fresh.length && key === lastKey) {
      // Held steady across two cycles. Return the first N (or all, if ChatGPT gave fewer than N).
      if (++stable >= 2) return fresh.slice(0, Math.min(expected, fresh.length));
    } else {
      lastKey = key;
      stable = 0;
    }
    if (!fresh.length && rateLimited()) throw new Error('ChatGPT reached its image limit');
    if (!fresh.length && Date.now() - start < REFUSAL_WATCH_MS && refusalDetected()) {
      throw new Error('ChatGPT refused this prompt');
    }
    await abortableWait(2200);
  }
  // Timed out. Return the live fresh set if there is one; otherwise distinguish refusal from no-show.
  const finalFresh = [];
  const finalSeen = new Set();
  for (const candidate of generatedCandidates()) {
    if (!candidate || !candidate.generated || !candidate.src) continue;
    if (baseline && baseline.has(candidate.src)) continue;
    if (finalSeen.has(candidate.src)) continue;
    finalSeen.add(candidate.src);
    finalFresh.push(candidate.src);
  }
  if (finalFresh.length) return finalFresh.slice(0, Math.min(expected, finalFresh.length));
  if (refusalDetected()) throw new Error('ChatGPT refused this prompt');
  throw new Error('no image was generated');
}

async function waitForConversationPath() {
  return waitFor(() => /^\/c\//.test(location.pathname) ? location.pathname : null, 25000, 300);
}

async function fetchToDataUrl(src) {
  const response = await fetch(src, { credentials: 'include' });
  if (!response.ok) throw new Error('could not download ChatGPT output');
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function visibleMenuItem(label) {
  return [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], button')].find((element) => visible(element) && textOf(element).toLowerCase() === label.toLowerCase()) || null;
}

// Find a menu item whose text matches a predicate, across the roles ChatGPT uses for menus.
// Broader than visibleMenuItem (substring/regex friendly), used for the Rename item which has
// shipped as "Rename", "Rename chat", and "Rename conversation".
function menuItemMatching(predicate) {
  return [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], button, a')]
    .find((element) => visible(element) && predicate(textOf(element).toLowerCase())) || null;
}

// Locate the sidebar link for this conversation, the easiest anchor for the row and its kebab.
function conversationLink(path) {
  return [...document.querySelectorAll('nav a[href], aside a[href], a[href*="/c/"]')]
    .find((anchor) => visible(anchor) && ImageGenLogic.conversationHrefMatch(path, anchor.getAttribute('href'))) || null;
}

// Walk up from the link to the row container that also holds the kebab/options button.
function conversationRow(path) {
  const link = conversationLink(path);
  if (!link) return null;
  return link.closest('li') || link.closest('[role="listitem"]') || link.parentElement || link;
}

// Wait for the conversation row to actually exist in the sidebar. After a fresh generation the
// row can lag the URL by several seconds, so poll generously before any rename attempt.
async function waitForConversationRow(path) {
  if (!path) return null;
  return waitFor(() => conversationRow(path), 10000, 300);
}

// Find the kebab/options button inside a row, trying the labelled variants ChatGPT has shipped
// ("Open conversation options", "More", "Options") and, as a last resort, an icon-only button.
function rowOptionsButton(row) {
  if (!row) return null;
  const buttons = [...row.querySelectorAll('button, [role="button"]')].filter(visible);
  const byLabel = buttons.find((button) => {
    const label = (button.getAttribute('aria-label') || '').toLowerCase();
    return /conversation options|more|options|menu/.test(label);
  });
  if (byLabel) return byLabel;
  // Icon-only fallback: a button with no text but an svg, which is how the kebab usually renders.
  return buttons.find((button) => !textOf(button) && button.querySelector('svg')) || null;
}

async function openActiveChatMenu(path) {
  // Header options button (shown when the chat is open). Broaden beyond the one exact label.
  const headerMenu = [...document.querySelectorAll('button[aria-label="Open conversation options"], header button[aria-label*="option" i], header button[aria-label*="More" i]')].find(visible);
  if (headerMenu) { headerMenu.click(); await wait(350); return true; }
  // Otherwise hover/focus the sidebar row so its kebab mounts, then click it.
  const row = conversationRow(path);
  if (!row) return false;
  row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  const menu = await waitFor(() => rowOptionsButton(row), 2500, 200);
  if (!menu) return false;
  menu.click();
  await wait(350);
  return true;
}

// Read the conversation's current title from whichever affordance ChatGPT is showing:
// the header edit-title control, the active sidebar row, or the document title.
function currentChatTitle(path) {
  const titleControl = document.querySelector('[aria-label^="Edit the title of "]');
  const labelMatch = (titleControl?.getAttribute('aria-label') || '').match(/^Edit the title of (.+)$/);
  if (labelMatch && labelMatch[1].trim()) return labelMatch[1].trim();
  if (path) {
    const link = [...document.querySelectorAll('nav a[href]')].find((anchor) => ImageGenLogic.conversationHrefMatch(path, anchor.getAttribute('href')));
    const rowText = link && textOf(link);
    if (rowText) return rowText;
  }
  const docTitle = (document.title || '').replace(/\s*[-|]\s*ChatGPT\s*$/i, '').trim();
  return docTitle || null;
}

// Set a value into either a native <input>/<textarea> or a contenteditable, using both a
// native value setter (for React-controlled inputs) and execCommand insertText.
function setRenameFieldValue(field, name) {
  field.focus();
  if (field.isContentEditable) {
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, name);
  } else {
    const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    field.select?.();
    document.execCommand('selectAll', false, null);
    if (setter) setter.call(field, name);
    else field.value = name;
    // Also drive it through execCommand so contenteditable-backed inputs and IME paths agree.
    document.execCommand('insertText', false, name);
    if (field.value !== name && setter) setter.call(field, name);
  }
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

// Match a Rename menu item case-insensitively, allowing "Rename chat"/"Rename conversation".
function findRenameMenuItem() {
  return menuItemMatching((text) => /^rename( chat| conversation)?$/.test(text) || /\brename\b/.test(text));
}

// Open a rename field via any available path and return it, or null. Tries header-title first
// (when the chat is open ChatGPT often shows an editable header title), then the kebab menu,
// then a blind double-click on the title, each with a short retry.
async function openRenameField(path) {
  const find = () => findRenameField(path);
  // Path A: header edit-title control (common when the chat is open inside a project).
  const headerEdit = [...document.querySelectorAll('[aria-label^="Edit the title of "], header h1, header button[aria-label*="title" i]')].find(visible);
  if (headerEdit) {
    headerEdit.click();
    const field = await waitFor(find, 2500);
    if (field) return field;
  }
  // Path B: the conversation kebab menu, then a Rename item (broad text match).
  if (await openActiveChatMenu(path)) {
    const rename = await waitFor(findRenameMenuItem, 3000);
    if (rename) {
      rename.click();
      const field = await waitFor(find, 3500);
      if (field) return field;
    }
  }
  // Path C (best-effort): double-click the title to trigger inline rename. Tries the header
  // heading and the active sidebar conversation row. Blind fallback when A and B both miss.
  const titleTargets = [
    document.querySelector('header h1, header [class*="title" i]'),
    conversationLink(path),
    document.querySelector('nav a[aria-current="page"], nav a[data-active="true"], nav [aria-selected="true"]'),
  ].filter((el) => el && visible(el));
  for (const target of titleTargets) {
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const field = await waitFor(find, 1800);
    if (field) return field;
  }
  return null;
}

// Find the active rename input/textarea/contenteditable by focus, by common selectors, or by
// scanning the active sidebar row and any open dialog. The rename UI usually focuses its own
// field, but some builds mount an unlabelled input inside the row, so we look there too.
function findRenameField(path) {
  // 1) Focused editable element is the strongest signal (rename usually auto-focuses its field).
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable) && visible(active)) return active;
  // 2) Labelled title fields.
  const candidates = [
    'input[aria-label^="Edit the title of "]',
    'input[aria-label*="title" i]',
    'textarea[aria-label*="title" i]',
    '[contenteditable="true"][aria-label*="title" i]',
    'input[name="title"]',
  ];
  for (const selector of candidates) {
    const field = document.querySelector(selector);
    if (field && visible(field)) return field;
  }
  // 3) An editable field inside the active conversation row (inline rename in the sidebar).
  const row = conversationRow(path);
  if (row) {
    const inRow = [...row.querySelectorAll('input, textarea, [contenteditable="true"]')].find(visible);
    if (inRow) return inRow;
  }
  // 4) An editable field inside any open dialog (some builds rename via a small modal).
  const dialog = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].find(visible);
  if (dialog) {
    const inDialog = [...dialog.querySelectorAll('input, textarea, [contenteditable="true"]')].find(visible);
    if (inDialog) return inDialog;
  }
  return null;
}

// Did the title verify as the target name (whitespace-collapsed)? Accepts either an exact
// collapsed match or projectNameMatches, so trailing/double spaces never block a real success.
function titleVerifies(path, name) {
  const title = currentChatTitle(path);
  if (!title) return false;
  if (collapseWs(title) === collapseWs(name)) return true;
  return ImageGenLogic.projectNameMatches(title, name);
}

// Commit the edit. Builds differ: some commit on Enter, some on blur. Fire a full Enter
// keydown AND keyup, then also blur, so whichever the build listens for lands.
function commitRenameField(field) {
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  field.dispatchEvent(new KeyboardEvent('keydown', opts));
  field.dispatchEvent(new KeyboardEvent('keypress', opts));
  field.dispatchEvent(new KeyboardEvent('keyup', opts));
}

async function applyRenameOnce(path, name) {
  const field = await openRenameField(path);
  if (!field) return false;
  setRenameFieldValue(field, name);
  await wait(150);
  // Commit on Enter first, verify, then fall back to blur (some builds only commit on blur).
  commitRenameField(field);
  if (await waitFor(() => titleVerifies(path, name) ? true : null, 2500, 250)) return true;
  field.blur?.();
  document.body?.click?.(); // collapse any inline editor that commits on outside-click
  return !!await waitFor(() => titleVerifies(path, name) ? true : null, 3000, 300);
}

async function renameChat(path, name) {
  if (!path || !name) return false;
  // Wait for the sidebar row to actually exist (it can lag a fresh generation by seconds).
  await waitForConversationRow(path);
  // Already named (e.g. a retry on the same chat)? Treat as done.
  if (titleVerifies(path, name)) return true;
  // Up to 3 total attempts with small backoffs. Never throw: a rename failure must not fail the
  // generation. Re-check the title between attempts in case a prior attempt landed late.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (titleVerifies(path, name)) return true;
      if (await applyRenameOnce(path, name)) return true;
    } catch {}
    await wait(500 + attempt * 400);
  }
  return titleVerifies(path, name);
}

// Is the current conversation actually inside `project`? Checks the in-project composer
// label, the header "... in <project>" hint, and the project link in the page chrome.
function conversationInProject(project) {
  if (!project) return false;
  if (ImageGenLogic.projectNameMatches(currentProjectName(), project)) return true;
  const breadcrumb = [...document.querySelectorAll('a[href*="/g/"], header a, [aria-label*="project" i]')]
    .some((element) => visible(element) && ImageGenLogic.projectNameMatches(textOf(element), project));
  if (breadcrumb) return true;
  // Some layouts render "<title> in <project>" near the header.
  const head = textOf(document.querySelector('header')) || '';
  return new RegExp(`\\bin\\s+${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(head);
}

async function moveToProject(path, project) {
  if (!path || !project) return false;
  if (conversationInProject(project)) return true;
  if (!await openActiveChatMenu(path)) return false;
  const move = await waitFor(() => visibleMenuItem('Move to project') || visibleMenuItem('Add to project'), 3000);
  if (!move) return false;
  move.click();
  const target = await waitFor(() => visibleMenuItem(project), 4000);
  if (!target) return false;
  target.click();
  // Verify the move actually landed instead of assuming success.
  const verified = await waitFor(() => conversationInProject(project), 6000, 300);
  return !!verified;
}

// Build the "make N variations" instruction. Ratio handling:
//   - If the job carries an explicit aspect (not 'auto'), stay ratio-neutral here: the aspect line
//     already in the message owns the shape, so we never force 1:1.
//   - Otherwise keep the old behavior exactly: if the prompt text already declares a ratio
//     (e.g. "Portrait 4:5", "16:9", "vertical", "square") stay neutral, else default to 1:1 square
//     so existing square batches never regress.
function variantsSuffix(prompt, n, aspect) {
  const hasAspect = !!aspect && aspect !== 'auto';
  const declaresRatio = /\b\d{1,2}\s*:\s*\d{1,2}\b|portrait|landscape|vertical|horizontal|\bsquare\b/i.test(prompt || '');
  const shape = (hasAspect || declaresRatio) ? '' : '1:1 square ';
  return `\n\nGenerate ${n} separate ${shape}image variations of this in one go, each a distinct take, as ${n} separate images (not a single grid).`;
}

// Map an aspect token to a single instruction line for the message. Orientation words help the
// model honor the ratio. Returns '' for 'auto' or anything unrecognized (no line added).
function aspectInstruction(aspect) {
  const orientation = {
    '16:9': 'wide landscape',
    '4:3': 'landscape',
    '5:4': 'wide landscape',
    '9:16': 'tall portrait',
    '4:5': 'portrait',
    '3:4': 'portrait',
    '1:1': 'square',
  };
  if (!aspect || aspect === 'auto' || !orientation[aspect]) return '';
  return `\nOutput the final image in ${aspect} aspect ratio (${orientation[aspect]}).`;
}

// Anti-throttle keepalive. Chrome throttles then FREEZES hidden background tabs, which stalls a
// long N-image loop. Playing silent media marks the tab as "playing", so Chrome leaves it alone.
// Best-effort only: every step is wrapped so autoplay or AudioContext errors never break a job.
let keepAwakeCtx = null;
let keepAwakeOsc = null;
let keepAwakeAudio = null;
// Near-silent looping clip with a tiny non-zero amplitude (NOT pure zeros) so, if it plays, it
// also marks the tab audible. Pure silence does not count as audible, so the oscillator is primary.
const SILENT_WAV = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/wAAVAB4AFQAAACs/4j/rP8AAFQAeABUAAAArP+I/6z/AABUAHgAVAAAAKz/iP+s/w==';
function startKeepAwake() {
  // WHY non-zero high-frequency output: Chrome only exempts AUDIBLE tabs from freeze/throttle. A
  // zero-output tab is not audible, so silence never triggers the exemption. We drive an oscillator
  // at ~19 kHz through a small non-zero gain. ~19 kHz at low gain is inaudible to most adults and
  // most laptop speakers cannot reproduce it, yet it still registers the tab as audible to Chrome.
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      keepAwakeCtx = new AudioCtx();
      const gain = keepAwakeCtx.createGain();
      gain.gain.value = 0.025; // small but non-zero so the tab counts as audible
      keepAwakeOsc = keepAwakeCtx.createOscillator();
      keepAwakeOsc.frequency.value = 19000; // inaudible to most people, still "audible" to Chrome
      keepAwakeOsc.connect(gain);
      gain.connect(keepAwakeCtx.destination);
      keepAwakeOsc.start();
      keepAwakeCtx.resume?.(); // resume in case the context starts suspended
    }
  } catch {}
  // Fallback path: a tiny looping near-silent audio element at non-zero volume, also marks audible.
  try {
    keepAwakeAudio = new Audio(SILENT_WAV);
    keepAwakeAudio.loop = true;
    keepAwakeAudio.volume = 0.02; // non-zero so playback registers the tab as audible
    keepAwakeAudio.play?.().catch(() => {});
  } catch {}
  // Re-trigger hook: the background SW heartbeat calls this to re-arm audio if autoplay was blocked.
  try {
    window.__imageGenKeepAwake = () => {
      try {
        keepAwakeCtx && keepAwakeCtx.resume && keepAwakeCtx.resume();
        keepAwakeAudio && keepAwakeAudio.play && keepAwakeAudio.play().catch(() => {});
      } catch {}
    };
  } catch {}
}
function stopKeepAwake() {
  try { keepAwakeOsc?.stop(); } catch {}
  try { keepAwakeCtx?.close(); } catch {}
  try { keepAwakeAudio?.pause(); } catch {}
  try { window.__imageGenKeepAwake = () => {}; } catch {} // clear the re-trigger hook
  keepAwakeOsc = null;
  keepAwakeCtx = null;
  keepAwakeAudio = null;
}

async function runJob(job) {
  startKeepAwake(); // keep the tab alive while hidden for the whole job
  try {
  // If the background already opened the project's new-chat composer, type there so the chat
  // is born IN the project. Otherwise fall back to a fresh home chat. When background flags
  // noProject (project prep failed), we generate in a plain home chat and skip the move so a
  // project hiccup never blocks generation.
  const useProject = !!job.project && !job.noProject;
  const bornInProject = useProject && ImageGenLogic.projectNameMatches(currentProjectName(), job.project);
  const composer = bornInProject ? await waitFor(findComposer, 20000) : await newChat();
  // Composer never came up. If the page looks logged out (no main, login UI present), bail fast
  // with a clear message instead of waiting out the full timeout. Best-effort: only short-circuit
  // when we are confident it is a login screen, otherwise keep the original ready error.
  if (!composer) {
    if (looksLoggedOut()) return { ok: false, error: 'not logged into ChatGPT (open chatgpt.com and sign in)' };
    throw new Error('ChatGPT composer did not become ready');
  }
  await attachRefs(job.refs || []);

  // N-variants, PRIMARY mechanism = ask for all N in the FIRST prompt and capture them from that one
  // reply. We send the full prompt once (with refs) plus an explicit "N separate images" instruction,
  // then capture every fresh image (up to N) via waitForGeneratedImages. ChatGPT sometimes emits one
  // image per turn, so a follow-up loop only TOPS UP the shortfall (never over-generates). variants in
  // [1..10]; 1 or absent = single message, no instruction appended, single capture (unchanged).
  const variants = ImageGenLogic.normalizeRunCount(job.variants, 1);
  const aspectLine = aspectInstruction(job.aspect);

  // First message: the full job.prompt, plus the aspect line when set. The "\n" becomes a soft
  // break during typing, so this stays one message. Refs are attached above.
  const refUrls = new Set((job.refs || []).map((r) => r && r.dataUrl).filter(Boolean));
  const baseline = new Set(generatedCandidates().map((candidate) => candidate.src));
  let firstPrompt = job.prompt;
  if (aspectLine) firstPrompt = `${firstPrompt}${aspectLine}`;
  // Ask for N up front (the "\n" becomes a soft break, so it stays ONE message). ChatGPT may render
  // several at once; we capture them all below and top up any shortfall with follow-ups. variants==1
  // appends nothing, so the single-image path is byte-identical.
  if (variants > 1) firstPrompt = `${firstPrompt}\n\nPlease create ${variants} different variations of this in this single reply, output as ${variants} separate images, each a distinct take of the same subject and style. Send all ${variants} images now. Not one combined image, not a single grid.`;
  safeSend({ type: 'lane-status', record: { state: 'typing', name: job.name, jobId: job.id || job.name, adId: job.adId, imageTotal: variants, detail: 'typing prompt' } });
  await typeAndSend(composer, firstPrompt);
  const conversationPath = await waitForConversationPath();

  // `seen` accumulates every generated src we have captured, so each follow-up waits for an image
  // that did not exist before. `images` is the ordered list of dataUrls we return.
  const seen = new Set(baseline);
  const images = [];
  // Capture EVERY image ChatGPT produced in this first reply (up to N), since we asked for N. The
  // first capture returning nothing is the only failure we surface (no images at all).
  safeSend({ type: 'lane-status', record: { state: 'awaiting-image', name: job.name, jobId: job.id || job.name, imageIndex: 1, imageTotal: variants, detail: `waiting for image 1 of ${variants}` } });
  const firstSrcs = await waitForGeneratedImages(baseline, variants);
  for (const src of firstSrcs) {
    seen.add(src);
    const data = await fetchToDataUrl(src);
    if (refUrls.has(data)) continue; // skip an echoed reference image, do not abort the whole job
    images.push(data);
    safeSend({ type: 'lane-status', record: { state: 'captured', name: job.name, jobId: job.id || job.name, imageIndex: images.length, imageTotal: variants, detail: `captured ${images.length} of ${variants}` } });
    if (images.length >= variants) break;
  }
  if (!images.length) throw new Error('no image was generated');
  // Settle so a late render / final-resolution swap is not cut off (longer for multi-variant).
  await abortableWait(variants > 1 ? 2600 : 1400);

  // Follow-up loop = TOP-UP ONLY. The first reply is the primary source of variants; this loop only
  // runs when ChatGPT returned FEWER than N (it sometimes emits one image per turn). It starts at the
  // first MISSING slot (images.length + 1) so it never over-generates past `variants`. Goal: hit
  // EXACTLY `variants` images whenever the session is healthy. We classify each follow-up failure
  // into three kinds:
  //   - abort/'stopped': user stop. Rethrow immediately, never retry.
  //   - hard stop (refusal or rate limit): no point hammering. Stop the loop, keep what we have.
  //   - transient miss ('no image was generated'): a plain no-show. RETRY this same slot up to
  //     SLOT_RETRIES more times (re-send the follow-up, wait again) before counting it failed.
  // We never collect more than `variants`, and the cap below bounds retries per slot.
  const SLOT_RETRIES = 2; // 2 retries == 3 attempts total per slot
  // A failure is "hard" (stop the whole loop) when it is a refusal or a rate-limit. Anything else
  // that is not a stop is treated as a transient miss and retried.
  const isHardStop = (error) => {
    const message = (error && error.message) || '';
    return message === 'ChatGPT refused this prompt' || message === 'ChatGPT reached its image limit';
  };
  const followAspect = aspectLine ? aspectLine.trim() : '16:9.';
  // Start at the first slot the first reply did NOT fill, so a reply that already returned several
  // images is topped up exactly, never over-generated. Each follow-up asks for ONE more distinct take.
  outer: for (let k = images.length + 1; k <= variants; k++) {
    const followUp = `Please send variation ${k} of ${variants} as a separate image now — a distinct take of the same subject, same style. ${followAspect} Just the image.`;
    // Each slot gets 1 base attempt plus SLOT_RETRIES retries. On a transient miss we loop and
    // re-send. On a hard stop we bail the whole follow-up loop. On a stop we rethrow.
    for (let attempt = 0; attempt <= SLOT_RETRIES; attempt++) {
      if (aborted) throw new Error('stopped');
      try {
        safeSend({ type: 'lane-status', record: { state: 'awaiting-image', name: job.name, jobId: job.id || job.name, imageIndex: k, imageTotal: variants, detail: `waiting for image ${k} of ${variants}` } });
        await typeAndSend(composer, followUp); // same chat, no new refs
        const nextSrc = await waitForGeneratedImage(seen); // wait for an image not in `seen`
        if (aborted) throw new Error('stopped');
        seen.add(nextSrc);
        const nextData = await fetchToDataUrl(nextSrc);
        if (refUrls.has(nextData)) throw new Error('captured the reference image, not a generation');
        images.push(nextData);
        safeSend({ type: 'lane-status', record: { state: 'captured', name: job.name, jobId: job.id || job.name, imageIndex: k, imageTotal: variants, detail: `captured ${k} of ${variants}` } });
        continue outer; // slot filled, move to the next one
      } catch (error) {
        if (aborted || (error && error.message === 'stopped')) throw error;
        if (isHardStop(error)) break outer; // refusal or rate limit: keep what we have and stop
        // Transient miss: retry this slot until the cap, then give up on it and stop the loop so
        // we do not spin forever on a slot the model will not fill.
        if (attempt >= SLOT_RETRIES) break outer;
      }
    }
  }
  // Never return more than asked, even if a stray extra image slipped in.
  if (images.length > variants) images.length = variants;
  // Final grace: give a still-rendering last/extra variant a moment before we declare done. Wait
  // longer when we got fewer than asked (a straggler may still be coming).
  await abortableWait(images.length < variants ? 3500 : 1800);

  // Rename is always attempted, even when there is no project (a plain home chat still gets its
  // correct name). Never let a rename failure throw.
  const renamed = await renameChat(conversationPath, job.name).catch(() => false);
  // Verify the project only when we are actually using one. If it was born in-project, confirm
  // it; otherwise move it and confirm the move. When project prep failed (noProject) we skip the
  // move entirely and return moved:false so generation still succeeds. Never claim moved blindly.
  let moved = false;
  if (useProject) {
    moved = conversationInProject(job.project)
      ? true
      : await moveToProject(conversationPath, job.project).catch(() => false);
  }
  // dataUrl stays as images[0] for single-image callers; images[] carries every variant.
  // expected/partial let the bridge + panel mark a short result (M of N) instead of a clean done.
  return { dataUrl: images[0], images, expected: variants, partial: images.length < variants, renamed, moved, conversationPath };
  } finally {
    stopKeepAwake(); // always release the keepalive when the job ends
  }
}

// Bulletproof wrapper: resets transient per-job state, never throws, and never leaves a stuck
// composer for the next job. Any error becomes a clean { ok:false, error } object.
async function safeRunJob(job) {
  aborted = false; // a prior stop must not poison this job
  try {
    const result = await runJob(job);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: (error && error.message) || String(error) };
  } finally {
    // Clear any half-typed prompt so the composer is clean for the next job.
    try {
      const composer = findComposer();
      if (composer && textOf(composer).length) {
        composer.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      }
    } catch {}
    // Dismiss any lingering open menu/dialog that a failed rename/move may have left open.
    try { document.activeElement?.blur?.(); document.body?.click?.(); } catch {}
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ping') { sendResponse({ ok: true, loggedIn: !!document.querySelector('main, [role="main"]'), composer: !!findComposer() }); return; }
  if (message.type === 'ensureProject') { ensureProject(message.project).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message || String(error) })); return true; }
  if (message.type === 'generate') { safeRunJob(message.job).then(sendResponse).catch((error) => sendResponse({ ok: false, error: (error && error.message) || String(error) })); return true; }
  if (message.type === 'abort') { aborted = true; sendResponse({ ok: true }); }
});

function extensionAlive() { try { return !!chrome.runtime?.id; } catch { return false; } }
function safeSend(message) { if (extensionAlive()) chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError); }
const LAUNCHER_TOKEN = String(Date.now()) + Math.random().toString(36).slice(2);
function injectLauncher() {
  if (!document.body) return;
  const present = document.getElementById('sf-launcher');
  if (present) {
    // If it belongs to this (live) content script, leave it. Otherwise it is a dead button
    // left by the pre-reload script: remove it so we can bind a live one.
    if (present.dataset.token === LAUNCHER_TOKEN) return;
    present.remove();
  }
  const button = document.createElement('button');
  button.id = 'sf-launcher';
  button.dataset.token = LAUNCHER_TOKEN;
  button.textContent = 'ImageGen';
  button.title = 'Open ImageGen';
  Object.assign(button.style, { position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483647', padding: '9px 14px', borderRadius: '10px', border: '1px solid rgba(70,155,255,.52)', background: 'linear-gradient(to top, #0752d6 0%, #2892ff 100%)', color: '#fff', fontFamily: '-apple-system,Segoe UI,Roboto,sans-serif', fontSize: '12px', fontWeight: '700', cursor: 'pointer', boxShadow: '0 7px 22px rgba(2,60,170,.42)' });
  button.onclick = () => {
    if (!extensionAlive()) { button.textContent = 'Reload ImageGen'; return; }
    chrome.runtime.sendMessage({ type: 'openPanel' }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        button.textContent = 'Reload ImageGen';
        button.title = 'Reload this ChatGPT page, then try ImageGen again';
      }
    });
  };
  document.body.appendChild(button);
}
injectLauncher();
const observer = new MutationObserver(() => { if (extensionAlive()) injectLauncher(); else observer.disconnect(); });
observer.observe(document.documentElement, { childList: true, subtree: true });
const heartbeat = setInterval(() => { if (!extensionAlive()) { clearInterval(heartbeat); observer.disconnect(); return; } safeSend({ type: 'bridgeTick' }); }, 3000);
