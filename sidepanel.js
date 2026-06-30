const $ = (id) => document.getElementById(id);
let CONFIG = null;
let brand = null;
let batch = null;
let REFS = {};
let panelState = { ads: {} };
// Current ad index for navigation (−1 when no valid ad is selected).
let currentAdIndex = -1;
// Active filter: 'all' | 'recent' | 'pending' | 'failed'.
let activeFilter = 'all';

function nextAdIndex(current) { return Math.max(0, current + 1); }
function prevAdIndex(current) { return Math.max(-1, current - 1); }

// Collapse the previous ad and expand the new one. Persists UI state for each.
function navigateTo(index) {
  if (index < 0 || index >= batch.ads.length) return;
  // Collapse any previously active ad that isn't the target.
  const prev = currentAdIndex >= 0 && currentAdIndex !== index ? currentAdIndex : -1;
  if (prev >= 0) { const pUi = uiState(batch.ads[prev].id); delete pUi.ad; saveState(); }
  // Expand the new ad.
  const nextUi = uiState(batch.ads[index].id);
  nextUi.ad = true;
  saveState();
  currentAdIndex = index;
}

function updateNavButtons() {
  const prevBtn = $('prevAd'), nextBtn = $('nextAd');
  if (batch.ads.length === 0) return;
  const hasMultiple = batch.ads.length > 1;
  if (!hasMultiple) {
    if (prevBtn && !prevBtn.hidden) { prevBtn.hidden = true; }
    if (nextBtn && !nextBtn.hidden) { nextBtn.hidden = true; }
    return;
  }
  // Multiple ads: show buttons, disable at boundaries.
  const firstVisible = $('workflowView').hidden ? false : true;
  if (prevBtn && prevBtn.hidden) { prevBtn.hidden = false; }
  if (nextBtn && nextBtn.hidden) { nextBtn.hidden = false; }
  // Only enable/disable based on currentAdIndex, not position. If no ad has been set yet, buttons are disabled.
  prevBtn.disabled = currentAdIndex === -1 || currentAdIndex === 0;
  nextBtn.disabled = currentAdIndex === -1 || currentAdIndex === batch.ads.length - 1;
}

function focusAd(index) {
  const adList = document.querySelectorAll('#list .ad');
  if (index < 0 || index >= adList.length) return;
  // Remove active from others.
  adList.forEach((el, i) => el.classList.toggle('active', i === index));
  adList[index].focus();
}

function handleAdNav(direction) {
  const next = direction > 0 ? nextAdIndex(currentAdIndex) : prevAdIndex(currentAdIndex);
  if (next >= 0 && next < batch.ads.length) { navigateTo(next); focusAd(next); }
  else if (direction === -1 && currentAdIndex !== 0) { navigateTo(0); focusAd(0); }
}

function bindNav() {
  const prevBtn = $('prevAd'), nextBtn = $('nextAd');
  if (!prevBtn || !nextBtn) return;
  // Click handlers: only fire when the button is not disabled.
  prevBtn.onclick = () => { if (!prevBtn.disabled) handleAdNav(-1); };
  nextBtn.onclick = () => { if (!nextBtn.disabled) handleAdNav(1); };
  // Keyboard: when focused inside an .ad, Left/Right arrows move between them.
  document.querySelectorAll('#list .ad').forEach((el) => {
    el.onkeydown = (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') handleAdNav(-1);
      else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') handleAdNav(1);
    };
  });
}

