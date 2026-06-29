// Typed fetch client for the studio-server (§3). Same-origin in prod; Vite proxies in dev.
// Every call resolves to a safe fallback on network/parse error rather than throwing.
import type { Config, BatchState, Health, GenerateScope } from './types';

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
  queue: { running: 0, queued: 0, done: 0, failed: 0 },
  archivedCount: 0,
});

export const api = {
  getConfig: () => jget<Config>('/api/config', { brands: [] }),
  getState: (brand: string, batch: string) =>
    jget<BatchState>(`/api/state?brand=${encodeURIComponent(brand)}&batch=${encodeURIComponent(batch)}`, emptyState(brand, batch)),
  getHealth: () =>
    jget<Health>('/api/health', { ok: false, bridge: false, codex: { alive: false }, queue: { running: 0, queued: 0, done: 0, failed: 0 } }),
  imgUrl: (relPath: string, w?: number) =>
    `/img?path=${encodeURIComponent(relPath)}${w ? `&w=${w}` : ''}`,
  generate: (brand: string, batch: string, scope: GenerateScope, variants: number) =>
    jpost<{ ok: boolean; enqueued: number }>('/api/generate', { brand, batch, scope, variants }, { ok: false, enqueued: 0 }),
  regenerate: (relPath: string) =>
    jpost<{ ok: boolean }>('/api/regenerate', { relPath }, { ok: false }),
  cancel: (arg: { jobId?: string; all?: boolean }) =>
    jpost<{ ok: boolean }>('/api/cancel', arg, { ok: false }),
  archive: (relPath: string, archived: boolean) =>
    jpost<{ ok: boolean }>('/api/archive', { relPath, archived }, { ok: false }),
};
