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

// Run state machine (worker-owned). `cooling` = paused by a codex rate-limit; auto-resumes at resumeAt.
export type RunState = 'idle' | 'running' | 'paused' | 'cooling' | 'done';
export interface RunInfo {
  state: RunState;
  running: number;
  queued: number;
  done: number;
  failed: number;
  total: number;            // running + queued + done + failed for the current run
  resumeAt?: number | null; // epoch ms when a cooling run auto-resumes
}

// Best-effort codex usage/quota. `known:false` → show an honest "unknown", never a fake number.
export interface CodexUsage {
  known: boolean;
  remaining?: number | null;
  total?: number | null;
  percent?: number | null;       // 0-100 remaining
  label?: string;                // e.g. "62% left", "unknown"
  sessionGenerated?: number;     // fallback signal: images generated this session
  resetAt?: number | null;       // epoch ms when the quota window resets, if known
}

export interface BatchState {
  brand: string;
  batch: string;
  ads: AdNode[];
  codex: CodexInfo;
  queue: QueueInfo;
  run: RunInfo;
  codexUsage?: CodexUsage;
  archivedCount: number;
}

export interface BatchRef { code: string; name?: string; aspect?: string; }
export interface BrandRef { id: string; name?: string; batches: BatchRef[]; }
export interface Config { brands: BrandRef[]; }

export type BatchKind = 'ads' | 'listicle';
export interface BatchMeta { code: string; name: string; kind: BatchKind; modifiedAt: number; count: number; }

// Prompt + reference for the detail drawer.
export interface PromptInfo { ok: boolean; text: string; refName?: string | null; refUrl?: string | null; }

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