function render() {
// Aspect ratio for panel-built jobs. 'auto' (the default) is a no-op: content.js leaves the
// prompt ratio-neutral exactly as before. Any other token is passed through as job.aspect and
// content.js appends a single aspect line to the SAME one message. UI-only, not persisted.
let selectedAspect = 'auto';
// Track the last prompt-textarea the user interacted with (for copy-on-click-outside).
let lastPromptTextArea = null;

function copyPromptText() {
  if (!lastPromptTextArea) return;
  const text = lastPromptTextArea.value.trim();
  if (text) {
    navigator.clipboard.writeText(text).catch(() => {}); // swallow permission errors silently
  }
}

const folder = () => `${brand.id}/${batch.code}`;
const storageKey = () => `imagegen-state:${brand.id}:${batch.code}`;

// One project name per run: the timestamp is captured once when a run starts (beginRun),
// so every job queued in that run shares a single uniquely named, timestamped project.
let runProjectName = null;
function runStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function beginRun() {
  // The project name is a clean timestamped string with no version label. All jobs queued in
  // this run share it so ChatGPT groups them correctly, and the output folder path has no
  // "v1" / version text that would clutter filenames or confuse the imagegen tool.
  const base = batch.project || `${brand.name} ${batch.name}`;
  runProjectName = `${base}  ${runStamp()}`;
  return runProjectName;
}
const project = () => runProjectName || beginRun();
const adState = (ad) => (panelState.ads[ad.id] ||= { models: {}, runs: {}, varModel: {}, promptRunCounts: {} });
// Per-prompt edited text, keyed exactly like the run counts (variationId:promptId). When the user
// tweaks a prompt the override lives here; job-build reads it before falling back to config.
const promptEdit = (ad, variation, promptId) => {
  const state = adState(ad);
  const value = (state.promptEdits || {})[promptRunKey(variation, promptId)];
  return typeof value === 'string' ? value : null;
};
// The exact text that will be sent for this prompt: the user's edit if present, else config.
const effectivePrompt = (ad, variation, configPrompt, promptId) => {
  const edited = promptEdit(ad, variation, promptId);
  return edited != null && edited.trim() ? edited : configPrompt;
};
// Per-ad collapse state, persisted across re-renders and reloads, keyed by ad.id.
// `pool` may be undefined so the auto-collapse default (every model picked) can apply
// until the user explicitly toggles it.
const uiState = (adId) => { panelState.ui ||= {}; return (panelState.ui[adId] ||= {}); };
const escape = (value) => String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
const promptRunKey = (variation, promptId) => `${variation.id}:${promptId}`;
// User-friendly ad name using the actual title from config, falling back to a descriptive fallback.
// Displayed in the .mono ID slot of each ad card alongside the type/product sub-label.
const adName = (ad) => `${escape(ad.title || 'Ad')}_${batch.code}`;
// Friendly "Model N" label from an m1/m2/m3 id. The id stays the data value; only the text changes.
const modelLabel = (id) => /^m(\d+)$/i.test(String(id)) ? `Model ${String(id).slice(1)}` : String(id);
// Which variation letter this model is the face for (brief mapping A->m1, B->m2, C->m3 via variation.model).
const modelVariationLetter = (ad, modelId) => {
  const variation = (ad.variations || []).find((item) => (item.model || 'm1') === modelId);
  return variation ? variation.id : null;
};
// Default candidate count when generating a model's options. Picking the best of two is the point.
const MODEL_CANDIDATE_DEFAULT = 2;
// Default run/variant count per prompt. Matches logic.js defaultRunCount() so the panel defaults
// to 2 variants per prompt. Stays in the 1..10 range; the per-prompt UI override still works.
const PROMPT_RUN_DEFAULT = ImageGenLogic.defaultRunCount();
// Normalize any stored model slot (including the legacy single-image shape) to candidates+picked.
function modelCandidates(slot) {
  if (!slot) return { candidates: {}, picked: null };
  if (slot.candidates) {
    return { candidates: { ...slot.candidates }, picked: slot.picked ?? null };
  }
  // Legacy shape { dataUrl, status, attempt }: treat as candidate run 1, picked 1.
  if (slot.dataUrl) {
    return { candidates: { 1: { status: slot.status || 'done', dataUrl: slot.dataUrl, error: null } }, picked: 1 };
  }
  return { candidates: {}, picked: null };
}
// The picked candidate's image for a model, used by variations. Null until one is done.
// Falls back to ensurePicked so a completed-but-unpicked candidate (e.g. from loaded state)
// still unblocks variations instead of staying invisible to the generation gate.
function pickedModelImage(state, modelId) {
  const slot = modelCandidates(state.models[modelId]);
  const run = slot.picked != null && slot.candidates[slot.picked]?.dataUrl ? slot.picked : ensurePicked(slot);
  const candidate = run != null ? slot.candidates[run] : null;
  return candidate?.dataUrl || null;
}
// True once every model in a face ad has a picked, completed candidate (pool is "done").
function allModelsPicked(ad) {
  if (ad.kind !== 'face' || !ad.models?.length) return false;
  const state = adState(ad);
  return ad.models.every((model) => pickedModelImage(state, model.id));
}
// Whether the model pool starts collapsed: user choice wins, else auto-collapse when done.
function poolCollapsed(ad) {
  const ui = uiState(ad.id);
  return ui.pool != null ? ui.pool : allModelsPicked(ad);
}
// Default picked to the first completed candidate if none chosen yet.
function ensurePicked(slot) {
  if (slot.picked != null && slot.candidates[slot.picked]?.dataUrl) return slot.picked;
  const firstDone = Object.keys(slot.candidates)
    .map(Number).sort((a, b) => a - b)
    .find((run) => slot.candidates[run]?.dataUrl);
  return firstDone ?? null;
}

async function fetchAsDataUrl(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
}

async function loadRefs() {
  // Base product/face refs plus any extraRefs an ad declares (e.g. claytexture), so the
  // panel actually attaches the texture image instead of silently skipping it.
  const assetKeys = new Set(['mousse', 'saltspray', 'texturepowder', 'clay', 'face', 'nanox']);
  const feelwavyRefs = new Set();
  for (const brandItem of CONFIG.brands) {
    for (const batchItem of brandItem.batches) {
      for (const ad of batchItem.ads) {
        if (ad.ref) feelwavyRefs.add(ad.ref);
        for (const key of ad.extraRefs || []) assetKeys.add(key);
      }
    }
  }
  for (const key of assetKeys) {
    try { REFS[key] = await fetchAsDataUrl(chrome.runtime.getURL(`assets/${key}.png`)); } catch {}
  }
  for (const file of feelwavyRefs) {
    try { REFS[file] = await fetchAsDataUrl(chrome.runtime.getURL(`assets/refs/${file}`)); } catch {}
  }
}

async function loadState() {
  const stored = await chrome.storage.local.get(storageKey());
  panelState = stored[storageKey()] || { ads: {} };
  await mergePersistedPreviews();
}

// Merge previews the BACKGROUND persisted (as 'preview:<relPath>' entries) into panelState, so
// images generated while this panel was CLOSED (a long auto-resumed run, or before a reload/restart)
// still show up — including Codex images, which arrive the same way. Keyed by the stable relative
// path and matched to the current brand/batch via ImageGenLogic.parseRelPath.
//
// We never overwrite on disk; instead the same run slot accumulates versions (run-2.png,
// run-2-v2.png, ...). All versions of a run map to the SAME base run slot (built from run, not
// version), and the panel shows the HIGHEST version per slot. We track the chosen version on the
// slot as `_version` so a later/earlier entry can be compared, and only a strictly-or-equally higher
// version replaces what is shown. A slot panelState already has from a live run is preserved unless a
// higher persisted version should win.
async function mergePersistedPreviews() {
  if (!brand || !batch) return;
  try {
    // Never load the ENTIRE store (get(null)) — with ~150MB of previews that OOMs the renderer.
    // Enumerate keys cheaply, filter to THIS brand/batch's preview prefix, and load only those values.
    const prefix = `preview:${brand.id}/${batch.code}/`;
    let all;
    if (typeof chrome.storage.local.getKeys === 'function') {
      const keys = await chrome.storage.local.getKeys();
      const wanted = keys.filter((key) => key.startsWith(prefix));
      all = wanted.length ? await chrome.storage.local.get(wanted) : {};
    } else {
      // Older Chrome without getKeys(): a background-maintained index lists the preview keys, so we
      // still avoid get(null). The index value is an array of full 'preview:<relPath>' keys.
      const indexKey = `preview-index:${brand.id}/${batch.code}`;
      const indexWrap = await chrome.storage.local.get(indexKey);
      const index = Array.isArray(indexWrap[indexKey]) ? indexWrap[indexKey] : [];
      const wanted = index.filter((key) => typeof key === 'string' && key.startsWith(prefix));
      all = wanted.length ? await chrome.storage.local.get(wanted) : {};
    }
    for (const [key, dataUrl] of Object.entries(all)) {
      if (!key.startsWith('preview:') || !dataUrl) continue;
      const rel = key.slice('preview:'.length);
      const parsed = ImageGenLogic.parseRelPath(rel);
      if (!parsed) continue;
      // Only previews for the current brand/batch land in these slots.
      if (parsed.brand !== brand.id || parsed.batch !== batch.code) continue;
      // Map every version of this run to its BASE run slot (run, NOT version).
      const identity = ImageGenLogic.finalJobIdentity({ brand: brand.id, batch: batch.code, ad: parsed.ad, variation: parsed.variation, prompt: parsed.prompt, run: parsed.run });
      const state = adState({ id: parsed.ad });
      const prev = state.runs[identity.key];
      // Keep the highest version per slot. A slot already showing an image (live run or an earlier
      // merged entry) is only replaced by a version >= the one it is currently showing. A slot with
      // no image yet always takes this one.
      const shownVersion = (prev && prev.dataUrl) ? (prev._version || 1) : -Infinity;
      if (parsed.version < shownVersion) continue;
      state.runs[identity.key] = {
        ...(prev || {}),
        status: 'done',
        dataUrl,
        variation: parsed.variation,
        promptId: parsed.prompt,
        run: parsed.run,
        modelId: (prev && prev.modelId) || null,
        error: null,
        _version: parsed.version,
      };
    }
  } catch (err) {
    console.error('[ImageGen] mergePersistedPreviews failed:', err);
  }
}
// Persist the panel state (including base64 dataURL previews) to chrome.storage.local. With the
// "unlimitedStorage" permission this is no longer bounded by the ~10MB quota that used to make this
// fail silently and lose every preview on reload. We still check for a write failure (quota or
// otherwise) and log it loudly so a regression is visible instead of silently dropping the cache.
// This never clears or shrinks what is saved — it only writes the current panelState as-is.
function saveState() {
  try {
    const result = chrome.storage.local.set({ [storageKey()]: panelState }, () => {
      if (chrome.runtime.lastError) {
        console.error('[ImageGen] saveState failed to persist previews:', chrome.runtime.lastError.message || chrome.runtime.lastError);
      }
    });
    // MV3 also returns a promise; catch a rejection so a quota/write failure is never swallowed.
    if (result && typeof result.catch === 'function') {
      result.catch((err) => console.error('[ImageGen] saveState failed to persist previews:', err));
    }
  } catch (err) {
    console.error('[ImageGen] saveState threw while persisting previews:', err);
  }
}

function modelJob(ad, model, run) {
  const identity = ImageGenLogic.modelJobIdentity({ brand: brand.id, batch: batch.code, ad: ad.id, model: model.id, run });
  return { ...identity, kind: 'model', adId: ad.id, modelId: model.id, run, name: identity.name, prompt: model.prompt, refs: REFS.face ? [{ dataUrl: REFS.face, name: 'face.png' }] : [], project: project() };
}
// Build candidate jobs for runs 1..count that are not already complete.
function modelJobs(ad, model, count) {
  const slot = modelCandidates(adState(ad).models[model.id]);
  const jobs = [];
  for (let run = 1; run <= count; run += 1) {
    if (slot.candidates[run]?.dataUrl) continue;
    jobs.push(modelJob(ad, model, run));
  }
  return jobs;
}
// Selected candidate count for a model (defaults to MODEL_CANDIDATE_DEFAULT).
function selectedModelCount(ad, modelId) {
  const state = adState(ad);
  state.modelCounts ||= {};
  return ImageGenLogic.normalizeRunCount(state.modelCounts[modelId], MODEL_CANDIDATE_DEFAULT);
}

function selectedModel(ad, variation) {
  const state = adState(ad);
  return state.varModel[variation.id] || variation.model || 'm1';
}

function selectedPromptRunCount(ad, variation, promptId) {
  const state = adState(ad);
  state.promptRunCounts ||= {};
  return ImageGenLogic.normalizeRunCount(state.promptRunCounts[promptRunKey(variation, promptId)], PROMPT_RUN_DEFAULT);
}

function selectedPromptRunCounts(ad, variation) {
  return Object.fromEntries(ImageGenLogic.promptEntries(variation).map((entry) => [entry.promptId, selectedPromptRunCount(ad, variation, entry.promptId)]));
}

function variationJobs(ad, variation, onlyPromptId = null, options = {}) {
  const modelId = selectedModel(ad, variation);
  const state = adState(ad);
  // Subject is image 1: model face for face ads, product for product ads.
  let refs = [];
  if (ad.kind === 'face') {
    const dataUrl = pickedModelImage(state, modelId);
    if (!dataUrl) return [];
    refs = [{ dataUrl, name: `${modelId}.png` }];
  } else if (REFS[ad.product]) {
    refs = [{ dataUrl: REFS[ad.product], name: `${ad.product}.png` }];
  }
  // Dedupe as we build so we never queue the same image twice (e.g. product == subject, or a
  // layout/extra ref equal to one already added). content.js also dedupes on upload; this just
  // avoids building obvious duplicates. Keys mirror that scheme: the bytes and the lowercased name.
  const seenRefs = new Set();
  const addRef = (ref) => {
    if (!ref || !ref.dataUrl || refs.length >= 4) return;
    const urlKey = `url:${ref.dataUrl}`;
    const nameKey = ref.name ? `name:${String(ref.name).trim().toLowerCase()}` : null;
    if (seenRefs.has(urlKey) || (nameKey && seenRefs.has(nameKey))) return;
    seenRefs.add(urlKey);
    if (nameKey) seenRefs.add(nameKey);
    refs.push(ref);
  };
  for (const ref of refs.splice(0)) addRef(ref);
  // The ad's feelwavy layout reference is image 2.
  if (ad.ref && REFS[ad.ref]) {
    addRef({ dataUrl: REFS[ad.ref], name: ad.ref });
  }
  // Optional extra references in order, up to 4 images total.
  if (Array.isArray(ad.extraRefs)) {
    for (const key of ad.extraRefs) {
      if (REFS[key]) addRef({ dataUrl: REFS[key], name: key });
    }
  }
  // One job per prompt. The selected run count N becomes variants:N (N images in one chat).
  const runCounts = selectedPromptRunCounts(ad, variation);
  return ImageGenLogic.promptEntries(variation)
    .filter((entry) => !onlyPromptId || entry.promptId === onlyPromptId)
    .map((entry) => {
      const count = ImageGenLogic.normalizeRunCount(runCounts[entry.promptId], PROMPT_RUN_DEFAULT);
      const identityFor = (run) => ImageGenLogic.finalJobIdentity({ brand: brand.id, batch: batch.code, ad: ad.id, variation: variation.id, prompt: entry.promptId, run });
      const variantPaths = Array.from({ length: count }, (_, index) => identityFor(index + 1).relativePath);
      // When only generating what is missing, drop variants whose run slot already finished.
      if (options.onlyMissing) {
        const allDone = Array.from({ length: count }, (_, index) => identityFor(index + 1).key)
          .every((key) => ImageGenLogic.runSlotComplete(state.runs[key]));
        if (allDone) return null;
      }
      const base = identityFor(1);
      // Use the user's edited prompt if one exists for this prompt, else the config brief.
      const prompt = effectivePrompt(ad, variation, entry.prompt, entry.promptId);
      return { ...base, kind: 'final', adId: ad.id, variationId: variation.id, promptId: entry.promptId, modelId, run: 1, prompt, refs, project: project(), variants: count, variantPaths, aspect: selectedAspect };
    })
    .filter(Boolean);
}

function send(jobs, emptyMessage = 'Generate a model first before making its testimonial images.') {
  if (!jobs.length) { showError(emptyMessage); return; }
  setRunning(true);
  chrome.runtime.sendMessage({ type: 'run', jobs, folder: folder() }, (response) => {
    if (response && !response.ok) { setRunning(false); showError(response.error); }
  });
}

function showError(message) { $('error').textContent = message || ''; }
function setFlow(message) { $('flowState').textContent = message; }
// While a run is active the action bar swaps Generate for Stop, so the loud red control only
// exists when there is something to stop. Idle shows just Generate + Reset.
function setRunning(active) { const actions = document.querySelector('.actions'); if (actions) actions.classList.toggle('running', !!active); }
function openPreview(src) { $('previewImage').src = src; $('preview').classList.add('open'); }

function fillSelectors() {
  $('brandSel').innerHTML = CONFIG.brands.map((item) => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('');
  $('brandSel').value = brand.id;
  $('batchSel').innerHTML = brand.batches.map((item) => `<option value="${escape(item.code)}">${escape(item.name)}</option>`).join('');
  $('batchSel').value = batch.code;
  // One calm line: where files land, plus the build number tucked at the far end so it is present
  // but never competes. The project name is implied by the brand/batch selectors above, so it is
  // dropped here rather than repeated. Build number reads from the manifest (single source).
  const build = (chrome.runtime.getManifest?.().version) || '';
  const buildTag = build ? `<span class="build">Build ${escape(build)}</span>` : '';
  $('destination').innerHTML = `<code>${escape(folder())}/</code>${buildTag}`;
}

function modelCard(ad, model) {
  const state = adState(ad);
  const slot = modelCandidates(state.models[model.id]);
  const picked = ensurePicked(slot);
  const label = modelLabel(model.id);
  const letter = modelVariationLetter(ad, model.id);
  const hint = letter ? ` <span class="slot-hint">${escape(letter)}</span>` : '';
  const count = selectedModelCount(ad, model.id);
  const countOptions = ImageGenLogic.runCountOptions().map((value) => `<option value="${value}"${value === count ? ' selected' : ''}>${value}</option>`).join('');
  // One thumbnail per candidate run 1..count, reusing the run-slot styling.
  const thumbs = Array.from({ length: count }, (_, index) => {
    const run = index + 1;
    const candidate = slot.candidates[run];
    const status = candidate?.status || '';
    const isPicked = picked === run ? ' picked' : '';
    const rerun = (status === 'error' || status === 'missing')
      ? ` data-rerun-model="${escape(ad.id)}" data-model="${escape(model.id)}" role="button" tabindex="0" title="Re-run this model"`
      : '';
    const inner = candidate?.dataUrl
      ? `<img loading="lazy" decoding="async" data-pick-model="${escape(ad.id)}" data-model="${escape(model.id)}" data-run="${run}" src="${candidate.dataUrl}" alt="${escape(label)} candidate ${run}">`
      : `<div class="run-empty"${rerun}><span class="rn">${run}</span></div>`;
    // No per-thumb index caption: the number already lives inside an empty slot, and a done
    // candidate needs no label. Picked is shown by the accent ring/check.
    return `<div class="run${escape(status ? ' ' + status : '')}${isPicked}">${inner}</div>`;
  }).join('');
  // An uploaded photo lives at candidate run 0 (sentinel that never collides with generated 1..N).
  // Show it first so the user sees their own model and that it is the picked candidate. It keeps a
  // "yours" tag because that distinction is meaningful, unlike a generic run index.
  const uploaded = slot.candidates[0];
  const uploadedThumb = uploaded?.dataUrl
    ? `<div class="run done${picked === 0 ? ' picked' : ''}"><img data-pick-model="${escape(ad.id)}" data-model="${escape(model.id)}" data-run="0" src="${uploaded.dataUrl}" alt="${escape(label)} uploaded photo"><span class="run-tag">yours</span></div>`
    : '';
  // Upload your own model photo: reads the file as a dataURL and stores it as this slot's picked
  // candidate, so variations use it through the same pickedModelImage path. Label wraps a hidden
  // file input so it reads as a quiet micro button.
  const upload = `<label class="micro model-upload" title="Use your own photo for this model">Upload<input type="file" accept="image/*" data-upload-model="${escape(ad.id)}" data-model="${escape(model.id)}"></label>`;
  return `<div class="model"><div class="model-tools"><span class="slot-label">${escape(label)}${hint}</span><span class="model-acts"><select class="run-count" data-model-count="${escape(ad.id)}" data-model="${escape(model.id)}">${countOptions}</select>${upload}<button class="micro accent" data-gen-model="${escape(ad.id)}" data-model="${escape(model.id)}">Generate</button><button class="micro" data-reset-model="${escape(ad.id)}" data-model="${escape(model.id)}">Reset</button></span></div><div class="model-cands">${uploadedThumb}${thumbs}</div></div>`;
}

function promptBlock(ad, variation, promptId, promptLabel, configPrompt) {
  const state = adState(ad);
  const count = selectedPromptRunCount(ad, variation, promptId);
  const countOptions = ImageGenLogic.runCountOptions().map((value) => `<option value="${value}"${value === count ? ' selected' : ''}>${value}</option>`).join('');
  // Prompt disclosure: the exact text that will be sent, editable. Edited overrides config at
  // job-build time (see effectivePrompt). The textarea shows the edit if present, else config.
  const edited = promptEdit(ad, variation, promptId);
  const isEdited = edited != null && edited.trim() !== '';
  const shownPrompt = isEdited ? edited : configPrompt;
  const discOpen = uiState(ad.id).prompts && uiState(ad.id).prompts[promptRunKey(variation, promptId)];
  const discClosed = discOpen ? '' : ' collapsed';
  const editedDot = isEdited ? '<span class="edited-dot"></span>' : '';
  const noteText = isEdited ? 'Edited. This is what gets sent.' : 'From the brief.';
  const noteClass = isEdited ? ' is-edited' : '';
  const resetBtn = isEdited
    ? `<button class="micro" data-reset-prompt-text="${escape(ad.id)}" data-variation="${escape(variation.id)}" data-prompt="${escape(promptId)}">Reset to brief</button>`
    : '';
  const disclosure = `<div class="prompt-edit-toggle" role="button" tabindex="0" data-toggle-prompt="${escape(ad.id)}" data-variation="${escape(variation.id)}" data-prompt="${escape(promptId)}"><span class="chev"></span>prompt${editedDot}</div><div class="prompt-disc${discClosed}"><textarea class="prompt-text mono" spellcheck="false" data-prompt-text="${escape(ad.id)}" data-variation="${escape(variation.id)}" data-prompt="${escape(promptId)}">${escape(shownPrompt)}</textarea><div class="prompt-disc-foot"><span class="prompt-disc-note${noteClass}">${escape(noteText)}</span>${resetBtn}</div></div>`;
  const runs = ImageGenLogic.promptRuns(variation, { runCounts: { [promptId]: count } }).filter((run) => run.promptId === promptId);
  const runSlots = runs.map((run) => {
    const identity = ImageGenLogic.finalJobIdentity({ brand: brand.id, batch: batch.code, ad: ad.id, variation: variation.id, prompt: run.promptId, run: run.run });
    const item = state.runs[identity.key];
    const status = item?.status || '';
    // Error and missing slots are re-runnable: clicking the placeholder re-queues just this prompt.
    const rerun = (status === 'error' || status === 'missing')
      ? ` data-rerun-prompt="${escape(ad.id)}" data-variation="${escape(variation.id)}" data-prompt="${escape(promptId)}" role="button" tabindex="0" title="Re-run this prompt"`
      : '';
    const thumbnail = item?.dataUrl
      ? `<img loading="lazy" decoding="async" data-preview="${item.dataUrl}" src="${item.dataUrl}" alt="${escape(variation.id)} ${escape(promptId)} run ${run.run}">`
      : `<div class="run-empty"${rerun}><span class="rn">${run.run}</span></div>`;
    // No per-thumb r# caption: the slot number lives inside an empty slot, and finished thumbs
    // read on their own. Drops a line of repeated noise under every run row.
    return `<div class="run ${escape(status)}">${thumbnail}</div>`;
  }).join('');
  // The per-prompt Generate is a secondary action: the clear primary per variation is "Run N" on
  // the variation head, which fires every prompt. So this one stays a quiet .mini (no accent) and
  // the count select reads as a small "xN" multiplier beside it, not a second loud control.
  return `<div class="prompt"><div class="prompt-head"><span class="prompt-name">${escape(promptLabel)}</span><span class="prompt-actions"><select class="run-count" data-run-count="${escape(ad.id)}" data-variation="${escape(variation.id)}" data-prompt="${escape(promptId)}">${countOptions}</select><button class="mini" data-gen-prompt="${escape(ad.id)}" data-variation="${escape(variation.id)}" data-prompt="${escape(promptId)}">Generate</button></span></div>${disclosure}<div class="run-slots">${runSlots}</div></div>`;
}

function variationCard(ad, variation) {
  const isFace = ad.kind === 'face';
  const modelControl = isFace ? `<select class="model-select" data-model-select="${escape(ad.id)}" data-variation="${escape(variation.id)}">${ad.models.map((model) => `<option value="${escape(model.id)}">${escape(modelLabel(model.id))}</option>`).join('')}</select>` : '';
  const promptGroups = ImageGenLogic.promptEntries(variation).map((entry) => ({ id: entry.promptId, label: entry.promptLabel, prompt: entry.prompt }));
  const totalRuns = promptGroups.reduce((sum, group) => sum + selectedPromptRunCount(ad, variation, group.id), 0);
  // The brief: the ad's own message (variation.copy), shown quiet and read-only so the user sees
  // what the ad is about while editing prompts. The copy reads as a quote on its own (thin left
  // rule, no "BRIEF" label), so it does not add a competing micro-label. Only when copy exists.
  const brief = variation.copy ? `<div class="brief"><span class="brief-copy">${escape(variation.copy)}</span></div>` : '';
  return `<section class="variation"><div class="variation-head"><span class="letter mono">${escape(variation.id)}</span><span class="variation-name">${escape(variation.label)}</span>${modelControl}<span class="variation-acts"><button class="mini accent" data-gen-variation="${escape(ad.id)}" data-variation="${escape(variation.id)}">Run ${totalRuns}</button><button class="mini" data-reset-variation="${escape(ad.id)}" data-variation="${escape(variation.id)}">Reset</button></span></div>${brief}${promptGroups.map((group) => promptBlock(ad, variation, group.id, group.label, group.prompt)).join('')}</section>`;
}

// Tally every expected slot across the batch (model candidates + variation run slots) into
// done / generating / error / queued, so the header bar reflects real panel state at a glance.
function batchProgress() {
  let done = 0, generating = 0, error = 0, queued = 0;
  const tally = (status, hasImage) => {
    if (hasImage || status === 'done') done += 1;
    else if (status === 'generating') generating += 1;
    else if (status === 'error') error += 1;
    else queued += 1; // empty, missing, or never started
  };
  for (const ad of batch.ads) {
    const state = adState(ad);
    if (ad.kind === 'face') {
      for (const model of ad.models || []) {
        const slot = modelCandidates(state.models[model.id]);
        const count = selectedModelCount(ad, model.id);
        for (let run = 1; run <= count; run += 1) {
          const cand = slot.candidates[run];
          tally(cand?.status || '', !!cand?.dataUrl);
        }
      }
    }
    for (const variation of ad.variations || []) {
      for (const entry of ImageGenLogic.promptEntries(variation)) {
        const count = selectedPromptRunCount(ad, variation, entry.promptId);
        for (let run = 1; run <= count; run += 1) {
          const identity = ImageGenLogic.finalJobIdentity({ brand: brand.id, batch: batch.code, ad: ad.id, variation: variation.id, prompt: entry.promptId, run });
          const item = state.runs[identity.key];
          tally(item?.status || '', !!item?.dataUrl);
        }
      }
    }
  }
  return { done, generating, error, queued, total: done + generating + error + queued };
}

function updateProgress() {
  const p = batchProgress();
  const wrap = $('progress');
  if (!wrap) return;
  // Show the bar once there is anything to act on (always, given a batch). Hide only if empty.
  wrap.hidden = p.total === 0;
  const pct = (n) => p.total ? `${(n / p.total) * 100}%` : '0%';
  const donePct = p.total ? (p.done / p.total) * 100 : 0;
  const genPct = p.total ? (p.generating / p.total) * 100 : 0;
  const errPct = p.total ? (p.error / p.total) * 100 : 0;
  $('barDone').style.width = `${donePct}%`;
  $('barGen').style.left = `${donePct}%`;
  $('barGen').style.width = `${genPct}%`;
  $('barErr').style.left = `${donePct + genPct}%`;
  $('barErr').style.width = `${errPct}%`;
  $('pgDone').textContent = p.done;
  $('pgGen').textContent = p.generating;
  $('pgIdle').textContent = p.queued;
  $('pgErr').textContent = p.error;
  $('pgErrWrap').classList.toggle('zero', p.error === 0);
}

function render() {
  // Search + filter: compute matched ads once and apply both text search and status filter.
  const q = ($('adSearch')?.value || '').toLowerCase().trim();
  const filteredAds = getFilteredAds(batch.ads, q, activeFilter);

  function hasPendingRuns(ad) {
    const state = panelState.ads[ad.id] || {};
    for (const variation of ad.variations || []) {
      for (const entry of ImageGenLogic.promptEntries(variation)) {
        const runs = Object.values(state.runs || {})
          .filter((r) => r && r.variationId === variation.id && r && r.promptId === entry.promptId);
        if (!runs.length) return true; // never started → pending
      }
    }
    if (ad.kind === 'face') {
      const models = Object.values(state.models || {});
      if (models.some((m) => !m)) return true;
    }
    return false;
  }

  function hasFailedRuns(ad) {
    for (const variation of ad.variations || []) {
      for (const entry of ImageGenLogic.promptEntries(variation)) {
        const runs = Object.values(panelState.ads[ad.id]?.runs || {})
          .filter((r) => r && r.variationId === variation.id && r && r.promptId === entry.promptId);
        if (!runs.length) return false;
        if (runs.some((r) => r.status === 'error')) return true;
      }
    }
    if (ad.kind === 'face') {
      const models = Object.values(panelState.ads[ad.id]?.models || {});
      if (models.some((m) => !m || m.candidates && Object.values(m.candidates).some((c) => c?.status === 'error'))) return true;
    }
    return false;
  }

  function getFilteredAds(ads, searchQuery, filter) {
    let result = ads.filter((ad) => {
      switch (filter) {
        case 'recent':
          const mt = adState(ad).updatedAt || Date.now() - 3600000;
          return Date.now() - mt < 3600000;
        case 'pending':
          return hasPendingRuns(ad);
        case 'failed':
          return hasFailedRuns(ad);
        default:
          return true;
      }
    });

    if (searchQuery && filter !== 'all') {
      const haystack = [searchQuery].join(' ').toLowerCase();
      result = result.filter((ad) => {
        const hay = [ad.id, ad.title || '', ad.product, ...(ad.variations || []).map(v => v.label)].join(' ').toLowerCase();
        return hay.includes(searchQuery);
      });
    }

    return result;
  }

  // No-results message when search narrows to nothing.
  const showNoResults = (q) => q ? `<div class="no-results-msg">${escape(q)}</div>` : '';

  const list = $('list');
  list.innerHTML = filteredAds.map((ad, index) => {
    const face = ad.kind === 'face';
    // The thumbnail is always the real product, since the ad is about that product.
    const productImg = `assets/${escape(ad.product)}.png`;
    const ui = uiState(ad.id);
    const adCollapsed = ui.ad ? ' collapsed' : '';
    // Model pool subsection (face ads only). Its header is the fold toggle; the
    // "Generate missing" action sits in the header but stops the toggle (data-stop).
    const poolClosed = poolCollapsed(ad) ? ' collapsed' : '';
    const modelPhase = face ? `<section class="section${poolClosed}"><div class="section-head" role="button" tabindex="0" data-toggle-pool="${escape(ad.id)}"><span class="chev"></span><span class="section-title">Model pool</span><button class="mini accent" data-gen-missing-models="${escape(ad.id)}" data-stop>Generate missing</button></div><div class="section-body"><div class="models">${ad.models.map((model) => modelCard(ad, model)).join('')}</div></div></section>` : '';
    // Face ads keep a labeled, foldable "Variations" section (it pairs with the Model pool above).
    // Product ads (NanoX, educational) have no pool and no steps, so their variations render straight
    // into the body with no section chrome wrapping the one and only thing the card holds.
    const variationCards = ad.variations.map((variation) => variationCard(ad, variation)).join('');
    let variationsSection;
    if (face) {
      const varsClosed = ui.vars ? ' collapsed' : '';
      variationsSection = `<section class="section${varsClosed}"><div class="section-head" role="button" tabindex="0" data-toggle-vars="${escape(ad.id)}"><span class="chev"></span><span class="section-title">Variations</span></div><div class="section-body">${variationCards}</div></section>`;
    } else {
      variationsSection = `<div class="vars-bare">${variationCards}</div>`;
    }
    // The two foldable sections (Model pool, then Variations) already are the guided steps, so no
    // separate "1 Models . 2 Pick . 3 Variations" cue is drawn. It only restated the structure
    // below it and added a third line to every testimonial header.
    const adEl = `<article class="ad${adCollapsed}${currentAdIndex === index ? ' active' : ''}" data-icon-entrance><div class="ad-head" role="button" tabindex="0" data-toggle-ad="${escape(ad.id)}"><span class="chev"></span><span class="ref-button icon-lg" role="button" tabindex="0" data-preview="${productImg}"><img src="${productImg}" alt="${escape(ad.product)} product"></span><span class="ad-meta"><span class="ad-name mono">${escape(adName(ad))}</span><span class="ad-sub"><span class="ad-type">${escape(ad.title || ad.product)}<span class="ad-dot">·</span>${escape(ad.type)}</span></span></span></div><div class="ad-body">${modelPhase}${variationsSection}</div></article>`;
    // Nav arrow between ads (omitted after the last one).
    if (index < batch.ads.length - 1) {
      adEl += `<button class="ad-nav-arrow" data-prev-ad="${escape(ad.id)}" aria-label="Previous ad">‹</button> `;
    }
    return adEl;
  }).join('');
  // Search input: filter ads as the user types.
  $('adSearch').oninput = (event) => { render(); };

  // Filter chips: activeFilter filters ads by status.
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.onclick = () => {
      activeFilter = chip.dataset.filter;
      // Update visual state of all filter chips
      document.querySelectorAll('.filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
      render();
    };
  });

  // Wire nav arrow clicks: each arrow sits between two ads; clicking it calls handleAdNav(-1).
  document.querySelectorAll('.ad-nav-arrow').forEach((arrow) => {
    if (!arrow.closest('#list')) return;
    arrow.onclick = () => handleAdNav(-1);
  });
  batch.ads.filter((ad) => ad.kind === 'face').forEach((ad) => ad.variations.forEach((variation) => {
    const select = document.querySelector(`[data-model-select="${CSS.escape(ad.id)}"][data-variation="${CSS.escape(variation.id)}"]`);
    if (select) select.value = selectedModel(ad, variation);
  }));
  updateProgress();
  updateNavButtons();
  // Auto-expand the first ad if none is active yet.
  if (currentAdIndex === -1 && batch.ads.length > 0) { navigateTo(0); focusAd(0); }
}

function bind() {
  // Fold toggles. The product thumbnail and the header action buttons live inside the
  // toggle, so they call stopPropagation (via data-preview / data-stop handlers below).
  document.querySelectorAll('[data-toggle-ad]').forEach((button) => button.onclick = () => {
    const ui = uiState(button.dataset.toggleAd);
    ui.ad = !ui.ad;
    saveState();
    render();
  });
  document.querySelectorAll('[data-toggle-pool]').forEach((button) => button.onclick = () => {
    const ad = batch.ads.find((item) => item.id === button.dataset.togglePool);
    const ui = uiState(button.dataset.togglePool);
    // Flip relative to whatever is showing now, then remember the explicit choice.
    ui.pool = !poolCollapsed(ad);
    saveState();
    render();
  });
  document.querySelectorAll('[data-toggle-vars]').forEach((button) => button.onclick = () => {
    const ui = uiState(button.dataset.toggleVars);
    ui.vars = !ui.vars;
    saveState();
    render();
  });
  // The fold toggles are div[role=button]; mirror native button keyboard behavior.
  document.querySelectorAll('[data-toggle-ad],[data-toggle-pool],[data-toggle-vars]').forEach((element) => element.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); element.click(); }
  });
  // Buttons nested inside a fold toggle must not also toggle the fold.
  document.querySelectorAll('[data-stop]').forEach((element) => element.addEventListener('click', (event) => event.stopPropagation()));
  document.querySelectorAll('[data-preview]').forEach((element) => element.onclick = (event) => { event.stopPropagation(); openPreview(element.dataset.preview); });
  document.querySelectorAll('.ref-button[data-preview]').forEach((element) => element.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPreview(element.dataset.preview); }
  });
  document.querySelectorAll('[data-gen-model]').forEach((button) => button.onclick = () => {
    const ad = batch.ads.find((item) => item.id === button.dataset.genModel);
    const model = ad.models.find((item) => item.id === button.dataset.model);
    beginRun();
    send(modelJobs(ad, model, selectedModelCount(ad, model.id)), 'These candidates are already generated.');
  });
  document.querySelectorAll('[data-model-count]').forEach((select) => select.onchange = () => {
    const ad = batch.ads.find((item) => item.id === select.dataset.modelCount);
    const state = adState(ad);
    state.modelCounts ||= {};
    state.modelCounts[select.dataset.model] = ImageGenLogic.normalizeRunCount(select.value, MODEL_CANDIDATE_DEFAULT);
    saveState();
    render();
  });
  document.querySelectorAll('[data-pick-model]').forEach((image) => image.onclick = () => {
    const ad = batch.ads.find((item) => item.id === image.dataset.pickModel);
    const state = adState(ad);
    const slot = state.models[image.dataset.model];
    if (!slot) return;
    const normalized = modelCandidates(slot);
    state.models[image.dataset.model] = { candidates: normalized.candidates, picked: Number(image.dataset.run) };
    saveState();
    render();
  });
  document.querySelectorAll('[data-reset-model]').forEach((button) => button.onclick = () => {
    const ad = batch.ads.find((item) => item.id === button.dataset.resetModel);
    Object.assign(adState(ad), ImageGenLogic.resetModel(adState(ad), button.dataset.model));
    saveState(); render();
  });
  // Upload your own model photo. Read the file as a dataURL and store it as this slot's picked
  // candidate (candidate run 0, a sentinel that never collides with generated runs 1..N), so
  // pickedModelImage returns it and variations use the user's own model. Persisted in panelState.
  document.querySelectorAll('[data-upload-model]').forEach((input) => input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const ad = batch.ads.find((item) => item.id === input.dataset.uploadModel);
    if (!ad) return;
    const modelId = input.dataset.model;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (!dataUrl) return;
      const state = adState(ad);
      const slot = modelCandidates(state.models[modelId]);
      slot.candidates[0] = { status: 'done', dataUrl, error: null, uploaded: true };
      state.models[modelId] = { candidates: slot.candidates, picked: 0 };
      saveState();
      render();
    };
    reader.readAsDataURL(file);
  });
  document.querySelectorAll('[data-gen-missing-models]').forEach((button) => button.onclick = () => {
    const ad = batch.ads.find((item) => item.id === button.dataset.genMissingModels);
    beginRun();
    const jobs = ad.models.flatMap((model) => modelJobs(ad, model, selectedModelCount(ad, model.id)));
    send(jobs, 'Every model already has its candidates.');
  });
  document.querySelectorAll('[data-model-select]').forEach((select) => select.onchange = () => {
    const ad = batch.ads.find((item) => item.id === select.dataset.modelSelect);
    adState(ad).varModel[select.dataset.variation] = select.value;
    saveState();
  });
  document.querySelectorAll('[data-run-count]').forEach((select) => select.onchange = () => {
    const ad = batch.ads.find((item) => item.id === select.dataset.runCount);
    const variation = ad.variations.find((item) => item.id === select.dataset.variation);
    const state = adState(ad);
    state.promptRunCounts ||= {};
    state.promptRunCounts[promptRunKey(variation, select.dataset.prompt)] = ImageGenLogic.normalizeRunCount(select.value, PROMPT_RUN_DEFAULT);
    saveState();
    render();
  });
  document.querySelectorAll('[data-gen-prompt]').forEach((button) => button.onclick = () => {
    const ad = batch.ads.find((item) => item.id === button.dataset.genPrompt);
    const variation = ad.variations.find((item) => item.id === button.dataset.variation);
    beginRun();
    send(variationJobs(ad, variation, button.dataset.prompt));
  });
  // Prompt disclosure: open or close the editable prompt, remembered per prompt in uiState.
  document.querySelectorAll('[data-toggle-prompt]').forEach((toggle) => {
    const open = () => {
      const ad = batch.ads.find((item) => item.id === toggle.dataset.togglePrompt);
      const variation = ad.variations.find((item) => item.id === toggle.dataset.variation);
      const ui = uiState(ad.id);
      ui.prompts ||= {};
      const key = promptRunKey(variation, toggle.dataset.prompt);
      ui.prompts[key] = !ui.prompts[key];
      saveState();
      render();
    };
    toggle.onclick = open;
    toggle.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } };
  });
  // Editing a prompt: store the override keyed like the run counts. An edit that matches the
  // config text exactly is dropped so the prompt falls back to the brief on its own. Also track
  // which textarea was last interacted with, so clicking outside copies it to clipboard.
  document.querySelectorAll('[data-prompt-text]').forEach((area) => area.oninput = () => {
    const ad = batch.ads.find((item) => item.id === area.dataset.promptText);
    const variation = ad.variations.find((item) => item.id === area.dataset.variation);
    const entry = ImageGenLogic.promptEntries(variation).find((item) => item.promptId === area.dataset.prompt);
    const state = adState(ad);
    state.promptEdits ||= {};
    const key = promptRunKey(variation, area.dataset.prompt);
    const value = area.value;
    if (entry && value === entry.prompt) delete state.promptEdits[key];
    else state.promptEdits[key] = value;
    lastPromptTextArea = area; // track for copy-on-click-outside
    saveState();
    // No re-render here: re-rendering would steal focus from the textarea mid-edit. The edited
    // dot and note refresh on the next render (toggle, generate, reset).
  });
  // Reset to brief: drop the edit so the config prompt is used again.
  document.querySelectorAll('[data-reset-prompt-text]').forEach((button) => button.onclick = () => {
    const ad = batch.ads.find((item) => item.id === button.dataset.resetPromptText);
    const variation = ad.variations.find((item) => item.id === button.dataset.variation);
    const state = adState(ad);
    if (state.promptEdits) delete state.promptEdits[promptRunKey(variation, button.dataset.prompt)];
    saveState();
    render();
  });
  document.querySelectorAll('[data-gen-variation]').forEach((button) => button.onclick = () => {
    const ad = batch.ads.find((item) => item.id === button.dataset.genVariation);
    const variation = ad.variations.find((item) => item.id === button.dataset.variation);
    beginRun();
    send(variationJobs(ad, variation));
  });
  document.querySelectorAll('[data-reset-variation]').forEach((button) => button.onclick = () => {
    const ad = batch.ads.find((item) => item.id === button.dataset.resetVariation);
    Object.assign(adState(ad), ImageGenLogic.resetVariation(adState(ad), button.dataset.variation));
    saveState(); render();
  });
  // Clicking anywhere outside the prompt textareas copies the last-edited prompt to clipboard.
  document.addEventListener('click', (event) => copyPromptText());
}

