// Typed fetch client for the studio-server (§3). Same-origin in prod; Vite proxies in dev.
// Every call resolves to a safe fallback on network/parse error rather than throwing.
import type { Config, BatchState, Health, GenerateScope, BatchMeta, PromptInfo, GenSettings, ResumeResult } from './types';

async function jget<T>(url: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()) as T;
  } catch {
    return fallback;
  }
}

async function jpost<T>(url: string, body: unknown, fallback: T): Promise<T> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await r.json()) as T;
  } catch {
    return fallback;
  }
}

const emptyState = (brand: string, batch: string): BatchState => ({
  brand, batch, ads: [],
  codex: { alive: false, progress: null },
  queue: { running: 0, queued: 0, waiting: 0, done: 0, failed: 0 },
  run: { state: 'idle', running: 0, queued: 0, waiting: 0, done: 0, failed: 0, total: 0, resumeAt: null },
  codexUsage: { known: false, label: 'unknown' },
  blockers: { auth: false, cooling: null, budget: false },
  archivedCount: 0,
});

const DEFAULT_SETTINGS: GenSettings = { graceSeconds: 10, budget: { maxPer5h: null, maxPer7d: null } };

export const api = {
  getConfig: () => jget<Config>('/api/config', { brands: [] }),
  getBatches: (brand: string) =>
    jget<BatchMeta[]>(`/api/batches?brand=${encodeURIComponent(brand)}`, []),
  getPrompt: (brand: string, batch: string, ad: string, variation: string, prompt: string) =>
    jget<PromptInfo>(
      `/api/prompt?brand=${encodeURIComponent(brand)}&batch=${encodeURIComponent(batch)}&ad=${encodeURIComponent(ad)}&variation=${encodeURIComponent(variation)}&prompt=${encodeURIComponent(prompt)}`,
      { ok: false, text: '' },
    ),
  getState: (brand: string, batch: string) =>
    jget<BatchState>(`/api/state?brand=${encodeURIComponent(brand)}&batch=${encodeURIComponent(batch)}`, emptyState(brand, batch)),
  getHealth: () =>
    jget<Health>('/api/health', {
      ok: false,
      bridge: false,
      codex: { alive: false },
      queue: { running: 0, queued: 0, waiting: 0, done: 0, failed: 0 },
      estimate: { seconds: 30, samples: 0, fallback: true },
    }),
  refreshUsage: () =>
    jpost<{ ok: boolean; codexUsage?: Health['codexUsage']; blockers?: Health['blockers']; error?: string }>(
      '/api/usage/refresh',
      {},
      { ok: false },
    ),
  assetUrl: (name: string) => `/asset?name=${encodeURIComponent(name)}`,
  imgUrl: (relPath: string, w?: number, downloadName?: string) => {
    const q = new URLSearchParams({ path: relPath });
    if (w) q.set('w', String(w));
    if (downloadName) q.set('filename', downloadName);
    return `/img?${q}`;
  },
  generate: (brand: string, batch: string, scope: GenerateScope, variants: number, runAt?: number) =>
    jpost<{ ok: boolean; enqueued: number }>(
      '/api/generate',
      { brand, batch, scope, variants, ...(runAt ? { runAt } : {}) },
      { ok: false, enqueued: 0 },
    ),
  regenerate: (relPath: string) =>
    jpost<{ ok: boolean }>('/api/regenerate', { relPath }, { ok: false }),
  // Revise = re-generate this slot with the original prompt PLUS a change instruction; queues a new
  // version. Always uses the ORIGINAL image as a reference; extraRefs are uploaded board image ids.
  revise: (relPath: string, instruction: string, extraRefs: string[] = []) =>
    jpost<{ ok: boolean; enqueued?: number; refs?: number }>('/api/revise', { relPath, instruction, extraRefs }, { ok: false }),
  // Upload a reference image (base64 data URL) for the Revise board → returns { id, url }.
  uploadRef: (dataUrl: string) =>
    jpost<{ ok: boolean; id?: string; url?: string }>('/api/upload-ref', { dataUrl }, { ok: false }),
  // Brand kits: per-workspace colors/fonts/notes (inform elements, swatches, the agent).
  getBrandKit: (brand: string) =>
    jget<{ ok: boolean; kit: { colors: string[]; fonts: string[]; notes: string; prompt?: string } }>(
      `/api/brandkit?brand=${encodeURIComponent(brand)}`, { ok: false, kit: { colors: [], fonts: [], notes: '', prompt: '' } }),
  saveBrandKit: (brand: string, kit: { colors: string[]; fonts: string[]; notes: string; prompt?: string }) =>
    jpost<{ ok: boolean; kit?: { colors: string[]; fonts: string[]; notes: string; prompt?: string } }>(
      '/api/brandkit', { brand, kit }, { ok: false }),
  getBrandSkill: (brand: string) =>
    jget<{ ok: boolean; text?: string }>(`/api/brand/skill?brand=${encodeURIComponent(brand)}`, { ok: false }),
  saveBrandSkill: (brand: string, text: string) =>
    jpost<{ ok: boolean; text?: string }>('/api/brand/skill', { brand, text }, { ok: false }),
  // FREE local search over the TrendTrack disk cache — 0 credits, never hits the paid API.
  trendtrackSearch: (query: string, limit = 60) =>
    jget<{ ok: boolean; ads: { id: string; brand: string; hook: string | null; scaling_verdict: string | null; hasImage: boolean }[]; creditsRemaining: number | null }>(
      `/api/trendtrack/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      { ok: false, ads: [], creditsRemaining: null },
    ),
  cancel: (arg: { jobId?: string; all?: boolean }) =>
    jpost<{ ok: boolean }>('/api/cancel', arg, { ok: false }),
  // Drag-and-drop queue reorder: `jobIds` is the full desired front-to-back order of this batch's
  // currently-queued job ids. The server rewrites priority so the worker actually honors it.
  reorderQueue: (brand: string, batch: string, jobIds: string[]) =>
    jpost<{ ok: boolean; reordered?: number }>('/api/queue/reorder', { brand, batch, jobIds }, { ok: false }),
  pause: () => jpost<{ ok: boolean }>('/api/pause', {}, { ok: false }),
  resume: (opts?: { verify?: boolean }) =>
    jpost<ResumeResult>('/api/resume', opts ?? {}, { ok: false }),
  dismissResume: () =>
    jpost<{ ok: boolean; run?: ResumeResult['run'] }>('/api/resume/dismiss', {}, { ok: false }),
  reset: () => jpost<{ ok: boolean }>('/api/reset', {}, { ok: false }),
  archive: (relPath: string, archived: boolean) =>
    jpost<{ ok: boolean }>('/api/archive', { relPath, archived }, { ok: false }),
  // Append a new prompt entry ("another take", e.g. p3 after p1/p2) to a variation's prompts[] in
  // config.json. Clones the last prompt's text verbatim as a starting point — caller should refetch
  // state afterward so the new slot appears. See studio-server.mjs POST /api/prompt/add.
  addPrompt: (brand: string, batch: string, ad: string, variation: string) =>
    jpost<{ ok: boolean; prompt?: { id: string; label?: string; prompt: string } }>(
      '/api/prompt/add',
      { brand, batch, ad, variation },
      { ok: false },
    ),
  patchPrompt: (
    brand: string,
    batch: string,
    ad: string,
    variation: string,
    prompt: string,
    patch: { prompt?: string; label?: string },
  ) =>
    jpost<{ ok: boolean; prompt?: { id: string; label?: string; prompt: string } }>(
      '/api/prompt/patch',
      { brand, batch, ad, variation, prompt, patch },
      { ok: false },
    ),
  exportBatchUrl: (brand: string, batch: string, includeArchived = false) => {
    const q = new URLSearchParams({ brand, batch });
    if (includeArchived) q.set('archived', '1');
    return `/api/export/batch?${q}`;
  },
  // ── Design mode (scene-graph docs; see src/lib/sceneGraph.ts + lib/designstore.mjs) ──
  listDesigns: (brand?: string | null) =>
    jget<{ ok: boolean; designs: import('./types').DesignSummary[] }>(
      `/api/designs${brand ? `?brand=${encodeURIComponent(brand)}` : ''}`, { ok: false, designs: [] }),
  getDesign: (id: string) =>
    jget<{ ok: boolean; design?: import('./lib/sceneGraph').DesignDoc }>(`/api/design?id=${encodeURIComponent(id)}`, { ok: false }),
  saveDesign: (design: import('./lib/sceneGraph').DesignDoc, thumb?: string | null) =>
    jpost<{ ok: boolean; design?: import('./lib/sceneGraph').DesignDoc; error?: string }>('/api/design/save', { design, thumb }, { ok: false }),
  deleteDesign: (id: string) =>
    jpost<{ ok: boolean }>('/api/design/delete', { id }, { ok: false }),
  exportDesign: (id: string, png?: string | null, svg?: string | null) =>
    jpost<{ ok: boolean; dir?: string; files?: string[]; error?: string }>('/api/design/export', { id, png, svg }, { ok: false }),

  // ── Reference-first design: extraction, skeletons, elements, batch apply ──
  extractLayout: (source: { kind: 'trendtrack' | 'upload' | 'render' | 'figma'; ref: string }, runId?: string) =>
    jpost<{ ok: boolean; skeleton?: import('./lib/sceneGraph').Skeleton; cached?: boolean; canceled?: boolean; runId?: string; error?: string }>(
      '/api/design/extract', { source, runId }, { ok: false },
    ),
  extractCancel: (runId: string) =>
    jpost<{ ok: boolean; canceled?: boolean }>('/api/design/extract/cancel', { runId }, { ok: false }),
  listSkeletons: (brand?: string | null) =>
    jget<{ ok: boolean; skeletons: import('./types').SkeletonSummary[] }>(
      `/api/skeletons${brand ? `?brand=${encodeURIComponent(brand)}` : ''}`, { ok: false, skeletons: [] }),
  getSkeleton: (id: string) =>
    jget<{ ok: boolean; skeleton?: import('./lib/sceneGraph').Skeleton }>(`/api/skeleton?id=${encodeURIComponent(id)}`, { ok: false }),
  saveSkeleton: (skeleton: import('./lib/sceneGraph').Skeleton) =>
    jpost<{ ok: boolean; skeleton?: import('./lib/sceneGraph').Skeleton; error?: string }>('/api/skeleton/save', { skeleton }, { ok: false }),
  applyDesignBatch: (id: string, images: { src: string; label?: string; source?: { kind: string; ref: string } }[]) =>
    jpost<{ ok: boolean; created?: { id: string; name: string }[]; error?: string }>('/api/design/apply-batch', { id, images }, { ok: false }),
  listElements: () =>
    jget<{ ok: boolean; elements: import('./types').SavedElement[] }>('/api/elements', { ok: false, elements: [] }),
  saveElement: (name: string, layers: import('./lib/sceneGraph').Layer[], canvas: { w: number; h: number }) =>
    jpost<{ ok: boolean; elements?: import('./types').SavedElement[] }>('/api/elements/save', { name, layers, canvas }, { ok: false }),
  deleteElement: (id: string) =>
    jpost<{ ok: boolean; elements?: import('./types').SavedElement[] }>('/api/elements/delete', { id }, { ok: false }),
  designHtmlUrl: (id: string) => `/api/design/html?id=${encodeURIComponent(id)}`,
  runDesignAgent: (id: string, instruction: string) =>
    jpost<{ ok: boolean; design?: import('./lib/sceneGraph').DesignDoc; source?: string; error?: string }>(
      '/api/design/agent', { id, instruction }, { ok: false },
    ),

  // ── Planner (Plan mode brain) ──
  planRun: (opts: { mode: 'brief' | 'refs'; brief?: string; refIds?: string[]; brand?: string | null; product?: string; adType?: string }) =>
    jpost<{ ok: boolean; runId?: string; error?: string }>('/api/plan/run', opts, { ok: false }),
  planActiveRun: () =>
    jget<{ ok: boolean; run: import('./types').PlanRun | null }>('/api/plan/run', { ok: false, run: null }),
  planRefs: (q: string, brand?: string | null) =>
    jget<{ ok: boolean; refs: import('./types').PlanRef[] }>(
      `/api/plan/refs?q=${encodeURIComponent(q)}${brand ? `&brand=${encodeURIComponent(brand)}` : ''}`,
      { ok: false, refs: [] },
    ),

  // ── Taste (approve/reject feedback → ranking weights) ──
  getTaste: () => jget<{ ok: boolean; votes: Record<string, 1 | -1> }>('/api/taste', { ok: false, votes: {} }),
  voteTaste: (key: string, verdict: 1 | -1 | 0) =>
    jpost<{ ok: boolean; votes: Record<string, 1 | -1> }>('/api/taste', { key, verdict }, { ok: false, votes: {} }),
  trendtrackImport: (brand: string, limit = 25) =>
    jpost<{ ok: boolean; brand?: string; cached?: number; images?: number; creditsRemaining?: number | null; error?: string }>(
      '/api/trendtrack/import', { brand, limit }, { ok: false },
    ),
  trendtrackImageUrl: (id: string) => `/api/trendtrack/image/${encodeURIComponent(id)}`,

  // Daily-cap Continue — grant +10 more pts of the weekly window for today (see lib/usage.mjs).
  dailyCapContinue: () =>
    jpost<{ ok: boolean; dailyCap?: import('./types').DailyCap; blockers?: import('./types').Blockers }>(
      '/api/daily-cap/continue', {}, { ok: false },
    ),
  // Gen settings (graceSeconds + budget caps), owned by lib/usage.mjs (.state/settings.json).
  getSettings: () =>
    jget<{ ok: boolean; settings: GenSettings }>('/api/settings', { ok: false, settings: DEFAULT_SETTINGS }),
  setSettings: (partial: Partial<GenSettings>) =>
    jpost<{ ok: boolean; settings: GenSettings }>('/api/settings', partial, { ok: false, settings: DEFAULT_SETTINGS }),
  // Remove matching job records now (failed/canceled/done/all). Auto-clear handles the common
  // case; this is the explicit form used by any manual clear.
  clearJobs: (scope: 'failed' | 'canceled' | 'done' | 'all', opts?: { brand?: string; batch?: string }) =>
    jpost<{ ok: boolean; cleared: number }>('/api/jobs/clear', { scope, ...opts }, { ok: false, cleared: 0 }),
  // Requeue failed jobs (attempts→0, status→queued). Used by the StatusBanner "Retry all".
  retryFailed: (opts?: { brand?: string; batch?: string }) =>
    jpost<{ ok: boolean; requeued: number }>('/api/jobs/retry', { scope: 'failed', ...opts }, { ok: false, requeued: 0 }),

  // ── Design agent v2 (AgentPanel): chat history + runs with mode/attachments ──
  // Contracts (server routes may land concurrently — every call degrades to a safe fallback):
  //   GET  /api/design/chat?id → { ok, messages:[{role,text,at,runId?,attachments?,result?}] }
  //   POST /api/design/agent   { id, instruction?, mode?:'improve', attachments?:[{ref,note}] }
  //                            → { ok, design, steps, source, lint? }
  getDesignChat: (id: string) =>
    jget<{
      ok: boolean;
      messages: {
        role: string;
        text: string;
        at: number;
        runId?: string;
        attachments?: { ref: string; note?: string }[];
        result?: { applied?: number; source?: string; model?: string; inTok?: number; outTok?: number; turns?: number; parts?: number };
      }[];
    }>(`/api/design/chat?id=${encodeURIComponent(id)}`, { ok: false, messages: [] }),
  designAgentRun: (opts: {
    id: string;
    instruction?: string;
    mode?: 'improve' | 'generate';
    attachments?: { ref: string; note?: string }[];
    /** Referenced canvas node ids (chat @-chips) — scopes the agent's observe() server-side. */
    focusIds?: string[];
  }) =>
    jpost<{
      ok: boolean;
      design?: import('./lib/sceneGraph').DesignDoc;
      steps?: unknown[];
      source?: string;
      lint?: unknown;
      verify?: { ready?: boolean; layoutScore?: number; lintCount?: number; skeletonIoU?: number | null };
      applied?: number;
      error?: string;
    }>('/api/design/agent', opts, { ok: false }),
  // LLM provider info (which agent/model runs design chat) + usage rollups.
  getLlmUsage: () =>
    jget<{ ok: boolean; provider?: { base?: string; model?: string; provider?: string }; hasLlm?: boolean }>(
      '/api/llm/usage', { ok: false }),
  // Per-brand agent memory (free text the design agent reads/writes).
  getMemory: (brand: string) =>
    jget<{ ok: boolean; text?: string }>(`/api/memory?brand=${encodeURIComponent(brand)}`, { ok: false }),
  saveMemory: (brand: string, text: string) =>
    jpost<{ ok: boolean }>(`/api/memory?brand=${encodeURIComponent(brand)}`, { text }, { ok: false }),

  // ── LLM provider config (AgentPanel model switcher) ──
  // GET may 404 on servers without the route yet — callers must treat { ok:false } as
  // "read-only provider chip". POST switches the active provider (apiKey optional).
  getLlmConfig: () =>
    jget<{
      ok: boolean;
      config?: { baseUrl?: string; model?: string; label?: string };
      presets?: { label: string; baseUrl: string; model: string }[];
    }>('/api/llm/config', { ok: false }),
  setLlmConfig: (cfg: { baseUrl: string; model: string; apiKey?: string }) =>
    jpost<{ ok: boolean; config?: { baseUrl?: string; model?: string; label?: string }; error?: string }>(
      '/api/llm/config', cfg, { ok: false },
    ),

  // ── True live sync (Figma-style) — see the protocol doc at the top of Editor.tsx ──
  // Fire-and-forget mid-gesture frames: POST /api/design/live never touches disk; the server
  // just fans the boxes out to every other tab over SSE 'live'.
  designLive: (payload: {
    id: string;
    origin: string;
    nodes: { id: string; box: { x: number; y: number; w: number; h: number }; rotation?: number }[];
  }) => jpost<{ ok: boolean }>('/api/design/live', payload, { ok: false }),
};
