// Shared data contract. Mirrors studio-server.mjs §3 API shapes. Every component imports from here.

export type SlotStatus = 'empty' | 'queued' | 'waiting' | 'generating' | 'done' | 'failed' | 'archived';
export type JobStatus = 'queued' | 'waiting' | 'running' | 'done' | 'failed' | 'canceled';

// Failure classification (see contract §Failure auto-clear). Only present on failed jobs.
export type FailReason = 'auth' | 'rate_limit' | 'other';

export interface JobRef {
  id: string;
  status: JobStatus;
  error?: string | null;
  startedAt?: number | null;
  // Queue priority (lower = earlier in line); only meaningful while status === 'queued'. Drives the
  // ActivityDock drag-to-reorder sort. See studio-server.mjs POST /api/queue/reorder.
  order?: number | null;
  // Epoch ms when a `waiting` job will spawn (Codex spent). Present only while status === 'waiting'.
  spendAt?: number | null;
  // Failure classification. Present only on failed jobs.
  reason?: FailReason;
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
export interface QueueInfo { running: number; queued: number; waiting: number; done: number; failed: number; }

// Run state machine (worker-owned). `cooling` = rate-limit countdown; `ready` = cooldown elapsed,
// waiting for the user to verify quota and explicitly continue (never auto-resumes).
export type RunState = 'idle' | 'running' | 'paused' | 'cooling' | 'ready' | 'done';
export interface RunInfo {
  state: RunState;
  running: number;
  queued: number;
  waiting?: number;         // jobs in the cancel-free waiting window
  done: number;
  failed: number;
  total: number;            // running + queued + done + failed for the current run
  resumeAt?: number | null; // epoch ms when a cooling run becomes `ready`
}

// Codex usage/quota, estimated from local activity (contract §codexUsage object). Counts merge &
// dedupe timestamps from the system-wide chatgpt-unlimited usage log + this app's own done jobs.
// `known:false` → show an honest "unknown", never a fake number. Legacy fields (remaining/percent/
// resetAt/limit) kept optional so any older callers keep compiling; new UI reads the fields below.
export interface CodexUsage {
  known: boolean;
  plan?: string | null;          // e.g. "Plus" from JWT, else null
  authOk?: boolean;              // false when refresh token known-dead
  used5h?: number;              // generations in trailing 5h
  used7d?: number;              // generations in trailing 7d
  cap5h?: number | null;        // = budget.maxPer5h (null = unlimited)
  cap7d?: number | null;        // = budget.maxPer7d
  cooling?: { resetAt: number } | null; // active rate-limit cooldown
  label?: string;                // short human summary, e.g. "12 in last 5h"
  sessionGenerated?: number;     // images generated this session
  // REAL codex rate-limit snapshot (same source as codex `/usage`); null if none recorded.
  // Percents are 0..100 REMAINING; reset times + asOf are epoch ms.
  codex?: {
    fivehLeft: number | null;
    fivehResetsAt: number | null;
    weeklyLeft: number | null;
    weeklyResetsAt: number | null;
    asOf: number;
  } | null;
  // Legacy / optional signals (pre-redesign shape).
  remaining?: number | null;
  total?: number | null;
  percent?: number | null;
  limit?: number | null;
  resetAt?: number | null;
}

// Daily-cap readout (lib/usage.mjs getDailyCap). Points are percentage points of the WEEKLY
// codex window; the cap is 1.5 × the fair daily share (100/7 ≈ 14.3 → cap ≈ 21.4 pts/day).
export interface DailyCap {
  measurable: boolean;   // false = codex has no weekly snapshot yet; cap can't block
  blocked: boolean;
  spentToday: number;    // pts of weekly quota consumed today
  capPts: number;        // the base 1.5× daily share (≈21.4)
  bonusPts: number;      // extra pts granted via Continue (+10 each)
  allowedPts: number;    // capPts + bonusPts
  weeklyLeft: number | null;
  asOf: number | null;   // epoch ms of the codex snapshot the readout is based on
}

// Active generation blockers (contract §blockers object). Drives the StatusBanner.
export interface Blockers {
  auth: boolean;                        // generation failing due to dead codex auth
  cooling: { resetAt: number } | null;  // rate-limit cooldown active
  budget: boolean;                      // a self-imposed cap is currently blocking spawns
  dailyCap?: DailyCap | null;           // present (full readout) only while the daily cap blocks
}

// Self-imposed budget caps (contract §Settings). null = unlimited.
export interface BudgetSettings { maxPer5h: number | null; maxPer7d: number | null; }
export interface GenSettings { graceSeconds: number; budget: BudgetSettings; }

export interface ResumeResult {
  ok: boolean;
  resumed?: boolean;
  stillLimited?: boolean;
  reason?: string;
  resetAt?: number | null;
  error?: string | null;
  run?: RunInfo;
  codexUsage?: CodexUsage;
  blockers?: Blockers;
}

export interface BatchState {
  brand: string;
  batch: string;
  ads: AdNode[];
  codex: CodexInfo;
  queue: QueueInfo;
  run: RunInfo;
  codexUsage?: CodexUsage;
  blockers?: Blockers;
  archivedCount: number;
}

export interface BatchRef { code: string; name?: string; aspect?: string; }
export interface BrandRef { id: string; name?: string; batches: BatchRef[]; }

// Authoring shapes from config.json (returned by GET /api/config).
export interface ConfigModel { id: string; prompt?: string; }
export interface ConfigPromptEntry {
  id: string;
  label?: string;
  prompt: string;
  recipe?: PromptRecipe;
}
export interface ConfigVariation {
  id: string;
  label?: string;
  copy?: string;
  prompt?: string;
  model?: string;
  prompts?: ConfigPromptEntry[];
}
export interface ConfigAd {
  id: string;
  title?: string;
  type?: string;
  product?: string;
  kind?: string;
  ref?: string;
  extraRefs?: string[];
  models?: ConfigModel[];
  variations: ConfigVariation[];
}
export interface ConfigBatch extends BatchRef {
  ads?: ConfigAd[];
}
export interface ConfigBrand extends BrandRef {
  batches: ConfigBatch[];
}
export interface Config { brands: ConfigBrand[]; }

export type BatchViewMode = 'gallery' | 'plan' | 'design';

// ── Planner (Phase 1) ────────────────────────────────────────────────────────────────────────────
// A cached TrendTrack ref as the planner ranks it (0-credit local reads; lib/planner.mjs).
export interface PlanRef {
  id: string; brand: string; hook: string | null; primary_text: string | null;
  scaling_verdict: string | null; reach: number | null; days_running: number | null;
  cta: string | null; media_type: string | null; local_image: string | null;
  score: number | null;
}
export interface PlanPromptDraft { id: string; hook: string; prompt: string }
export interface PlanProposal {
  mode: 'brief' | 'refs'; adType: string; brief: string;
  hypothesis: string; hypothesisSource: 'codex' | 'fallback';
  refs: PlanRef[]; prompts: PlanPromptDraft[];
}
export interface PlanRunStep { i: number; tool: string; summary: string; data?: unknown; at: number }
export interface PlanRun {
  id: string; steps: PlanRunStep[]; done: boolean;
  result?: PlanProposal | null; error?: string; startedAt?: number; finishedAt?: number;
}

// ── Design mode (Phase 2) ────────────────────────────────────────────────────────────────────────
export interface DesignSummary {
  id: string; name: string; template?: string; adType?: string;
  brand?: string | null;
  layers: number; updatedAt: number; createdAt: number;
  /** Gallery preview PNG (written on save) or null. */
  thumb?: string | null;
  /** User labels for gallery filtering (server-persisted on the design doc). */
  tags?: string[];
}

export interface SkeletonSummary {
  id: string; name: string; canvas: { w: number; h: number };
  brand?: string | null;
  layerCount: number;
  sourceRef?: { kind: string; ref: string; url: string; label?: string } | null;
  extractedBy: 'codex' | 'manual' | 'figma';
  createdAt: number;
}

export interface SavedElement {
  id: string; name: string; canvas: { w: number; h: number };
  layers: import('./lib/sceneGraph').Layer[];
  createdAt: number;
}
export type PromptRefRole = 'product' | 'layout' | 'model' | 'extra' | 'tube';
export interface PromptRef { role: PromptRefRole; name: string; url: string; }

export type BatchKind = 'ads' | 'listicle';
export interface BatchMeta { code: string; name: string; kind: BatchKind; modifiedAt: number; count: number; }

// Prompt + references for the detail drawer and Plan view.
export interface PromptInfo {
  ok: boolean;
  text: string;
  label?: string | null;
  copy?: string | null;
  /** @deprecated use refs[] */
  refName?: string | null;
  /** @deprecated use refs[] */
  refUrl?: string | null;
  recipe?: PromptRecipe;
  refs?: PromptRef[];
}

// Optional block-recipe metadata for a compiled prompt string (config.json `variations[].prompts[]`
// entries). Additive/forward-looking: a future block-library tool can record which named blocks
// were compiled into `prompt` and when, without changing how `prompt` itself is read today.
export interface PromptRecipe { blocks: Record<string, string>; compiledAt: string | null; }

// Rolling average generation duration (lib/jobstore.mjs avgDurationSeconds()), used to show
// "~Xs per image" + a batch ETA in GenerateDialog. `fallback:true` = no completed-job history yet,
// `seconds` is the default estimate (not a fabricated measurement).
export interface GenEstimate { seconds: number; samples: number; fallback: boolean; }

export interface Health { ok: boolean; bridge: boolean; codex: { alive: boolean }; queue: QueueInfo; estimate?: GenEstimate; codexUsage?: CodexUsage; blockers?: Blockers; }

export interface ActivityJob {
  id: string; ad: string; variation: string; prompt: string; run: number;
  status: JobStatus; startedAt?: number | null; error?: string | null;
  spendAt?: number | null; reason?: FailReason;
}

// Targets for POST /api/generate. Exactly one of ads / variation / prompt; omit all = whole batch.
export type GenerateScope = {
  ads?: string[];
  variation?: { ad: string; variation: string };
  prompt?: { ad: string; variation: string; prompt: string };
};