function handleProgress(job, status, thumb, error, variantIndex) {
  if (!job || !job.adId) return;
  const state = adState({ id: job.adId });
  if (job.kind === 'model') {
    const slot = modelCandidates(state.models[job.modelId]);
    const run = job.run;
    const previous = slot.candidates[run];
    slot.candidates[run] = { status, dataUrl: status === 'done' ? thumb : previous?.dataUrl, error: status === 'error' ? error : null };
    // If this model had no pick yet and a candidate just completed, pick it.
    if ((slot.picked == null || !slot.candidates[slot.picked]?.dataUrl) && status === 'done') slot.picked = run;
    state.models[job.modelId] = slot;
  } else if (job.kind === 'final') {
    // A multi-variant job reports one progress message per variant. variantIndex i maps to run slot i+1.
    const variantCount = job.variants || 1;
    const indexes = Number.isInteger(variantIndex) ? [variantIndex] : Array.from({ length: variantCount }, (_, i) => i);
    for (const i of indexes) {
      const run = i + 1;
      const identity = ImageGenLogic.finalJobIdentity({ brand: brand.id, batch: batch.code, ad: job.adId, variation: job.variationId, prompt: job.promptId, run });
      const previous = state.runs[identity.key];
      if (status === 'missing') {
        // ChatGPT returned fewer images than requested; this slot never got one. Mark it
        // "missing" (a distinct, re-runnable empty state, no thumb, no error) so the user can
        // tell it apart from a never-started slot. runSlotComplete still treats it as not done,
        // so Generate ready and the per-prompt re-run will re-queue it.
        // Mapping variantIndex i -> run slot i+1 mirrors the done path exactly.
        state.runs[identity.key] = { ...(previous || {}), status: previous?.dataUrl ? 'done' : 'missing', variation: job.variationId, promptId: job.promptId, run, modelId: job.modelId, dataUrl: previous?.dataUrl || null, error: null };
        continue;
      }
      state.runs[identity.key] = { ...(previous || {}), updatedAt: Date.now(), status, variation: job.variationId, promptId: job.promptId, run, modelId: job.modelId, dataUrl: status === 'done' ? thumb : previous?.dataUrl, error: status === 'error' ? error : null };
    }
  }
  if (status === 'error') showError(`${job.name}: ${error || 'could not finish'}`);
  saveState();
  render();
}

