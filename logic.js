(function (root, factory) {
  const api = factory();
  root.ImageGenLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const part = (value) => String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');

  function modelJobIdentity({ brand, batch, ad, model, run = 1 }) {
    const b = part(brand), ba = part(batch), a = part(ad), m = part(model), r = Number(run);
    return {
      key: `model:${b}:${ba}:${a}:${m}:r${r}`,
      name: `${a}_${ba}_model_${m}_r${r}`,
      relativePath: `${b}/${ba}/models/${a}/${m}/run-${r}.png`,
    };
  }

  function finalJobIdentity({ brand, batch, ad, variation, prompt, run = 1 }) {
    const b = part(brand), ba = part(batch), a = part(ad), v = part(variation), p = part(prompt), r = Number(run);
    return {
      key: `final:${b}:${ba}:${a}:${v}:${p}:r${r}`,
      name: `${a}_${ba}_${v}_${p}_r${r}`,
      relativePath: `${b}/${ba}/ads/${a}/${v}/${p}/run-${r}.png`,
    };
  }

  function normalizeRunCount(value, fallback = 2) {
    const count = Number(value);
    return Number.isInteger(count) && count >= 1 && count <= 10 ? count : fallback;
  }

  function runCountOptions() {
    return Array.from({ length: 10 }, (_, index) => index + 1);
  }

  function promptEntries(variation) {
    // Return exactly the authored prompts. Both brands now author explicit prompts
    // (Simpletics: 2 per variation, NanoX: 2 same-scene takes), so there is no phantom
    // "alternate take" synthesis. Backward compatible: a variation that authored only a
    // single top-level `prompt` (and no prompts[]) expands to one entry, never an
    // invented second one. This mirrors runbatch.mjs, which also uses only authored prompts.
    const authored = Array.isArray(variation.prompts) ? variation.prompts.filter(Boolean) : [];
    const entries = authored.length
      ? authored
      : [{ id: 'p1', label: 'Prompt 1', prompt: variation.prompt }];
    return entries.map((entry, index) => ({
      promptId: entry.id || `p${index + 1}`,
      promptLabel: entry.label || `Prompt ${index + 1}`,
      prompt: entry.prompt,
    }));
  }

  function promptRuns(variation, options = {}) {
    return promptEntries(variation).flatMap((entry) => {
      const requested = options.runCounts && Object.prototype.hasOwnProperty.call(options.runCounts, entry.promptId)
        ? options.runCounts[entry.promptId]
        : options.runCount;
      const count = normalizeRunCount(requested);
      return Array.from({ length: count }, (_, index) => ({ ...entry, run: index + 1 }));
    });
  }

  function runSlotComplete(slot) {
    return !!(slot && (slot.status === 'done' || slot.dataUrl));
  }

  function queueablePromptRuns(variation, options = {}) {
    const existingRuns = options.existingRuns || {};
    const keyForRun = options.keyForRun || ((run) => `${run.promptId}:r${run.run}`);
    return promptRuns(variation, options)
      .filter((run) => !options.onlyPromptId || run.promptId === options.onlyPromptId)
      .filter((run) => !runSlotComplete(existingRuns[keyForRun(run)]));
  }

  function canSubmitProject(button) {
    return !!button && button.disabled !== true;
  }

  function projectNameFromComposerLabel(label) {
    const match = String(label || '').match(/^New chat in (.+)$/);
    return match ? match[1].trim() : null;
  }

  function projectNameMatches(actual, expected) {
    return String(actual || '').trim() === String(expected || '').trim();
  }

  function conversationHrefMatch(currentPath, href) {
    try {
      return new URL(href, 'https://chatgpt.com').pathname === currentPath;
    } catch {
      return false;
    }
  }

  function freshGeneratedSrc(candidates, baseline) {
    const fresh = (candidates || []).filter((item) => item && item.generated && item.src && !(baseline || new Set()).has(item.src));
    return fresh.length ? fresh[fresh.length - 1].src : null;
  }

  function resetModel(state, modelId) {
    const models = { ...(state.models || {}) };
    delete models[modelId];
    const runs = Object.fromEntries(Object.entries(state.runs || {}).filter(([, run]) => run.modelId !== modelId));
    return { models, runs };
  }

  function resetVariation(state, variation) {
    const runs = Object.fromEntries(Object.entries(state.runs || {}).filter(([, run]) => run.variation !== variation));
    return { models: { ...(state.models || {}) }, runs };
  }

  function modelSlotReady(slot) {
    // Accepts both the simplified { dataUrl } shape and the live panel shape
    // { candidates: { run: { dataUrl } }, picked }. A model counts as ready once it
    // has any saved image: a direct dataUrl, the picked candidate, or any candidate.
    if (!slot) return false;
    if (slot.dataUrl) return true;
    const candidates = slot.candidates || {};
    if (slot.picked != null && candidates[slot.picked]?.dataUrl) return true;
    return Object.values(candidates).some((candidate) => candidate && candidate.dataUrl);
  }

  function faceReadyPlan(ad, state = {}) {
    if (!ad || ad.kind !== 'face') return { modelIds: [], variationIds: [] };
    const selected = state.varModel || {};
    const models = state.models || {};
    const modelIds = [];
    const variationIds = [];
    for (const variation of ad.variations || []) {
      const modelId = selected[variation.id] || variation.model || 'm1';
      if (modelSlotReady(models[modelId])) {
        variationIds.push(variation.id);
      } else if (!modelIds.includes(modelId)) {
        modelIds.push(modelId);
      }
    }
    return { modelIds, variationIds };
  }

  function isTransientPortError(error) {
    return /back\/forward cache|message channel is closed|receiving end does not exist/i.test(String(error || ''));
  }

  function sameRoute(current, target) {
    try {
      const a = new URL(current);
      const b = new URL(target);
      return a.origin === b.origin && a.pathname === b.pathname;
    } catch {
      return false;
    }
  }

  // Single source of truth for the per-prompt variant default. The panel and any caller import
  // this instead of a local magic number, so the default lives in one tested place.
  function defaultRunCount() {
    return 2;
  }

  // The key under which a prompt's run/variant count is stored in promptRunCounts. Production
  // and tests share this so the keys always match.
  function promptRunKey(variation, promptId) {
    return `${variation && variation.id}:${promptId}`;
  }

  // Pure: returns a NEW promptRunCounts map with every prompt of `ad` set to `count` (default 1,
  // i.e. "1 per tile" grid mode). Does not mutate the input. Powers the panel's grid-mode button.
  function gridModeRunCounts(state, ad, count = 1) {
    const next = { ...((state && state.promptRunCounts) || {}) };
    const n = normalizeRunCount(count, count);
    for (const variation of (ad && ad.variations) || []) {
      for (const entry of promptEntries(variation)) {
        next[promptRunKey(variation, entry.promptId)] = n;
      }
    }
    return next;
  }

  // Pure: never returns a path that already exists. `exists(candidateRelPath) -> boolean`. If the
  // original relPath is free, it is returned unchanged. Otherwise a version suffix is inserted BEFORE
  // the extension (run-1.png -> run-1-v2.png -> run-1-v3.png ...) and incremented until `exists` is
  // false. Works for any extension (.png/.jpg/.webp). This is the single guard that guarantees a
  // generation never overwrites an earlier one: callers route every write through it.
  function versionedRelPath(relPath, exists) {
    if (!exists(relPath)) return relPath;
    const dot = String(relPath).lastIndexOf('.');
    const base = dot === -1 ? relPath : relPath.slice(0, dot);
    const ext = dot === -1 ? '' : relPath.slice(dot);
    for (let version = 2; ; version++) {
      const candidate = `${base}-v${version}${ext}`;
      if (!exists(candidate)) return candidate;
    }
  }

  // Pure: parse a versioned-or-plain ads path back into its parts. Matches
  // `<brand>/<batch>/ads/<ad>/<variation>/<prompt>/run-<N>[-v<V>].<ext>`. The optional `-v<V>` suffix
  // produced by versionedRelPath maps back to the same base run slot (run + version). Returns null
  // for anything that is not an ads path (e.g. a models/ path), so other modules can map a versioned
  // file back to its base run.
  function parseRelPath(relPath) {
    const match = /^([^/]+)\/([^/]+)\/ads\/([^/]+)\/([^/]+)\/([^/]+)\/run-(\d+)(?:-v(\d+))?\.([a-z0-9]+)$/i.exec(String(relPath || ''));
    if (!match) return null;
    return {
      brand: match[1],
      batch: match[2],
      ad: match[3],
      variation: match[4],
      prompt: match[5],
      run: Number(match[6]),
      version: match[7] ? Number(match[7]) : 1,
      ext: match[8],
    };
  }

  return { modelJobIdentity, finalJobIdentity, normalizeRunCount, runCountOptions, promptEntries, promptRuns, runSlotComplete, queueablePromptRuns, canSubmitProject, projectNameFromComposerLabel, projectNameMatches, conversationHrefMatch, freshGeneratedSrc, resetModel, resetVariation, faceReadyPlan, isTransientPortError, sameRoute, defaultRunCount, promptRunKey, gridModeRunCounts, versionedRelPath, parseRelPath };
});
