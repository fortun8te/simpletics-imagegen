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
  generate: (brand: string, batch: string, scope: GenerateScope, variants: number) =>
    jpost<{ ok: boolean; enqueued: number }>('/api/generate', { brand, batch, scope, variants }, { ok: false, enqueued: 0 }),
  regenerate: (relPath: string) =>
    jpost<{ ok: boolean }>('/api/regenerate', { relPath }, { ok: false }),
  // Revise = re-generate this slot with the original prompt PLUS a change instruction; queues a new
  // version. Always uses the ORIGINAL image as a reference; extraRefs are uploaded board image ids.
  revise: (relPath: string, instruction: string, extraRefs: string[] = []) =>
    jpost<{ ok: boolean; enqueued?: number; refs?: number }>('/api/revise', { relPath, instruction, extraRefs }, { ok: false }),
  // Upload a reference image (base64 data URL) for the Revise board → returns { id, url }.
  uploadRef: (dataUrl: string) =>
    jpost<{ ok: boolean; id?: string; url?: string }>('/api/upload-ref', { dataUrl }, { ok: false }),
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
};