// Download the most recently completed image from any run in this batch. Returns a dataUrl string,
// or null when no finished images exist yet. Picks the first done entry (runs accumulate sequentially).
function downloadLatest() {
  if (!brand || !batch) return null;
  // Try final jobs first (most common output), then fall back to model candidates.
  for (const [key, item] of Object.entries(state.runs)) {
    if (item?.status === 'done' && item.dataUrl) return item.dataUrl;
  }
  // No completed prompt runs yet — check model pool candidates.
  for (const ad of batch.ads) {
    const state = adState(ad);
    if (ad.kind === 'face') {
      for (const model of ad.models || []) {
        const slot = state.models[model.id];
        if (slot?.candidates && Object.values(slot.candidates).some((cand) => cand?.dataUrl && cand.status === 'done')) {
          return Object.values(slot.candidates).find((cand) => cand?.dataUrl)?.dataUrl;
        }
      }
    } else {
      for (const variation of ad.variations || []) {
        const state = adState(ad);
        if (pickedModelImage(state, selectedModel(ad, variation))) return pickedModelImage(state, selectedModel(ad, variation));
      }
    }
  }
  return null;
}

function generateReady() {
  beginRun();
  const jobs = [];
  for (const ad of batch.ads) {
    if (ad.kind === 'face') {
      const state = adState(ad);
      // For each variation: if its model has a picked candidate, generate its missing variation runs.
      // Otherwise queue that model's missing candidates so a pick becomes possible.
      const queuedModels = new Set();
      for (const variation of ad.variations) {
        const modelId = selectedModel(ad, variation);
        if (pickedModelImage(state, modelId)) {
          jobs.push(...variationJobs(ad, variation, null, { onlyMissing: true }));
        } else if (!queuedModels.has(modelId)) {
          queuedModels.add(modelId);
          const model = ad.models.find((item) => item.id === modelId);
          if (model) jobs.push(...modelJobs(ad, model, selectedModelCount(ad, modelId)));
        }
      }
    } else {
      ad.variations.forEach((variation) => jobs.push(...variationJobs(ad, variation, null, { onlyMissing: true })));
    }
  }
  send(jobs, 'No ready images left to generate.');
  if (jobs.length) setFlow(`Generating ${jobs.length} ready images…`);
}

