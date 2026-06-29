// Shared data contract. Mirrors studio-server.mjs §3 API shapes. Every component imports from here.

export type SlotStatus = 'empty' | 'queued' | 'generating' | 'done' | 'failed' | 'archived';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export interface JobRef {
  id: string;
  status: JobStatus;
  error?: string | null;
  startedAt?: number | null;
}

export interface Slot {
  run: number;                // run index this slot represents
  status: SlotStatus;
  version?: number;           // 1 = base run-N.png, 2 = run-N-v2.png, ...
  relPath?: string;           // present when done/archived
  thumbUrl?: string;          // /img?path=...&w=320 when done
  job?: JobRef | null;        // present when queued/generating/failed
}

export interface PromptNode { id: string; slots: Slot[]; }
export interface VariationNode { id: string; label?: string; prompts: PromptNode[]; }
export interface AdNode { id: string; title?: string; type?: string; variations: VariationNode[]; }

export interface CodexProgress { done: number; total: number; failed: number; skipped: number; current?: string | null; }
export interface CodexInfo { alive: boolean; progress?: CodexProgress | null; }
export interface QueueInfo { running: number; queued: number; done: number; failed: number; }

export interface BatchState {
  brand: string;
  batch: string;
  ads: AdNode[];
  codex: CodexInfo;
  queue: QueueInfo;
  archivedCount: number;
}

export interface BatchRef { code: string; name?: string; aspect?: string; }
export interface BrandRef { id: string; name?: string; batches: BatchRef[]; }
export interface Config { brands: BrandRef[]; }

export interface Health { ok: boolean; bridge: boolean; codex: { alive: boolean }; queue: QueueInfo; }

export interface ActivityJob {
  id: string; ad: string; variation: string; prompt: string; run: number;
  status: JobStatus; startedAt?: number | null; error?: string | null;
}

// Targets for POST /api/generate. Exactly one of ads / variation / prompt; omit all = whole batch.
export type GenerateScope = {
  ads?: string[];
  variation?: { ad: string; variation: string };
  prompt?: { ad: string; variation: string; prompt: string };
};