// Home dashboard: poll the local bridge for live status. The bridge exposes
// GET http://localhost:8787/health -> { ok, bridge, extensionConnected, loggedIn, queue }.
// This is read-only and independent of the generation wiring; it only paints the home dots.
const BRIDGE_HEALTH_URL = 'http://localhost:8787/health';
let healthTimer = null;

function setStat(dotId, valId, state, label) {
  const dot = $(dotId), val = $(valId);
  if (dot) dot.className = `dot ${state === 'good' ? 'on' : state === 'bad' ? 'off' : 'pending'}`;
  if (val) { val.textContent = label; val.className = `stat-value${state === 'good' ? ' good' : state === 'bad' ? ' bad' : ''}`; }
}

// Turn a queue summary into one calm line. Accepts either a count-shaped object
// ({ running, queued }) or a plain string, and falls back to "idle".
function queueSummary(queue) {
  if (queue == null) return 'idle';
  if (typeof queue === 'string') return queue || 'idle';
  if (typeof queue === 'number') return queue > 0 ? `${queue} queued` : 'idle';
  const running = Number(queue.running ?? queue.active ?? 0);
  const queued = Number(queue.queued ?? queue.pending ?? queue.waiting ?? 0);
  if (!running && !queued) return 'idle';
  const parts = [];
  if (running) parts.push(`${running} running`);
  if (queued) parts.push(`${queued} queued`);
  return parts.join(', ');
}

async function pollHealth() {
  try {
    const response = await fetch(BRIDGE_HEALTH_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error('bad status');
    const data = await response.json();
    setStat('stBridgeDot', 'stBridgeVal', 'good', 'up');
    setStat('stExtDot', 'stExtVal', data.extensionConnected ? 'good' : 'bad', data.extensionConnected ? 'connected' : 'asleep');
    setStat('stChatDot', 'stChatVal', data.loggedIn ? 'good' : 'bad', data.loggedIn ? 'logged in' : 'logged out');
    const queueEl = $('stQueueVal');
    if (queueEl) queueEl.textContent = queueSummary(data.queue);
    updateCodexLine(data.codexProgress);
    updateCodexActivity(data.codexProgress);
  } catch {
    // Bridge unreachable: bridge down, and the rest is unknown rather than asserted good.
    setStat('stBridgeDot', 'stBridgeVal', 'bad', 'down');
    setStat('stExtDot', 'stExtVal', 'pending', 'unknown');
    setStat('stChatDot', 'stChatVal', 'pending', 'unknown');
    const queueEl = $('stQueueVal');
    if (queueEl) queueEl.textContent = 'unavailable';
    updateCodexLine(null);
    updateCodexActivity(null);
  }
}

// Show the Codex-backend batch progress (codexbatch.mjs, separate quota) in the workflow header,
// in sync with the extension. Visible only while a recent codex run is active.
function updateCodexLine(cp) {
  const el = $('codexLine'); if (!el) return;
  const fresh = cp && cp.total > 0 && cp.updatedAt && (Date.now() - cp.updatedAt < 30000);
  if (!fresh) { el.hidden = true; return; }
  const failTxt = cp.failed ? `, ${cp.failed} failed` : '';
  el.hidden = false;
  el.textContent = `Codex (separate quota): ${(cp.done || 0) + (cp.skipped || 0)}/${cp.total} done${failTxt}`;
}

// Mirror the Codex batch into the Activity list as a synthetic lane, so "what Codex is generating
// and how far" shows alongside the live ChatGPT-tab lanes. Fed from /health codexProgress every poll.
let codexLaneDoneShown = false;
// Parse job names: old format (IMG01_b1_A_p1_r1) → descriptive, new format (Mousse_Batch 1_…) already human-readable.
function prettyCodexJob(cur) {
  if (!cur) return '';
  // Try the new descriptive format first: "Title_BatchName_Label_rN" — just show title + label.
  const m2 = /(?:^|\s)([A-Z][\w\s\-]+?)\s*·?\s*([\d\w\s\-]+?)[\s_]*·?\s*([\w\s\-]+?)[\s_]*r\d+/i.exec(cur);
  if (m2) return `${m2[1]} · ${m2[3]}`;
  // Fall back to the legacy ID format: "AD3_b1_A_p1_r1" → "b1 AD3/A".
  const m = /^(\S+?)_([^_]+)_([^_]+)_([^_]+)_r\d+/.exec(cur);
  return m ? `${m[2]} ${m[1]}/${m[3]}` : cur;
}
function updateCodexActivity(cp) {
  const fresh = cp && cp.total > 0 && cp.updatedAt && (Date.now() - cp.updatedAt < 30000);
  if (!fresh) { applyLaneStatus({ laneId: 'codex', _cleared: true }); codexLaneDoneShown = false; return; }
  const failTxt = cp.failed ? ` · ${cp.failed} failed` : '';
  const accounted = (cp.done || 0) + (cp.skipped || 0) + (cp.failed || 0);
  const finished = accounted >= cp.total && !cp.current;
  if (finished) {
    // Single 'done' beat, auto-clears after 6s.
    if (!codexLaneDoneShown) {
      applyLaneStatus({ laneId: 'codex', name: 'Codex · separate quota', state: 'done', detail: `${(cp.done || 0) + (cp.skipped || 0)}/${cp.total} done${failTxt}`, updatedAt: cp.updatedAt });
      codexLaneDoneShown = true;
    }
    return;
  }
  // Codex is still running — clear any stale "done" beat so it can resume cleanly.
  if (codexLaneDoneShown) { applyLaneStatus({ laneId: 'codex', _cleared: true }); codexLaneDoneShown = false; }
  const where = cp.current ? ` · ${prettyCodexJob(cp.current)}` : '';
  applyLaneStatus({ laneId: 'codex', name: 'Codex · separate quota', state: 'generating', detail: `${(cp.done || 0) + (cp.skipped || 0)}/${cp.total} done${failTxt}${where}`, updatedAt: cp.updatedAt });
}

// Pull codex-rendered images straight into the panel. The background SW also ingests these, but MV3
// evicts it when idle, so codex images would otherwise only trickle in on the ~30s alarm wake. The
// panel is alive the whole time it is open, so polling here makes them appear live and stay correct
// even if the SW is asleep. Drains /codex-results, persists each (so it survives reload), then reuses
// mergePersistedPreviews + render — the same path a reload uses, with the same version handling.
const CODEX_RESULTS_URL = 'http://localhost:8787/codex-results';
// In-flight guard so the 4s interval can't stack overlapping drains, and a seen-set so a relPath
// that's already been handled is never re-downscaled or re-written (the endpoint may re-serve until
// the SW acks). Both are module-level so they persist across interval ticks.
let codexPollInFlight = false;
const codexSeenRelPaths = new Set();

// Downscale a full-res dataURL to a small WebP thumbnail (longest edge <= 320px). Full-res images
// must NEVER reach chrome.storage.local — only thumbnails. Returns null on any failure so the caller
// skips the image rather than ever storing full-res.
async function downscaleToThumb(dataUrl) {
  try {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const s = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * s);
    cv.height = Math.round(bmp.height * s);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/webp', 0.7);
  } catch (err) {
    console.error('[ImageGen] downscaleToThumb failed; skipping image:', err);
    return null;
  }
}

async function pollCodexResults() {
  if (!brand || !batch) return;
  if (codexPollInFlight) return; // in-flight guard: don't let polls stack
  codexPollInFlight = true;
  try {
    // Batch-drain protocol: each GET returns <=8 results plus a `remaining` count; loop while >0.
    let remaining = Infinity;
    let changed = false;
    while (remaining > 0) {
      let payload;
      try {
        payload = await (await fetch(CODEX_RESULTS_URL, { cache: 'no-store' })).json();
      } catch (err) {
        console.error('[ImageGen] pollCodexResults fetch failed:', err);
        break;
      }
      const results = (payload && Array.isArray(payload.results)) ? payload.results : [];
      remaining = (payload && Number.isFinite(payload.remaining)) ? payload.remaining : 0;
      if (!results.length) break;

      const sets = {};
      for (const r of results) {
        if (!r || !r.relPath || !r.dataUrl) continue;
        if (codexSeenRelPaths.has(r.relPath)) continue; // already handled this relPath
        const thumb = await downscaleToThumb(r.dataUrl);
        codexSeenRelPaths.add(r.relPath); // mark seen even on skip, so a bad image isn't retried forever
        if (!thumb) continue; // never store full-res; skip on downscale failure
        sets['preview:' + r.relPath] = thumb;
      }

      if (Object.keys(sets).length) {
        try {
          await new Promise((resolve, reject) => {
            chrome.storage.local.set(sets, () => {
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
              else resolve();
            });
          });
          changed = true;
        } catch (err) {
          console.error('[ImageGen] pollCodexResults storage set failed:', err);
        }
      }
    }

    // Only touch the panel if a slot actually changed.
    if (changed) {
      await mergePersistedPreviews();
      render();
    }
  } catch (err) {
    console.error('[ImageGen] pollCodexResults failed:', err);
  } finally {
    codexPollInFlight = false;
  }
}

function startHealthPolling() {
  if (healthTimer) return;
  pollHealth();
  pollCodexResults();
  healthTimer = setInterval(() => { pollHealth(); pollCodexResults(); }, 4000);
}

// View switching: home dashboard <-> brand workflow. Both views live in the DOM; only the
// hidden attribute toggles. The generation wiring is untouched by this.
function showHome() {
  $('homeView').hidden = false;
  $('workflowView').hidden = true;
  startHealthPolling();
}
function showWorkflow() {
  $('homeView').hidden = true;
  $('workflowView').hidden = false;
}

async function checkTab() {
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://*.chatgpt.com/*'] });
  const tab = tabs.find((item) => item.active) || tabs[0];
  if (!tab) { $('tabDot').className = 'dot off'; $('tabState').textContent = 'open ChatGPT'; return; }
  chrome.tabs.sendMessage(tab.id, { type: 'ping' }, (response) => {
    if (chrome.runtime.lastError || !response?.loggedIn) { $('tabDot').className = 'dot off'; $('tabState').textContent = 'reload ChatGPT'; }
    else { $('tabDot').className = 'dot on'; $('tabState').textContent = 'connected'; }
  });
}

function changeSelection() {
  setRunning(false);
  loadState().then(() => { fillSelectors(); render(); populateSettingDropdowns(getSettings()); });
}

// ── Settings panel: general / generation / about. Persists to chrome.storage.local under 'imagegen-settings'.
let settingsState = null;
function getSettings() {
  if (settingsState) return settingsState;
  const stored = chrome.storage.local.get('imagegen-settings');
  settingsState = {
    autoResume: true,
    showPaths: false,
    outputDir: '',
    brandId: 'simpletics',
    batchCode: '',
    aspectRatio: 'auto',
  };
  if (stored && stored['imagegen-settings']) {
    const s = stored['imagegen-settings'];
    for (const key of ['autoResume','showPaths','outputDir','brandId','batchCode','aspectRatio']) {
      settingsState[key] = s[key] !== undefined ? s[key] : settingsState[key];
    }
  } else {
    // Default to first brand/batch if available.
    if (CONFIG && CONFIG.brands.length) {
      const firstBrand = CONFIG.brands[0];
      settingsState.brandId = firstBrand.id;
      const batches = firstBrand.batches || [];
      if (batches.length) settingsState.batchCode = batches[0].code;
    }
  }
  return settingsState;
}
function saveSettings() {
  try {
    chrome.storage.local.set({ 'imagegen-settings': getSettings() }, () => {}); // ignore write errors
  } catch (err) { console.error('[ImageGen] saveSettings failed:', err); }
}

// Settings modal: open / close. Uses the same preview-style overlay as the existing dialog.
function showSettings() {
  const panel = $('settingsPanel'); if (!panel) return;
  panel.hidden = false;
  const s = getSettings();
  populateSettingDropdowns(s);
}
function hideSettings() {
  const panel = $('settingsPanel'); if (panel) { panel.hidden = true; }
}

function populateSettingDropdowns(s) {
  // Brand dropdown.
  const brandSelect = $('setting-brand');
  if (!brandSelect) return;
  let html = '';
  for (const b of CONFIG.brands) {
    const sel = s.brandId === b.id ? ' selected' : '';
    html += `<option value="${b.id}"${sel}>${CSS.escape(b.name)}</option>`;
  }
  brandSelect.innerHTML = html;

  // Batch dropdown: filtered by currently-selected brand.
  const batchSelect = $('setting-batch');
  if (!batchSelect) return;
  const brands = CONFIG.brands.filter((b) => b.id === s.brandId);
  let html = '';
  for (const b of brands) {
    const sel = s.batchCode === b.batches?.[0]?.code ? ' selected' : '';
    html += `<option value="${CSS.escape(b.batches?.[0]?.code || '')}"${sel}>${CSS.escape(b.name)}</option>`;
  }
  batchSelect.innerHTML = html;

  // Aspect ratio: mirror the header selector values.
  const aspectSelect = $('setting-aspect');
  if (aspectSelect) {
    aspectSelect.value = s.aspectRatio || 'auto';
  }

  // Toggles & text input.
  document.getElementById('setting-autoResume')?.checked = !!s.autoResume;
  document.getElementById('setting-showPaths')?.checked = !!s.showPaths;
  const outputInput = $('setting-outputDir');
  if (outputInput) { outputInput.value = s.outputDir || ''; }

  // Version from manifest.
  const versionEl = $('setting-version');
  if (versionEl) { versionEl.textContent = chrome.runtime.getManifest?.().version || '—'; }
}

// Wire up settings form events: persistence on any change.
function bindSettings() {
  const apply = () => saveSettings();
  // Dropdowns.
  $('setting-brand').onchange = () => {
    settingsState.brandId = $('setting-brand').value;
    populateSettingDropdowns(settingsState);
    apply();
  };
  $('setting-batch').onchange = () => {
    settingsState.batchCode = $('setting-batch').value || '';
    apply();
  };
  // Toggles.
  document.getElementById('setting-autoResume')?.addEventListener('change', (e) => { settingsState.autoResume = !!e.target.checked; apply(); });
  document.getElementById('setting-showPaths')?.addEventListener('change', (e) => { settingsState.showPaths = !!e.target.checked; apply(); });
  // Output dir.
  $('setting-outputDir').oninput = () => { settingsState.outputDir = $('setting-outputDir').value; apply(); };
}

// Generate button: context-aware text + info line below it.
function batchProgress() { return ImageGenLogic ? ImageGenLogic.batchProgress ? {} : null : null; }
// Tally every expected slot across the batch into done/generating/error/queued.
function tallyProgress() {
  if (!brand || !batch) return { done: 0, generating: 0, error: 0, queued: 0 };
  let done = 0, generating = 0, error = 0, queued = 0;
  // Model pool slots (face ads only).
  for (const ad of batch.ads) {
    const state = panelState.ads[ad.id] || {};
    if (ad.kind === 'face') {
      for (const model of ad.models || []) {
        const slot = state.models[model.id];
        if (!slot) continue;
        const candidates = slot.candidates || {};
        for (let run = 1; run <= selectedModelCount(ad, model.id); run++) {
          const cand = candidates[run] || { status: '', dataUrl: null };
          if (cand.dataUrl) done++; else if (cand.status === 'generating') generating++; else if (cand.status === 'error') error++; else queued++;
        }
      }
    }
  }
  // Variation prompt slots — counted only when a picked model image exists, otherwise the
  // model pool already accounts for this variation. Product ads: count every slot unconditionally.
  for (const ad of batch.ads) {
    const state = panelState.ads[ad.id] || {};
    if (ad.kind === 'face') {
      for (const variation of ad.variations || []) {
        const modelId = selectedModel(ad, variation);
        // Only count variation slots when this variation has a picked candidate image.
        if (!pickedModelImage(state, modelId)) continue;
        let runCount = PROMPT_RUN_DEFAULT;
        for (const entry of ImageGenLogic.promptEntries(variation)) {
          const key = promptRunKey(variation, entry.promptId);
          runCount = Math.min(runCount, state.promptRunCounts?.[key] || runCount);
        }
        for (let run = 1; run <= runCount; run++) {
          const identity = ImageGenLogic.finalJobIdentity({ brand: brand.id, batch: batch.code, ad: ad.id, variation: variation.id, prompt: 'placeholder', run });
          const item = state.runs[identity.key];
          if (item?.dataUrl) done++; else if (item?.status === 'generating') generating++; else if (item?.status === 'error') error++; else queued++;
        }
      }
    } else {
      for (const variation of ad.variations || []) {
        let runCount = PROMPT_RUN_DEFAULT;
        const state = panelState.ads[ad.id] || {};
        for (const entry of ImageGenLogic.promptEntries(variation)) {
          const key = promptRunKey(variation, entry.promptId);
          runCount = Math.min(runCount, state.promptRunCounts?.[key] || runCount);
        }
        for (let run = 1; run <= runCount; run++) {
          const identity = ImageGenLogic.finalJobIdentity({ brand: brand.id, batch: batch.code, ad: ad.id, variation: variation.id, prompt: 'placeholder', run });
          const item = state.runs[identity.key];
          if (item?.dataUrl) done++; else if (item?.status === 'generating') generating++; else if (item?.status === 'error') error++; else queued++;
        }
      }
    }
  }
  return { done, generating, error, queued };
}

function updateGenerateButtonState() {
  const p = tallyProgress();
  // Only update when not actively running — Stop button takes over during runs.
  if (document.querySelector('.actions.running')) return;
  const runAll = $('runAll');
  if (!runAll) return;
  if (p.done + p.error === p.total && p.total > 0) {
    runAll.textContent = 'All complete';
    runAll.disabled = true;
  } else if (p.queued > 0 || p.generating > 0) {
    const left = p.queued + p.generating;
    runAll.textContent = `Continue generation (${left} left)`;
    runAll.disabled = false;
    $('genInfo').textContent = 'Resumes from where it left off. All completed images stay safe.';
  } else {
    // Fresh start — no prior work for this batch.
    runAll.textContent = 'Generate new images';
    runAll.title = 'Start a brand new image generation run from scratch.';
    $('genInfo').textContent = '';
  }
}

function generateReady() {
  updateGenerateButtonState();
  beginRun();
  const jobs = [];
  for (const ad of batch.ads) {
    if (ad.kind === 'face') {
      const state = panelState.ads[ad.id] || {};
      // For each variation: if its model has a picked candidate, generate its missing variation runs.
      // Otherwise queue that model's missing candidates so a pick becomes possible.
      const queuedModels = new Set();
      for (const variation of ad.variations) {
        const modelId = selectedModel(ad, variation);
        if (pickedModelImage(state, modelId)) {
          jobs.push(...variationJobs(ad, variation, null, { onlyMissing: true }));
        } else if (!queuedModels.has(modelId)) {
          queuedModels.add(modelId);
          const model = ad.models.find((item) => item.id === modelId);
          if (model) jobs.push(...modelJobs(ad, model, selectedModelCount(ad, modelId)));
        }
      }
    } else {
      ad.variations.forEach((variation) => jobs.push(...variationJobs(ad, variation, null, { onlyMissing: true })));
    }
  }
  send(jobs, 'No ready images left to generate.');
  if (jobs.length) setFlow(`Generating ${jobs.length} ready images…`);
}

// ── Live Activity: one row per active ChatGPT tab/lane, fed by 'lane-status' messages and the
// chrome.storage.session laneStatus map (read on open). The section hides itself when idle.
const laneStatusMap = {};
const laneClearTimers = {};
let laneTicker = null;
const LANE_TERMINAL = new Set(['done', 'error', 'refusal', 'rate-limited', 'aborted']);
const LANE_LABELS = {
  queued: { label: 'Queued', dot: 'active' }, opening: { label: 'Opening tab', dot: 'active' },
  typing: { label: 'Typing prompt', dot: 'active' }, generating: { label: 'Generating', dot: 'active' },
  'awaiting-image': { label: 'Awaiting image', dot: 'active' }, captured: { label: 'Captured', dot: 'active' },
  saving: { label: 'Saving', dot: 'active' }, downloading: { label: 'Saving', dot: 'active' },
  done: { label: 'Done', dot: 'done' }, error: { label: 'Error', dot: 'error' },
  refusal: { label: 'Refused', dot: 'error' }, 'rate-limited': { label: 'Rate limited', dot: 'warn' },
  aborted: { label: 'Stopped', dot: 'warn' },
};
function laneLabel(r) {
  const base = LANE_LABELS[r.state] || { label: r.state || 'Working', dot: 'active' };
  let label = base.label;
  if (Number.isInteger(r.imageIndex) && Number.isInteger(r.imageTotal) && r.imageTotal > 1
      && ['awaiting-image', 'captured', 'saving', 'downloading'].includes(r.state)) {
    label = `${base.label} ${r.imageIndex} of ${r.imageTotal}`;
  }
  return { label, dot: base.dot };
}
function fmtElapsed(ms) { const s = Math.max(0, Math.floor(ms / 1000)); const m = Math.floor(s / 60); return m ? `${m}:${String(s % 60).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`; }
function laneElapsed(r, now) { const end = LANE_TERMINAL.has(r.state) ? (r.updatedAt || now) : now; return end - (r.startedAt || r.updatedAt || end); }
function renderActivity() {
  const section = $('activity'), lanes = $('lanes'), count = $('activityCount');
  if (!section || !lanes) return;
  const records = Object.values(laneStatusMap).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  if (!records.length) { section.hidden = true; lanes.innerHTML = ''; if (laneTicker) { clearInterval(laneTicker); laneTicker = null; } return; }
  section.hidden = false;
  const now = Date.now();
  const active = records.filter((r) => !LANE_TERMINAL.has(r.state)).length;
  count.textContent = active ? `${active} active` : 'finishing up';
  lanes.innerHTML = records.map((r) => {
    const v = laneLabel(r);
    const stateCls = (r.state === 'error' || r.state === 'refusal') ? ' is-error' : r.state === 'done' ? ' is-done' : (r.state === 'rate-limited' || r.state === 'aborted') ? ' is-warn' : '';
    const finishing = LANE_TERMINAL.has(r.state) ? ' is-finishing' : '';
    const name = r.name || r.adId || `Tab ${r.laneId}`;
    const detail = r.error || r.detail || '';
    return `<div class="lane${finishing}" data-lane="${escape(String(r.laneId))}"><span class="lane-dot is-${v.dot}"></span><span class="lane-body"><span class="lane-name">${escape(String(name))}</span><span class="lane-state${stateCls}">${escape(v.label)}${detail ? ' · ' + escape(detail) : ''}</span></span><span class="lane-elapsed">${fmtElapsed(laneElapsed(r, now))}</span></div>`;
  }).join('');
  if (!laneTicker) laneTicker = setInterval(() => {
    const t = Date.now(); let live = false;
    document.querySelectorAll('#lanes .lane').forEach((row) => {
      const r = laneStatusMap[row.dataset.lane]; if (!r) return;
      const cell = row.querySelector('.lane-elapsed'); if (cell) cell.textContent = fmtElapsed(laneElapsed(r, t));
      if (!LANE_TERMINAL.has(r.state)) live = true;
    });
    if (!live && laneTicker) { clearInterval(laneTicker); laneTicker = null; }
  }, 1000);
}
function applyLaneStatus(record) {
  if (!record || record.laneId == null) return;
  const id = String(record.laneId);
  if (record._cleared) { delete laneStatusMap[id]; if (laneClearTimers[id]) { clearTimeout(laneClearTimers[id]); delete laneClearTimers[id]; } renderActivity(); return; }
  const prev = laneStatusMap[id] || {};
  laneStatusMap[id] = { ...prev, ...record, startedAt: record.startedAt || prev.startedAt || record.updatedAt || Date.now() };
  if (laneClearTimers[id]) { clearTimeout(laneClearTimers[id]); delete laneClearTimers[id]; }
  if (LANE_TERMINAL.has(record.state)) laneClearTimers[id] = setTimeout(() => { delete laneStatusMap[id]; delete laneClearTimers[id]; renderActivity(); }, 6000);
  renderActivity();
}
async function loadLaneStatus() {
  try { const s = await chrome.storage.session.get('laneStatus'); const m = s && s.laneStatus; if (m) for (const r of Object.values(m)) if (r && r.laneId != null) applyLaneStatus(r); } catch {}
  renderActivity();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'lane-status') { applyLaneStatus(message.record); return; }
  if (message.type === 'progress' || message.type === 'bridge') handleProgress(message.job, message.status, message.thumb || message.path, message.error, message.variantIndex);
  if (message.type === 'project') {
    const label = message.status === 'opening' ? 'Opening Projects…'
      : message.status === 'checking' ? `Checking ${message.project}…`
      : message.status === 'created' ? `Created ${message.project}. Opening ChatGPT…`
      : `Project ready: ${message.project}`;
    setFlow(label);
  }
  if (message.type === 'queue') { setRunning(true); setFlow(`Working on ${message.index + 1} of ${message.total}: ${message.name}`); }
  if (message.type === 'done') { setRunning(false); setFlow(message.error ? 'Ready when you are.' : `Done. ${message.generated || 0} saved.`); if (message.error) showError(message.error); }
  if (message.type === 'stopped') { setRunning(false); setFlow('Stopped.'); }
});

async function init() {
  try { CONFIG = await (await fetch('config.json')).json(); } catch { showError('Could not load the batch configuration.'); return; }
  brand = CONFIG.brands[0];
  batch = brand.batches[0];
  await loadRefs();
  await loadState();
  fillSelectors(); render(); checkTab(); setInterval(checkTab, 4000);
  loadLaneStatus();
  startHealthPolling(); // poll the bridge /health (queue + codex progress) in every view
  $('runAll').onclick = generateReady;

  // Settings: bind form events and populate dropdowns from initial CONFIG.
  const s = getSettings();
  populateSettingDropdowns(s);
  bindSettings();
  $('resetBatch').onclick = () => { panelState = { ads: {} }; saveState(); render(); setFlow('Batch reset.'); };
  // Download: grab the latest completed image and open it for saving.
  $('downloadLink').onclick = () => { const url = downloadLatest(); if (url) window.open(url); };
  $('stop').onclick = () => { chrome.runtime.sendMessage({ type: 'stop' }); $('pauseToggle').dataset.paused = ''; $('pauseToggle').textContent = 'Pause'; setFlow('Stopping…'); };
  // Pause/Continue: holds the run between images (the in-flight image always finishes), resumes on click.
  $('pauseToggle').onclick = () => {
    const btn = $('pauseToggle'); const paused = btn.dataset.paused === '1';
    if (paused) { chrome.runtime.sendMessage({ type: 'resume' }); btn.dataset.paused = ''; btn.textContent = 'Pause'; setFlow('Continuing…'); }
    else { chrome.runtime.sendMessage({ type: 'pause' }); btn.dataset.paused = '1'; btn.textContent = 'Continue'; setFlow('Paused. The current image finishes, then it holds.'); }
  };
  // Restart: clear this batch's saved previews/statuses, then regenerate from scratch.
  $('restartBtn').onclick = () => { panelState = { ads: {} }; saveState(); render(); setFlow('Restarting…'); generateReady(); };

  $('brandSel').onchange = (event) => { brand = CONFIG.brands.find((item) => item.id === event.target.value); batch = brand.batches[0]; changeSelection(); };
  $('batchSel').onchange = (event) => { batch = brand.batches.find((item) => item.code === event.target.value); changeSelection(); };
  $('aspectSel').onchange = (event) => { selectedAspect = event.target.value || 'auto'; };

  // Settings gear icon.
  $('settingsBtn').onclick = () => showSettings();
  const settingsClose = $('settingsClose');
  if (settingsClose) {
    settingsClose.onclick = hideSettings;
    settingsClose.onkeydown = (event) => { if (event.key === 'Escape') hideSettings(); };
  }

  // Settings panel: click outside to close.
  const settingsOverlay = $('settingsPanel');
  if (settingsOverlay) {
    settingsOverlay.onclick = () => { hideSettings(); };
  }

  $('closePreview').onclick = () => $('preview').classList.remove('open');
  $('preview').onclick = (event) => { if (event.target === $('preview')) $('preview').classList.remove('open'); };
  // Home <-> workflow navigation. Default screen is the home dashboard; the brand workflow
  // (built above, fully wired) is reached by "Load a brand" and returned from via "Home".
  $('goWorkflow').onclick = showWorkflow;
  $('backHome').onclick = showHome;
  // Boot into the home dashboard and start polling the bridge for live status.
  showHome();
}

init();
