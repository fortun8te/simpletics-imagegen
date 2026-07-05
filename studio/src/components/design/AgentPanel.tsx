// AgentPanel — the Agent tab of the design editor's right panel: a quiet, dense chat UI over
// the design agent (opencode/Codex aesthetic — monochrome, no bubbles, faint dividers).
//
// Structure: header (title · model · clear) / plain message list (user lines prefixed "›",
// agent runs as ONE muted result line each with a chevron disclosure for the narration +
// steps) / composer (textarea, ⌘↵ send, "＋" menu for attach/improve/draft-copy, "@" element
// referencing). Message history comes from GET /api/design/chat (refetched after every run);
// runs go through POST /api/design/agent.
//
// ELEMENT REFERENCING: the Editor passes the current canvas selection ({id,name}[]). The "@"
// button (or typing @ in the textarea) turns it into reference chips; on send their node ids
// go up as `focusIds`, which the server hands to the agent's observe() scope.
//
// The panel never mutates the document itself: on a successful run it hands the returned doc
// to the Editor via onApply (one undo step through the existing pushHistory path).
import { useCallback, useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useStore, type AgentEvent, type SubAgentEvent } from '../../store';
import { api } from '../../api';
import { Icon } from '../Icon';
import { PersonaIdentity } from '../ai/Persona';
import {
  ChainOfThought, ChainOfThoughtHeader, ChainOfThoughtContent, ChainOfThoughtStep,
} from '../ai/ChainOfThought';
import AgentActivity, { stepIcon, type SubAgent } from './AgentActivity';
import { RefLightbox, type RefLightboxTarget } from '../RefLightbox';
import type { DesignDoc } from '../../lib/sceneGraph';
import styles from './AgentPanel.module.css';

type Step = NonNullable<AgentEvent['step']>;

// Reduce the store's `subagent` SSE frames (SubAgentEvent[]) into the worker-list shape
// AgentActivity renders. FIELD MAPPING (the two shapes name the same things oppositely):
//   store.status = the live substatus LINE   → AgentActivity.phase  (the shimmering sub-line)
//   store.phase  = the lifecycle start|update|done → AgentActivity.status running|done
// Dedupe by id (latest frame wins — the store already collapses start→update→done onto one row,
// so we just take what's there in order). A worker whose lifecycle reached 'done' is marked done
// (or error, when its final substatus line reports a failure) so the row swaps its shimmering
// diamond for a check / X instead of shimmering forever.
// Widened beyond a bare "fail" prefix: reasoning-model substatus lines report failure in more
// shapes than "Failed …" (timeouts, "could not/couldn't …", explicit "error …"), and a worker
// that never trips this regex sits marked 'done' with a failure message underneath it forever.
const ERROR_LINE_RE = /^(fail|error|timeout|timed out|could not|couldn't)/i;
// An agent line that is raw op-log / harness bookkeeping, not a sentence to show a human. These
// stored on many historical edit turns ("move L85 → 438,852 · smartAd: …", "skipped setStyle: L2
// is element-built — use {"op":"setParams"}", "text L2.text → …", "element ig-caption → L4 @ …").
// When a turn's body matches this, the clean "Edited N layers" summary row carries it instead, so
// a long populated thread stops reading as a wall of internal jargon.
const OP_LOG_RE = /^(move|resize|setstyle|setparams|settext|text|element|add|remove|group|ungroup|duplicate|template|autolayout|reparent|align|center|distribute|order|cutout|skipped|rebuilt)\b|→|·\s|\{"op"/i;
// A worker frame with no title yet (phase 'start' before the backend has named the task) still
// needs to render — AgentActivity shows it as "New subagent / Starting up" — so only `id` is
// required here; `title` may legitimately be empty on that first frame.
const reduceSubAgents = (events: SubAgentEvent[]): SubAgent[] => {
  const byId = new Map<string, SubAgent>();
  for (const ev of events) {
    if (!ev?.id) continue;
    const line = (ev.status || '').trim();
    const status = ev.phase === 'done'
      ? (ERROR_LINE_RE.test(line) ? 'error' : 'done')
      : 'running';
    byId.set(ev.id, {
      id: ev.id,
      title: ev.title || '',
      model: ev.model || undefined,
      status,
      phase: line || undefined,
    });
  }
  return [...byId.values()];
};

// Fallback source (kept for backward-compat): when the dedicated `subagent` store slice is empty
// but a worker shape rides along inside a step's `data`, surface it so nothing regresses in a
// session where only the step stream carries workers. Same error-line detection as reduceSubAgents
// (UI-12) — this path previously had none, so a failed fallback worker never flipped to 'error'.
const collectSubAgents = (steps: Step[]): SubAgent[] => {
  const byId = new Map<string, SubAgent>();
  for (const s of steps) {
    const d = s.data as Partial<SubAgent> & { subagent?: Partial<SubAgent> } | undefined;
    const sa = d?.subagent ?? (d && d.id ? d : undefined);
    if (sa?.id) {
      const phase = sa.phase ?? ((s.summary || '').trim() || undefined);
      const status = sa.status === 'done' && phase && ERROR_LINE_RE.test(phase.trim())
        ? 'error'
        : sa.status;
      byId.set(sa.id, {
        id: sa.id, title: sa.title || '', model: sa.model,
        status, phase,
      });
    }
  }
  return [...byId.values()];
};

// ── what-changed digest ──────────────────────────────────────────────────────────────────────
// Parse the run's op steps (step.data.op.op — the op-code — falling back to the summary's verb
// prefix for the rare deterministic passes that have no raw `op`) into one compact recap line:
// "Moved 2 · Restyled 3 · Added 1 · Removed 1". No backend change — everything here already rides
// on the same `lastSteps` array the "Details" disclosure renders. Each bucket's title attr lists
// the touched layer names so hovering the digest tells you exactly what moved/restyled/etc.
type DigestBucket = 'Moved' | 'Resized' | 'Restyled' | 'Rewrote' | 'Added' | 'Removed' | 'Grouped';
const OP_BUCKET: Record<string, DigestBucket> = {
  move: 'Moved', center: 'Moved', align: 'Moved', distribute: 'Moved', order: 'Moved', reparent: 'Moved',
  resize: 'Resized',
  setStyle: 'Restyled', cutout: 'Restyled', setParams: 'Restyled',
  setText: 'Rewrote',
  add: 'Added', duplicate: 'Added', template: 'Added', element: 'Added', autolayout: 'Added',
  remove: 'Removed',
  group: 'Grouped', ungroup: 'Grouped',
};
// Fallback when a deterministic pass step has no raw `op` — sniff the summary's leading verb.
const SUMMARY_BUCKET: [RegExp, DigestBucket][] = [
  [/^move\b/i, 'Moved'], [/^resize\b/i, 'Resized'],
  [/^style\b/i, 'Restyled'], [/^text\b/i, 'Rewrote'],
  [/^remove\b/i, 'Removed'], [/^group|ungroup/i, 'Grouped'],
  [/^rebuilt|^template|^added/i, 'Added'],
];
interface DigestEntry { bucket: DigestBucket; count: number; names: string[] }
const buildDigest = (steps: Step[]): DigestEntry[] => {
  const byBucket = new Map<DigestBucket, { count: number; names: Set<string> }>();
  for (const st of steps) {
    if (st.kind !== 'op') continue;
    const d = st.data as { op?: { op?: string; id?: string }; name?: string; id?: string; chat?: boolean } | undefined;
    if (d?.chat) continue; // conversational op-step, not a real edit
    const opCode = d?.op?.op;
    let bucket = opCode ? OP_BUCKET[opCode] : undefined;
    if (!bucket) {
      const hit = SUMMARY_BUCKET.find(([re]) => re.test(st.summary || ''));
      bucket = hit?.[1];
    }
    if (!bucket) continue;
    const name = d?.name || d?.id || d?.op?.id;
    const entry = byBucket.get(bucket) || { count: 0, names: new Set<string>() };
    entry.count += 1;
    if (name) entry.names.add(name);
    byBucket.set(bucket, entry);
  }
  const order: DigestBucket[] = ['Moved', 'Resized', 'Restyled', 'Rewrote', 'Added', 'Removed', 'Grouped'];
  return order
    .filter((b) => byBucket.has(b))
    .map((bucket) => ({ bucket, count: byBucket.get(bucket)!.count, names: [...byBucket.get(bucket)!.names] }));
};

// ── suggested follow-ups ─────────────────────────────────────────────────────────────────────
// Cheap client-side heuristics on the just-finished run's kind/result/digest — no LLM call. Always
// offers "Undo that" once something applied; the rest are contextual to what kind of run just ran.
const followUpsFor = (m: ChatMessage, digest: DigestEntry[], hasReference: boolean): string[] => {
  const r = m.result;
  if (!r || r.kind === 'chat') return [];
  const buckets = new Set(digest.map((d) => d.bucket));
  const suggestions: string[] = [];
  if (r.source === 'self-improve' || /match.the.reference/i.test(m.text)) {
    suggestions.push('Make it dark mode', 'Fix spacing', 'Try a punchier headline');
  } else if (hasReference && (r.source === 'copy' || /copied the reference/i.test(m.text))) {
    suggestions.push('Match the reference (deep)', 'Make it dark mode', 'Fix spacing');
  } else if (buckets.has('Rewrote')) {
    suggestions.push('Try a punchier headline', 'Fix spacing', 'Improve pass');
  } else if (buckets.has('Restyled')) {
    suggestions.push('Make it dark mode', 'Fix spacing');
  } else if (buckets.has('Moved') || buckets.has('Resized')) {
    suggestions.push('Fix spacing', 'Improve pass');
  } else {
    suggestions.push('Improve pass', 'Fix spacing');
  }
  suggestions.push('Undo that');
  return [...new Set(suggestions)].slice(0, 4);
};

export interface ChatResult {
  applied?: number; source?: string; model?: string;
  inTok?: number; outTok?: number; turns?: number; parts?: number;
  verifyReady?: boolean;
  /** 'chat' | 'edit' | 'copy' — a conversational reply changed nothing and renders as plain text,
   *  no summary/undo/revert row (mirrors the server's `runKind` stored alongside the chat line). */
  kind?: string;
}
export interface ChatMessage {
  role: string; // 'user' | 'agent'
  text: string;
  at: number;
  runId?: string;
  attachments?: { ref: string; note?: string }[];
  result?: ChatResult;
}

interface PendingAttachment { ref: string; url: string; note: string }
interface SelectionRef { id: string; name: string }

interface AgentPanelProps {
  docId: string;
  /** Save the doc before a run (the server agent reads the persisted doc). */
  ensureSaved: () => Promise<boolean>;
  /** Apply an agent-produced doc (Editor: one pushHistory + settle + setDoc). */
  onApply: (design: DesignDoc) => void;
  /** Fires when the user starts a run (Editor auto-switches to the Agent tab + locks editing). */
  onRunStart: () => void;
  /** Fires when the run settles either way (Editor unlocks editing). */
  onRunEnd: () => void;
  /** One-click undo of the latest applied run (the apply was ONE history step). */
  onUndoRun: () => void;
  flash: (m: string) => void;
  /** Workspace brand for kit/skill panel */
  brand?: string;
  /** Current canvas selection (id + display name) — the "@" reference source. */
  selection: SelectionRef[];
  /** The comp's attached reference (the ad it was copied from), if any. Enables the
   *  "Match the reference" self-improvement loop; absent → the action is hidden. */
  reference?: { kind: string; ref: string; label?: string } | null;
  /** A queued "copy this reference" run (drop / paste / attach / library pick). When this changes
   *  to a fresh nonce the panel runs it through the SAME live run path as a chat edit — so it shows
   *  up streaming in the feed, is stoppable, and gets a "revert this run" checkpoint. */
  pendingCopy?: { nonce: number; ref: string; label?: string; instruction?: string } | null;
  /** Fires when a queued copy run has been consumed (started), so the Editor can clear it. */
  onCopyConsumed?: () => void;
}

const DRAFT_COPY_PROMPT =
  'Rewrite the text layers with stronger ad copy based on the brief and reference';

const clearedKey = (docId: string) => `neuegen.design.chatCleared.${docId}`;

// ── slash quick-commands ─────────────────────────────────────────────────────────────────────
// Typing "/" opens a small popover of canned commands. Each either inserts+sends a fixed
// instruction or triggers an existing entry point (improve pass / match-the-reference), reusing
// the SAME run paths the ＋ menu already calls — no new server contract.
interface SlashCommand {
  cmd: string; label: string; hint: string; icon: string;
  /** Only shown when a reference is attached (mirrors the ＋ menu's "Match the reference" gate). */
  needsReference?: boolean;
}
const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: '/improve', label: 'Improve pass', hint: 'lint', icon: 'sparkles' },
  { cmd: '/copy', label: 'Copy attached reference', hint: 'reference', icon: 'copy' },
  { cmd: '/dark', label: 'Real platform dark mode', hint: 'theme', icon: 'sun' },
  { cmd: '/match', label: 'Match the reference (deep)', hint: 'deep · slow', icon: 'check', needsReference: true },
  { cmd: '/spacing', label: 'Fix spacing', hint: 'layout', icon: 'layout-grid' },
];

export default function AgentPanel({
  docId, ensureSaved, onApply, onRunStart, onRunEnd, onUndoRun, flash, selection, reference = null, brand = '',
  pendingCopy = null, onCopyConsumed,
}: AgentPanelProps) {
  const designEvents = useStore((s) => s.ui.designEvents);
  const subAgentEvents = useStore((s) => s.ui.subAgentEvents);
  const docTick = useStore((s) => s.ui.docTick);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [localEcho, setLocalEcho] = useState<ChatMessage[]>([]); // optimistic lines until the server chat catches up
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [activeAtt, setActiveAtt] = useState<number | null>(null); // which square shows its note field
  const [refs, setRefs] = useState<SelectionRef[]>([]);            // "@" reference chips → focusIds
  const [uploading, setUploading] = useState(0);
  const [running, setRunning] = useState(false);
  // full step list of the LAST finished run — rendered inside its row's disclosure
  const [lastSteps, setLastSteps] = useState<NonNullable<AgentEvent['step']>[]>([]);
  const [undoneAt, setUndoneAt] = useState(0); // hide the undo affordance once used
  // Pre-run checkpoint for the LATEST edit/copy run — the doc state BEFORE the agent touched it,
  // captured from the run response's `pre` snapshot. "Revert this run" restores it (one undo step).
  // Only the most-recent applied run is revertable (same row the "undo" affordance sits on), so a
  // single snapshot + a used flag is enough; both reset when a fresh edit/copy run applies.
  const [revert, setRevert] = useState<DesignDoc | null>(null);
  const [revertUsed, setRevertUsed] = useState(false); // hide the revert affordance once used
  // Self-improvement loop live state — the per-round fidelity score + verdict shown as a badge on
  // the activity feed. null = no loop running; the fields fill in from the loop's SSE frames.
  const [loop, setLoop] = useState<{ round: number; score: number | null; verdict: string | null } | null>(null);
  const [openAt, setOpenAt] = useState<number | null>(null); // which agent row is disclosed
  // Read-only active-model label for the composer footer. The model is a hard default
  // (Ornith) chosen server-side — there is no in-UI switching. We only READ it for display.
  const [modelLabel, setModelLabel] = useState('Ornith');
  const [clearedAt, setClearedAt] = useState<number>(() => {
    try { return Number(localStorage.getItem(clearedKey(docId))) || 0; } catch { return 0; }
  });
  // Attachment lightbox — reuses the same purpose-built RefLightbox PlanView uses for its
  // reference thumbnails. Opened from either a chat-message attachment or a composer square.
  const [lightbox, setLightbox] = useState<RefLightboxTarget | null>(null);

  // ── failed-run recovery: the last run that errored/was stopped, so a "Retry" chip can re-drive
  // it verbatim — `retry` re-invokes whichever run function actually failed (a plain chat/edit
  // send, "Match the reference", or "Copy this reference" all stop through the SAME Stop button
  // but need different re-entry calls). `kind` distinguishes a free-text send (worth restoring into
  // the composer for editing) from the two preset loops (nothing textual to edit). Cleared the
  // moment a NEW run starts (it's superseded).
  const [lastFailed, setLastFailed] = useState<{ text: string; kind: 'text' | 'preset'; retry: () => void } | null>(null);
  // ── run queue: at most ONE pending instruction queued while a run is live (sending while
  // `running` used to silently no-op — see the old `if (running) return;` guard on `run`). Shown
  // as a muted "queued: …" bubble with a cancel ×; auto-sent the moment the live run settles.
  const [queued, setQueued] = useState<{ text: string } | null>(null);
  // ── slash quick-commands popover — open when the composer's content is exactly "/" + a filter,
  // keyboard-navigable (↑↓/Enter/Esc).
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);

  const fileInput = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // "Stop" now ACTUALLY aborts the server run (POST /api/design/agent/abort by docId) in addition
  // to abandoning the client wait — the harness honors the AbortSignal and returns a clean partial.
  // runSeqRef guards the settled promise — after a stop the user can start a NEW run while the old
  // one is still in flight, and the stale settle must not touch the new run's state.
  const abandonedRef = useRef(false);
  const runSeqRef = useRef(0);
  // Whether THIS run engaged the canvas lock (onRunStart). Only edit/copy runs lock; a chat reply
  // ("yo") must not. We lock optimistically at send, then RELEASE immediately if the live stream
  // reveals the run is conversational (harness `kind:'chat'`, or its op step's data.chat flag).
  const lockedRef = useRef(false);
  const chatReleasedRef = useRef(false);
  // The run currently in flight — a short label (restored into the composer on stop, for editing)
  // + a retry callback (re-invokes whichever run function is actually live: a plain send, "Match
  // the reference", or "Copy this reference" all share the ONE Stop button but need different
  // re-entry calls). Set at the top of every run* function, read by stopRun on abort.
  const currentRunRef = useRef<{ text: string; kind: 'text' | 'preset'; retry: () => void } | null>(null);

  // ── history (tolerate both { messages } and { chat: { messages } } server shapes) ──
  const refreshChat = useCallback(async () => {
    const r = await api.getDesignChat(docId) as unknown as {
      ok: boolean; messages?: ChatMessage[]; chat?: { messages?: ChatMessage[] };
    };
    if (r.ok) {
      setMessages(r.messages || r.chat?.messages || []);
      return true;
    }
    return false;
  }, [docId]);

  useEffect(() => { void refreshChat(); }, [refreshChat]);

  // Active-model label — read once on mount for the quiet footer indicator. Display only;
  // the model itself is a server-side hard default and cannot be switched from the UI.
  useEffect(() => {
    let alive = true;
    api.getLlmUsage().then((r) => {
      if (!alive) return;
      const p = r.ok ? r.provider : null;
      if (p?.model) setModelLabel(p.provider ? `${p.provider} · ${p.model}` : p.model);
    });
    return () => { alive = false; };
  }, []);

  // live step feed while running — scoped to THIS doc so a run on another variant can't bleed
  // in or wipe this one's history (frames without docId — the pre-doc extract flow — pass
  // through unfiltered so that rail isn't broken).
  const docEvents = designEvents.filter((e) => e.docId == null || e.docId === docId);
  const runId = docEvents.length ? docEvents[docEvents.length - 1].runId : null;
  const runFrames = docEvents.filter((e) => e.runId === runId);
  const liveSteps = runFrames.filter((e) => e.step).map((e) => e.step!);
  const liveStepsRef = useRef(liveSteps);
  liveStepsRef.current = liveSteps;
  const steps = running ? liveSteps : [];

  // CHAT vs EDIT lock: the canvas lock is engaged optimistically at send, but a conversational
  // reply ("yo") must NOT lock the canvas or show the agent cursor. Detect a chat run from the live
  // stream — the harness's explicit `kind:'chat'` on the run's first frame (contract), or, until
  // that lands, the chat op step's `data.chat` flag — and RELEASE the lock the moment we see it.
  const liveRunIsChat = runFrames.some(
    (e) => e.kind === 'chat' || (e.step?.kind === 'op' && (e.step.data as { chat?: boolean } | undefined)?.chat === true),
  );
  useEffect(() => {
    if (running && liveRunIsChat && lockedRef.current && !chatReleasedRef.current) {
      chatReleasedRef.current = true;
      lockedRef.current = false;
      onRunEnd(); // release the canvas lock — the run keeps streaming its reply into the panel
    }
  }, [running, liveRunIsChat, onRunEnd]);

  // LIVE FIDELITY SCORE: while a self-improvement loop runs, its scoring rounds arrive as `verify`
  // steps carrying { score, round } and its terminal `done` frame carries { verdict, bestScore }.
  // Track the latest into `loop` so the activity feed can show a per-round "round 2 · 78%" badge +
  // the verdict. Only touches state while a loop is active (setLoop set at run start).
  useEffect(() => {
    if (!loop) return;
    let round = loop.round, score = loop.score;
    for (const f of runFrames) {
      const d = f.step?.data as { score?: number; round?: number } | undefined;
      if (f.step?.kind === 'verify' && d && typeof d.score === 'number') { score = d.score; round = d.round ?? round; }
    }
    const doneFrame = runFrames.find((f) => f.done && (f.result as { verdict?: string } | undefined)?.verdict);
    const verdict = doneFrame ? ((doneFrame.result as { verdict?: string }).verdict ?? null) : loop.verdict;
    if (round !== loop.round || score !== loop.score || verdict !== loop.verdict) {
      setLoop({ round, score, verdict });
    }
  }, [runFrames, loop]);

  // DELETE teardown: if THIS comp is deleted (a `doc` SSE frame with deleted:true for our docId),
  // any agent run on it was aborted server-side — tear the panel's run state down so it doesn't
  // sit spinning against a doc that no longer exists. `abandonedRef` guards the in-flight settle so
  // the aborted run's stale resolve can't re-apply to the now-gone doc.
  useEffect(() => {
    if (docTick?.deleted && docTick.id === docId && running) {
      abandonedRef.current = true;
      runSeqRef.current += 1; // supersede the in-flight run so its settle is a no-op
      setRunning(false);
      if (lockedRef.current) { lockedRef.current = false; onRunEnd(); }
      setRevert(null);
      setLoop(null);
    }
  }, [docTick, docId, running, onRunEnd]);

  // Parallel sub-agent workers for THIS run — the dedicated `subagent` store slice. Filter to
  // this doc (frames without a docId pass through, matching the step-feed rule) and to the
  // current run (a worker's parentRunId — or its own runId — must match the run driving the
  // step feed), then reduce to the worker-list shape. The store already collapses each worker's
  // start→update→done onto one row and resets on a new parent run, so this is a thin projection.
  // Falls back to the step-stream shape when the slice is empty (backward-compatible).
  const runSubAgents = subAgentEvents.filter((ev) => {
    if (ev.docId != null && ev.docId !== docId) return false;
    if (runId == null) return true;
    const parent = ev.parentRunId ?? ev.runId;
    return parent == null || parent === runId;
  });
  const workers = runSubAgents.length
    ? reduceSubAgents(runSubAgents)
    : collectSubAgents(steps);

  const visible = [...messages, ...localEcho]
    .filter((m) => m.at > clearedAt)
    .sort((a, b) => a.at - b.at);

  // On a populated thread the history is a long wall (a real session ran 10× the panel height).
  // Collapse everything OLDER than the last few turns behind one expandable band, so the live /
  // most-recent exchange is what you actually see. `expandHistory` opens the full log on demand;
  // it auto-resets whenever the doc changes (switching comps) so a new comp starts collapsed.
  const [expandHistory, setExpandHistory] = useState(false);
  useEffect(() => { setExpandHistory(false); }, [docId]);
  // Keep the last RECENT_MSGS messages always shown (≈ the last 2–3 exchanges); older ones fold
  // into the band. 6 = roughly the latest user+agent pair plus the one before it.
  const RECENT_MSGS = 6;
  const hiddenCount = expandHistory ? 0 : Math.max(0, visible.length - RECENT_MSGS);
  const shownMessages = hiddenCount > 0 ? visible.slice(hiddenCount) : visible;

  // Pin to bottom only when the user is ALREADY near the bottom (or a run is live) — otherwise
  // scrolling UP to read history got yanked back down on every render (the old unconditional pin).
  const nearBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (running || nearBottomRef.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownMessages.length, steps.length, running]);

  // ── attachments ──
  const onFiles = (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      setUploading((n) => n + 1);
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const r = await api.uploadRef(String(reader.result));
          if (r.ok && r.id) {
            setAttachments((a) => [...a, { ref: r.id!, url: r.url || `/refasset?id=${r.id}`, note: '' }]);
          } else flash('Image upload failed');
        } finally { setUploading((n) => n - 1); }
      };
      reader.onerror = () => setUploading((n) => n - 1);
      reader.readAsDataURL(file);
    }
  };

  // ── element references ──
  const addSelectionRefs = () => {
    if (!selection.length) return;
    setRefs((cur) => {
      const have = new Set(cur.map((r) => r.id));
      return [...cur, ...selection.filter((s) => !have.has(s.id))];
    });
    inputRef.current?.focus();
  };

  // Multiline-aware auto-grow: whenever `input` changes for ANY reason — typing, a slash command
  // clearing it, a follow-up chip filling it, send clearing it — resync the textarea's height
  // (typing itself is also handled inline in onChange so it doesn't wait a render behind, but
  // programmatic changes only flow through `input` state, hence this effect).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // ── runs ──
  // Sending while a run is live no longer silently drops the instruction: queue ONE pending
  // instruction (a second send while already queued replaces it — still just one slot), shown as
  // a muted "queued: …" bubble with a cancel ×, and auto-sent the moment the live run settles
  // (see the effect below `stopRun`). Preset modes (Improve pass / Generate from brief) aren't
  // queueable — those buttons are already disabled while running, same as before.
  const run = async (opts: { instruction?: string; mode?: 'improve' | 'generate' }) => {
    const text = (opts.instruction || '').trim();
    if (running) {
      if (text && !opts.mode) {
        setQueued({ text });
        setInput('');
        setAttachments([]);
        setActiveAtt(null);
        setRefs([]);
        flash('Queued — will send when this run finishes');
      }
      return;
    }
    if (!text && !opts.mode) return;
    setLastFailed(null); // a fresh run supersedes any prior failure's retry affordance
    abandonedRef.current = false;
    chatReleasedRef.current = false;
    const seq = ++runSeqRef.current;
    const current = () => seq === runSeqRef.current; // false once a newer run superseded this one
    // Lock the canvas optimistically (edit/copy is the common case). If the live stream reveals a
    // chat run, the effect above releases it. lockedRef tracks whether WE hold the lock right now.
    onRunStart();
    lockedRef.current = true;
    setRunning(true);

    const atts = attachments.map((a) => ({ ref: a.ref, note: a.note.trim() || undefined }));
    const focusIds = refs.map((r) => r.id);
    const optimistic: ChatMessage = {
      role: 'user',
      text: text || (opts.mode === 'improve' ? 'Improve this design' : opts.mode === 'generate' ? 'Generate ad from brief' : ''),
      at: Date.now(),
      attachments: atts.length ? atts : undefined,
    };
    currentRunRef.current = {
      text: text || optimistic.text,
      kind: 'text',
      retry: () => { void run({ instruction: text, mode: opts.mode }); },
    };
    setLocalEcho((l) => [...l, optimistic]);
    setInput('');
    setAttachments([]);
    setActiveAtt(null);
    setRefs([]);

    // Did the server store an agent line for this run? Failures/stops don't reach the server
    // chat, so their local echoes must SURVIVE the post-run refresh (a failed run that leaves
    // no trace in the chat reads as the UI swallowing the result).
    let landed = false;
    try {
      if (!(await ensureSaved())) { flash('Save failed — agent not run'); return; }
      const r = await api.designAgentRun({
        id: docId,
        instruction: text || undefined,
        mode: opts.mode,
        attachments: atts.length ? atts : undefined,
        focusIds: focusIds.length ? focusIds : undefined,
      });
      if (r.ok && r.design) {
        landed = true;
        // A conversational reply (kind 'chat') changed nothing — no apply, no revert affordance.
        const isChat = r.kind === 'chat' || r.source === 'chat';
        if (current()) {
          // Even after "stop" the server run completed and SAVED the doc — apply it (one undo
          // step) so the canvas doesn't silently diverge from the persisted design. (A stale
          // settle — the user stopped AND already started a newer run — skips the apply; the
          // refreshed chat still shows its result line.)
          if (!isChat) onApply(r.design);
          setUndoneAt(0); // fresh applied run → undo becomes available again
          if (!isChat) setRevertUsed(false); // fresh run → its revert affordance is available again
          if (abandonedRef.current) flash(isChat ? 'Stopped' : 'Agent finished after stop — applied (undo to revert)');
          else if (!isChat) {
            const v = r.verify;
            flash(v?.ready ? `Ready · layout ${v.layoutScore}` : `Applied (${r.source}) · ${v?.lintCount ?? 0} lint`);
          }
        }
        const applied = r.applied ?? (Array.isArray(r.steps) ? r.steps.length : undefined);
        // local agent line as a fallback in case the chat route isn't live yet
        setLocalEcho((l) => [...l, {
          role: 'agent',
          text: isChat ? (r.design ? 'Ready when you are.' : '') : 'Applied changes to the design.',
          at: Date.now(),
          result: { applied, source: r.source, kind: r.kind, verifyReady: r.verify?.ready },
        }]);
        // REVERT checkpoint: stash the pre-run doc snapshot the server returned. "Revert this run"
        // restores it (one undo step + a durable save) — the owner's safety net for a bad edit.
        // Only for real edit/copy runs; a chat reply changed nothing so it clears any stale one.
        if (current()) setRevert(isChat ? null : (r.pre ?? null));
      } else {
        if (current()) {
          flash(r.error || 'Agent failed');
          if (currentRunRef.current) setLastFailed(currentRunRef.current);
        }
        setLocalEcho((l) => [...l, { role: 'agent', text: r.error || 'Agent run failed.', at: Date.now() }]);
      }
    } finally {
      if (current()) {
        // keep this run's full step feed for the disclosure on its row
        setLastSteps(liveStepsRef.current.slice());
        if (!abandonedRef.current) {
          setRunning(false);
          // Release the canvas lock only if we still hold it — a chat run already released it
          // mid-stream (chatReleasedRef), so don't fire onRunEnd twice.
          if (lockedRef.current) { lockedRef.current = false; onRunEnd(); }
        } // (abandoned → stopRun already unlocked the editor)
        abandonedRef.current = false;
      }
      // Server history is authoritative for what it HAS: drop the optimistic user echo (the
      // server appended it at run start) and, on a successful run, the agent echoes too (the
      // server line replaces them). Failure/stop lines stay — the server never stored those.
      if (await refreshChat()) {
        setLocalEcho((l) => (landed ? [] : l.filter((m) => m.role !== 'user')));
      }
    }
  };

  // "Match the reference" — the self-improvement loop as an in-editor run. SEED (this comp) →
  // render → score fidelity → fix → repeat until it matches (or converges). It streams over the
  // SAME `design` SSE channel as a normal run (the live step feed + AgentActivity render it
  // automatically), is stoppable via the SAME Stop control, and its "revert this run" checkpoint
  // (the server's `pre` snapshot) covers it. This is an honest multi-minute background-style pass.
  const runSelfImprove = async () => {
    if (running || !reference) return;
    abandonedRef.current = false;
    chatReleasedRef.current = false;
    const seq = ++runSeqRef.current;
    const current = () => seq === runSeqRef.current;
    onRunStart();
    lockedRef.current = true;
    setRunning(true);
    setLoop({ round: 0, score: null, verdict: null });

    const label = `Match the reference${reference.label ? ` — ${reference.label}` : ''}`;
    currentRunRef.current = { text: label, kind: 'preset', retry: () => { void runSelfImprove(); } };
    setLocalEcho((l) => [...l, {
      role: 'user',
      text: label,
      at: Date.now(),
    }]);

    let landed = false;
    try {
      if (!(await ensureSaved())) { flash('Save failed — loop not run'); return; }
      const r = await api.selfImprove({
        docId,
        referenceId: reference.ref,
        referenceKind: reference.kind,
      });
      if (r.ok && r.design) {
        landed = true;
        if (current()) {
          onApply(r.design);
          setUndoneAt(0);
          setRevertUsed(false);
          const pct = r.bestScore ?? 0;
          const verd = (r.verdict || 'exhausted').toUpperCase();
          if (abandonedRef.current) flash(`Stopped — best result applied (${pct}%)`);
          else flash(`${verd} · ${pct}% fidelity over ${r.rounds ?? 0} round${r.rounds === 1 ? '' : 's'}`);
          setRevert(r.pre ?? null);
        }
        setLocalEcho((l) => [...l, {
          role: 'agent',
          text: `Match-the-reference pass ${(r.verdict || 'done').toUpperCase()} at ${r.bestScore ?? 0}% fidelity over ${r.rounds ?? 0} round${r.rounds === 1 ? '' : 's'}.`,
          at: Date.now(),
          result: { source: 'self-improve', verifyReady: r.verdict === 'pass' },
        }]);
      } else {
        if (current()) { flash(r.error || 'Match-the-reference failed'); if (currentRunRef.current) setLastFailed(currentRunRef.current); }
        setLocalEcho((l) => [...l, { role: 'agent', text: r.error || 'Match-the-reference run failed.', at: Date.now() }]);
      }
    } finally {
      if (current()) {
        setLastSteps(liveStepsRef.current.slice());
        if (!abandonedRef.current) {
          setRunning(false);
          if (lockedRef.current) { lockedRef.current = false; onRunEnd(); }
        }
        abandonedRef.current = false;
        setLoop(null);
      }
      if (await refreshChat()) {
        setLocalEcho((l) => (landed ? [] : l.filter((m) => m.role !== 'user')));
      }
    }
  };

  // "Copy this reference" as a first-class LIVE run — the SAME path a chat edit takes, so it streams
  // into the feed (running=true → the live step rail + AgentActivity render it), is stoppable via
  // the SAME Stop control, and gets a "revert this run" checkpoint. The Editor queues it (drop /
  // paste / attach / library pick) as `pendingCopy`; this runs it and reports back so it clears.
  const runCopy = useCallback(async (copy: { ref: string; label?: string; instruction?: string }) => {
    if (running) return;
    abandonedRef.current = false;
    chatReleasedRef.current = false;
    const seq = ++runSeqRef.current;
    const current = () => seq === runSeqRef.current;
    onRunStart();
    lockedRef.current = true;
    setRunning(true);

    currentRunRef.current = {
      text: `Copy this reference${copy.label ? ` — ${copy.label}` : ''}`,
      kind: 'preset',
      retry: () => { void runCopy(copy); },
    };
    setLocalEcho((l) => [...l, {
      role: 'user',
      text: `Copy this reference${copy.label ? ` — ${copy.label}` : ''}`,
      at: Date.now(),
      attachments: [{ ref: copy.ref }],
    }]);

    let landed = false;
    try {
      if (!(await ensureSaved())) { flash('Save failed — copy not run'); return; }
      const r = await api.designAgentRun({
        id: docId,
        instruction: copy.instruction || 'Copy this reference — recreate its layout in this comp.',
        reference: { ref: copy.ref, label: copy.label },
      });
      if (r.ok && r.design) {
        landed = true;
        if (current()) {
          onApply(r.design);
          setUndoneAt(0);
          setRevertUsed(false);
          const v = r.verify;
          if (abandonedRef.current) flash('Stopped — partial copy applied (undo to revert)');
          else flash(v?.ready ? `Reference copied · layout ${v.layoutScore}` : `Reference copied (${r.source})`);
          setRevert(r.pre ?? null);
        }
        setLocalEcho((l) => [...l, {
          role: 'agent',
          text: 'Copied the reference layout into this comp.',
          at: Date.now(),
          result: { applied: r.applied, source: r.source, verifyReady: r.verify?.ready },
        }]);
      } else {
        if (current()) { flash(r.error || 'Copy reference failed'); if (currentRunRef.current) setLastFailed(currentRunRef.current); }
        setLocalEcho((l) => [...l, { role: 'agent', text: r.error || 'Copy reference run failed.', at: Date.now() }]);
      }
    } finally {
      if (current()) {
        setLastSteps(liveStepsRef.current.slice());
        if (!abandonedRef.current) {
          setRunning(false);
          if (lockedRef.current) { lockedRef.current = false; onRunEnd(); }
        }
        abandonedRef.current = false;
      }
      if (await refreshChat()) {
        setLocalEcho((l) => (landed ? [] : l.filter((m) => m.role !== 'user')));
      }
    }
  }, [running, docId, ensureSaved, onApply, onRunStart, onRunEnd, flash, refreshChat]);

  // Consume a queued copy run (one per nonce). Guard on the last-run nonce so a re-render can't
  // double-fire, and only start when idle (a copy that arrives mid-run is dropped — the Editor
  // gates attach while busy anyway). onCopyConsumed lets the Editor clear its queued state.
  const lastCopyNonce = useRef(0);
  useEffect(() => {
    if (!pendingCopy || pendingCopy.nonce === lastCopyNonce.current) return;
    if (running) return;
    lastCopyNonce.current = pendingCopy.nonce;
    onCopyConsumed?.();
    void runCopy({ ref: pendingCopy.ref, label: pendingCopy.label, instruction: pendingCopy.instruction });
  }, [pendingCopy, running, runCopy, onCopyConsumed]);

  // "Stop": ACTUALLY abort the server run (POST /api/design/agent/abort by docId — the run's own
  // id isn't known here until it finishes) AND abandon the client wait. The harness honors the
  // AbortSignal and returns a clean partial; the panel settles to a stopped state immediately (no
  // stuck spinner). Any partial that still lands is applied as one undoable step.
  const stopRun = () => {
    if (!running || abandonedRef.current) return;
    abandonedRef.current = true;
    setRunning(false);
    setLoop(null);
    if (lockedRef.current) { lockedRef.current = false; onRunEnd(); }
    // fire-and-forget: aborting the server controller unblocks runDesignAgent right away
    void api.designAgentAbort({ docId });
    setLocalEcho((l) => [...l, {
      role: 'agent',
      text: 'Stopped. The agent run was aborted — any partial result is applied as one undoable step.',
      at: Date.now(),
    }]);
    flash('Run stopped');
    // Failed-run recovery: no dead end — put the stopped run's instruction back in the composer
    // for editing (only meaningful for a plain text send — self-improve/copy aren't free-text asks)
    // AND surface a "Retry" chip that re-drives the SAME run function verbatim.
    const cur = currentRunRef.current;
    if (cur) {
      setLastFailed(cur);
      if (cur.kind === 'text') setInput((v) => v || cur.text);
    }
  };

  // "Revert this run": restore the pre-run doc the server snapshotted before the agent touched it.
  // This is the owner's one-click safety net for a bad result. onApply(pre) puts the pre-run doc
  // on the canvas as ONE undo step (matching the run's own apply), and we durably persist it too so
  // the server's on-disk doc matches the canvas (onApply marks the doc clean, assuming the server
  // already holds it). After a successful revert the affordance hides for that run.
  const doRevert = useCallback(async () => {
    if (running || !revert || revertUsed) return;
    const snapshot = revert;
    onApply(snapshot);
    setRevertUsed(true);
    try { await api.saveDesign(snapshot); } catch { /* canvas already reverted; disk retry is best-effort */ }
    flash('Reverted to the pre-run state');
  }, [running, revert, revertUsed, onApply, flash]);

  const clearChat = () => {
    const now = Date.now();
    setClearedAt(now);
    setLocalEcho([]);
    try { localStorage.setItem(clearedKey(docId), String(now)); } catch { /* private mode */ }
  };

  // Run queue: the moment the live run settles (running flips false), auto-send the ONE queued
  // instruction, if any. Runs after render so `run` sees the fresh `running=false`.
  useEffect(() => {
    if (running || !queued) return;
    const text = queued.text;
    setQueued(null);
    void run({ instruction: text });
    // run/queued deliberately omitted: `run` is a fresh closure each render and including it would
    // re-fire this effect on every keystroke-driven re-render; we only want the running-edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Run a slash command — reuses the SAME entry points the ＋ menu already calls (no new server
  // contract). /match degrades to a no-op when there's no attached reference (mirrors the ＋
  // menu's own gating), /copy needs an attached reference too (there's nothing to copy otherwise).
  const runSlashCommand = (cmd: string) => {
    setInput('');
    setSlashOpen(false);
    if (cmd === '/match') { if (reference) void runSelfImprove(); return; }
    if (cmd === '/copy') {
      if (reference) void run({ instruction: `Copy this reference — recreate its layout in this comp.` });
      return;
    }
    if (cmd === '/dark') { void run({ instruction: 'Switch this design to real platform dark mode — dark surfaces, correct inverted text/icon contrast, not just a filter.' }); return; }
    if (cmd === '/spacing') { void run({ instruction: 'Fix the spacing — separate overlapping layers and even out the gaps.' }); return; }
    if (cmd === '/improve') { void run({ mode: 'improve' }); return; }
  };

  // "1.0k tok" — total in+out, compacted
  const fmtTokens = (r?: ChatResult) => {
    if (!r || (r.inTok == null && r.outTok == null)) return null;
    const total = (r.inTok ?? 0) + (r.outTok ?? 0);
    return `${total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total)} tok`;
  };

  // one muted TLDR line per run: an outcome ("Edited 5 layers") + a right-aligned faint duration.
  // The model/token detail lives in the expanded detail, not on the summary line — the summary is
  // "what it did", nothing else.
  const resultLine = (m: ChatMessage): { head: string; dur: string } => {
    const r = m.result;
    const dur = fmtDuration(m);
    if (!r) return { head: m.text.split('\n')[0] || 'No changes', dur };
    const head: string[] = [];
    if (r.applied != null) head.push(`Edited ${r.applied} layer${r.applied === 1 ? '' : 's'}`);
    if (r.parts != null && r.parts > 1) head.push(`${r.parts} parts`);
    return { head: head.join(' · ') || m.text.split('\n')[0] || 'Done', dur };
  };
  // The model/token meta for the expanded detail footer ("deepseek · 1.2k tok").
  const resultMeta = (m: ChatMessage): string => {
    const r = m.result;
    if (!r) return '';
    const meta: string[] = [];
    if (r.model || r.source) meta.push(r.model || r.source || '');
    const tok = fmtTokens(r);
    if (tok) meta.push(tok);
    return meta.filter(Boolean).join(' · ');
  };
  // the latest agent message that applied changes — its row gets undo + the step list
  const lastAgentAt = (() => {
    for (let i = visible.length - 1; i >= 0; i--) {
      if (visible[i].role !== 'user' && visible[i].result?.applied != null) return visible[i].at;
    }
    return -1;
  })();
  // the latest agent message of ANY kind (including chat) — "Thought for Ns" attaches here, since
  // a chat reply never sets `result.applied` and so never matches lastAgentAt above.
  const lastAgentMsgAt = (() => {
    for (let i = visible.length - 1; i >= 0; i--) {
      if (visible[i].role !== 'user') return visible[i].at;
    }
    return -1;
  })();
  // Run duration, seconds — derived from this run's captured step timestamps when it's the most
  // recent agent turn (we keep lastSteps for it); otherwise omitted. Faint, tabular, "Ns"/"M:SS".
  const fmtDuration = (m: ChatMessage): string => {
    const steps = m.at === lastAgentMsgAt ? lastSteps : [];
    if (steps.length < 1) return '';
    const first = steps[0].at, last = steps[steps.length - 1].at;
    const secs = Math.max(1, Math.round((last - first) / 1000));
    if (!Number.isFinite(secs)) return '';
    return secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs}s`;
  };

  const canSend = !running && uploading === 0 && (!!input.trim() || attachments.length > 0);

  // What-changed digest for the latest finished run's row — built from `lastSteps` (same source
  // the "Details" disclosure renders), so it's exact for whichever run currently owns that array.
  const lastDigest = buildDigest(lastSteps);
  const digestLine = (): { text: string; title: string } | null => {
    if (!lastDigest.length) return null;
    return {
      text: lastDigest.map((d) => `${d.bucket} ${d.count}`).join(' · '),
      title: lastDigest.map((d) => `${d.bucket}: ${d.names.length ? d.names.join(', ') : d.count}`).join('\n'),
    };
  };

  // A run just failed or was stopped when the most recent visible line is an agent message with NO
  // result at all (both the error branch and stopRun's local echo push a bare {role:'agent',text}).
  // Only offer Retry while lastFailed still names the exact instruction to re-send.
  const lastVisible = visible.length ? visible[visible.length - 1] : null;
  const showRetry = !running && !!lastFailed
    && lastVisible?.role === 'agent' && !lastVisible.result;

  // Slash popover filter: composer text is exactly "/" + a filter word (no space yet) — matches
  // either the command itself ("/imp" → /improve) or its label ("/dark" → "Real platform dark…").
  const slashFilter = /^\/[a-z]*$/i.test(input) ? input.slice(1).toLowerCase() : null;
  const slashList = slashFilter == null ? [] : SLASH_COMMANDS.filter((c) => {
    if (c.needsReference && !reference) return false;
    return c.cmd.slice(1).startsWith(slashFilter) || c.label.toLowerCase().includes(slashFilter);
  });
  useEffect(() => {
    setSlashOpen(slashList.length > 0);
    setSlashIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashFilter]);

  return (
    <div className={styles.panel}>
      {/* ── header: persona · clear (the ONE model label lives in the composer footer) ── */}
      <div className={styles.header}>
        <PersonaIdentity
          name="Agent"
          variant="mana"
          state={running ? 'thinking' : 'idle'}
          size={18}
          className={styles.persona}
        />
        {visible.length ? (
          <button type="button" className={styles.clearBtn} disabled={running}
            title="Hide the current chat history (the design itself is untouched)"
            onClick={clearChat}>
            clear
          </button>
        ) : null}
      </div>

      {/* ── message list ── */}
      <div
        className={styles.messages}
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          // "near bottom" = within ~48px of the end; drives whether new content re-pins (so
          // scrolling up to read history isn't yanked back down every render).
          nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {visible.length === 0 && !running ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>Describe a change and the agent edits the canvas.</p>
            <div className={styles.emptyHints}>
              <span className={styles.emptyHint}><kbd className={styles.emptyKbd}>@</kbd>reference the selected layers</span>
              <span className={styles.emptyHint}><kbd className={styles.emptyKbd}>＋</kbd>attach an image or run a preset pass</span>
              <span className={styles.emptyHint}><kbd className={styles.emptyKbd}>⌘↵</kbd>send</span>
            </div>
          </div>
        ) : null}
        {/* Collapsed-history band: everything older than the last few messages folds behind one
            quiet, expandable row so a long session reads as the LATEST exchange, not a wall. */}
        {hiddenCount > 0 ? (
          <button
            type="button"
            className={styles.historyBand}
            onClick={() => setExpandHistory(true)}
            title="Show the full chat history for this comp"
          >
            <span className={styles.historyChev}><Icon name="chevron-right" size={10} /></span>
            Show earlier history
            <span className={styles.historyCount}>{hiddenCount} message{hiddenCount === 1 ? '' : 's'}</span>
          </button>
        ) : null}
        {expandHistory && visible.length > RECENT_MSGS ? (
          <button
            type="button"
            className={styles.historyBand}
            data-collapse
            onClick={() => { setExpandHistory(false); nearBottomRef.current = true; }}
            title="Collapse older history"
          >
            <span className={styles.historyChev} data-open><Icon name="chevron-right" size={10} /></span>
            Collapse earlier history
          </button>
        ) : null}
        {shownMessages.map((m, i) => {
          // Chat-kind turns (conversational reply, nothing applied) render as plain text with no
          // summary/undo/revert row — there's nothing to undo. Older history rows predate the
          // `result.kind` field, so also treat a resultless agent line with no applied count as chat.
          const isChatMsg = m.role === 'agent' && (m.result?.kind === 'chat' || (!m.result && m.text));
          const thought = m.role === 'agent' ? fmtDuration(m) : '';
          return m.role === 'user' ? (
            <div key={`${m.at}-${i}`} className={styles.msg} data-role="user">
              <div className={styles.userBubble}>
                {m.text ? <span className={styles.userText}>{m.text}</span> : null}
                {m.attachments?.length ? (
                  <span className={styles.msgAtts}>
                    {m.attachments.map((a, j) => {
                      const url = `/refasset?id=${encodeURIComponent(a.ref)}`;
                      const label = a.note || 'Attached image';
                      return (
                        <button
                          key={`${a.ref}-${j}`} type="button" className={styles.msgAttBtn}
                          title={label}
                          onClick={() => setLightbox({ url, label, name: a.ref })}
                        >
                          <img src={url} alt={label} className={styles.msgAtt} />
                        </button>
                      );
                    })}
                  </span>
                ) : null}
              </div>
            </div>
          ) : (
            <div key={`${m.at}-${i}`} className={styles.msg} data-role="agent">
              {/* "Thought for Ns" — a muted line above the reply showing how long this turn took
                  (mirrors the live status line's role while the run was in flight). Only known for
                  the most recently finished run (we keep its step timestamps in `lastSteps`). */}
              {thought ? <p className={styles.thoughtFor}>Thought for {thought}</p> : null}
              {isChatMsg ? (
                // Plain conversational reply — generous line height, no card/border, full text.
                m.text ? <p className={styles.answer}>{m.text}</p> : null
              ) : (
                <>
                  {/* TLDR-FIRST finished turn: the final answer as a body-text sentence, then one
                      muted summary line ("Edited N layers" + faint duration). The raw step rail +
                      plan + model meta live behind a default-collapsed "Details" disclosure.
                      On a POPULATED thread most historical edit turns stored raw op-log text as
                      their body ("move L85 → 438,852 · smartAd: caption: fs floor 24→30") — a wall
                      of noise. Show the body sentence only when it reads as prose (or is the latest
                      turn); otherwise the clean "Edited N layers" summary row below carries it. */}
                  {(() => {
                    const first = (m.text || '').split('\n')[0].trim();
                    // Op-log / harness bookkeeping is never a human sentence — the clean summary row
                    // below ("Edited N layers") carries it. Only show a body when it reads as prose.
                    const showBody = !!first && !OP_LOG_RE.test(first);
                    return showBody ? <p className={styles.answer}>{first}</p> : null;
                  })()}
                  <div className={styles.summaryRow}>
                    <span className={styles.summaryText}>{resultLine(m).head}</span>
                    {m.at === lastAgentAt && m.at > undoneAt ? (
                      <button
                        type="button" className={styles.undoBtn} disabled={running}
                        title="Undo this run (it applied as one undo step)"
                        onClick={() => { onUndoRun(); setUndoneAt(m.at); flash('Run undone'); }}
                      >
                        undo
                      </button>
                    ) : null}
                    {/* Revert this run: the owner's one-click safety net — restore the exact pre-run
                        doc snapshot if the agent produced a mess. Sits on the latest applied run. */}
                    {m.at === lastAgentAt && revert && !revertUsed ? (
                      <button
                        type="button" className={styles.revertBtn} disabled={running}
                        title="Revert this run — restore the design to exactly how it was before this run"
                        onClick={() => { void doRevert(); }}
                      >
                        <Icon name="undo" size={10} /> revert this run
                      </button>
                    ) : null}
                  </div>
                  {/* What-changed digest: "Moved 2 · Restyled 3 · Added 1" — hover for layer names.
                      Only known for the most recently finished run (lastSteps ownership). */}
                  {m.at === lastAgentAt && m.at === lastAgentMsgAt && digestLine() ? (
                    <p className={styles.digestLine} title={digestLine()!.title}>{digestLine()!.text}</p>
                  ) : null}
                </>
              )}
              {!isChatMsg && m.at === lastAgentAt && lastSteps.length ? (
                <button
                  type="button" className={styles.detailToggle}
                  data-open={openAt === m.at || undefined}
                  onClick={() => setOpenAt((cur) => (cur === m.at ? null : m.at))}
                >
                  <span className={styles.chev}><Icon name="chevron-right" size={9} /></span>
                  {openAt === m.at ? 'Hide details' : 'Details'}
                  {resultMeta(m) ? <span className={styles.detailMeta}>{resultMeta(m)}</span> : null}
                </button>
              ) : null}
              {openAt === m.at ? (
                <div className={styles.agentDetail}>
                  {m.at === lastAgentAt && lastSteps.length ? (
                    <>
                      {/* the full step list — the single source of truth for what happened; each
                          step's description carries its kind and target layer. */}
                      <ChainOfThought defaultOpen className={styles.cot}>
                        <ChainOfThoughtHeader>{`${lastSteps.length} step${lastSteps.length === 1 ? '' : 's'}`}</ChainOfThoughtHeader>
                        <ChainOfThoughtContent>
                          {lastSteps.map((st) => {
                            const target = (st.data as { name?: string; id?: string } | undefined)?.name
                              || (st.data as { id?: string } | undefined)?.id;
                            return (
                              <ChainOfThoughtStep
                                key={`${st.at}-${st.i}`}
                                icon={stepIcon(st.kind || st.tool)}
                                label={st.summary}
                                description={[st.kind || st.tool, target].filter(Boolean).join(' · ')}
                                status="complete"
                              />
                            );
                          })}
                        </ChainOfThoughtContent>
                      </ChainOfThought>
                    </>
                  ) : (
                    m.text ? <pre className={styles.agentText}>{m.text}</pre> : null
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
        {/* ── suggested follow-ups: 2-4 tappable chips under the reply of a finished edit/copy run,
            contextually derived client-side from the run's kind/digest (no LLM call). Only after
            the LAST agent turn, and only once the run has actually settled. ── */}
        {!running && lastVisible?.role === 'agent' && lastVisible.result && lastVisible.result.kind !== 'chat' ? (() => {
          const chips = followUpsFor(lastVisible, lastDigest, !!reference);
          return chips.length ? (
            <div className={styles.followUps}>
              {chips.map((label) => (
                <button
                  key={label}
                  type="button"
                  className={styles.followUpChip}
                  onClick={() => {
                    if (label === 'Undo that') { onUndoRun(); setUndoneAt(lastVisible.at); flash('Run undone'); return; }
                    void run({ instruction: label });
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null;
        })() : null}
        {/* ── failed-run recovery: a run that errored or was stopped gets a "Retry" chip that
            re-sends the exact instruction verbatim — no dead-end failures. ── */}
        {showRetry ? (
          <div className={styles.followUps}>
            <button
              type="button"
              className={styles.retryChip}
              onClick={() => { const f = lastFailed!; setLastFailed(null); f.retry(); }}
            >
              <Icon name="refresh" size={10} /> Retry
            </button>
          </div>
        ) : null}
        {/* ── queued instruction: sent while a run was live — shown as a muted bubble with a
            cancel × until the current run settles and it auto-sends. ── */}
        {queued ? (
          <div className={styles.msg} data-role="user">
            <div className={styles.queuedBubble}>
              <span className={styles.queuedLabel}>queued</span>
              <span className={styles.queuedText}>{queued.text}</span>
              <button type="button" className={styles.queuedCancel} title="Cancel queued instruction" onClick={() => setQueued(null)}>
                <Icon name="x" size={9} />
              </button>
            </div>
          </div>
        ) : null}
        {running ? (
          // Live run — the ONE shared AgentActivity feed (same component the copy-from-reference
          // build renders): TLDR narrative (diamond + shimmering header + one current action) +
          // tool "look" chips + a parallel sub-agent list when the stream carries workers + the
          // full step rail behind a default-COLLAPSED disclosure. A self-improvement loop surfaces
          // its per-round FIDELITY SCORE + verdict through the header + summary lines.
          <AgentActivity
            steps={steps}
            title={loop
              ? `Matching the reference${loop.round ? ` · round ${loop.round}` : ''}${loop.score != null ? ` · ${Math.round(loop.score)}%` : ''}`
              : 'Working…'}
            thinkingLabel={loop ? 'Improving fidelity…' : undefined}
            subagents={workers}
            summaries={loop ? [
              loop.score != null
                ? `Fidelity round ${loop.round || 1} · ${Math.round(loop.score)}%${loop.verdict ? ` — ${loop.verdict}` : ''}`
                : 'Deep pass — render, score, fix. Each round can take minutes.',
              'Stoppable anytime; the best result so far is kept.',
            ] : undefined}
          />
        ) : null}
      </div>

      {/* ── composer ── */}
      <div className={styles.composer}>
        {/* Selection→reference is OPT-IN via the @ button below — no automatic hint/attach
            (clicking around the canvas must never leak into the chat). */}

        {refs.length ? (
          <div className={styles.refRow}>
            {refs.map((r) => (
              <span key={r.id} className={styles.refChip} title={r.id}>
                @{r.name}
                <button type="button" className={styles.refRemove} title="Remove reference"
                  onClick={() => setRefs((list) => list.filter((x) => x.id !== r.id))}>
                  <Icon name="x" size={8} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {attachments.length || uploading ? (
          <>
            <div className={styles.attRow}>
              {attachments.map((a, i) => (
                <div
                  key={a.ref} className={styles.attSquare}
                  data-active={activeAtt === i || undefined}
                >
                  <button
                    type="button" className={styles.attMain}
                    title={a.note || 'Click to add a usage note'}
                    onClick={() => setActiveAtt((cur) => (cur === i ? null : i))}
                  >
                    <img src={a.url} alt={a.note || 'Attached image'} />
                  </button>
                  <button
                    type="button" className={styles.attExpand} title="View full size"
                    onClick={(e) => {
                      e.stopPropagation();
                      setLightbox({ url: a.url, label: a.note || 'Attached image', name: a.ref });
                    }}
                  >
                    <Icon name="expand" size={8} />
                  </button>
                  <button
                    type="button" className={styles.attRemove} title="Remove attachment"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAttachments((list) => list.filter((_, j) => j !== i));
                      setActiveAtt(null);
                    }}
                  >
                    <Icon name="x" size={8} />
                  </button>
                </div>
              ))}
              {uploading ? <span className={styles.uploading}><span className={styles.spinner} /> uploading</span> : null}
            </div>
            {activeAtt != null && attachments[activeAtt] ? (
              <input
                className={styles.attNote}
                placeholder="use as background…"
                value={attachments[activeAtt].note}
                autoFocus
                spellCheck={false}
                onChange={(e) => setAttachments((list) => list.map((x, j) => (j === activeAtt ? { ...x, note: e.target.value } : x)))}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') setActiveAtt(null); }}
              />
            ) : null}
          </>
        ) : null}

        <div className={styles.inputWrap}>
          {slashOpen && slashList.length ? (
            <div className={styles.slashMenu} role="listbox">
              {slashList.map((c, i) => (
                <button
                  key={c.cmd}
                  type="button"
                  role="option"
                  aria-selected={i === slashIndex}
                  className={styles.slashItem}
                  data-active={i === slashIndex || undefined}
                  onMouseEnter={() => setSlashIndex(i)}
                  onClick={() => runSlashCommand(c.cmd)}
                >
                  <span className={styles.slashIcon}><Icon name={c.icon} size={12} /></span>
                  <span className={styles.slashCmd}>{c.cmd}</span>
                  <span className={styles.slashLabel}>{c.label}</span>
                  <span className={styles.slashHint}>{c.hint}</span>
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            ref={inputRef}
            className={styles.inputBox}
            placeholder={visible.length ? 'Add follow up… ("/" for commands)' : 'Describe a change…'}
            value={input}
            rows={1}
            spellCheck={false}
            onChange={(e) => {
              setInput(e.target.value);
              const el = e.target;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (slashOpen && slashList.length) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashList.length); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashList.length) % slashList.length); return; }
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); runSlashCommand(slashList[slashIndex].cmd); return; }
                if (e.key === 'Escape') { e.preventDefault(); setSlashOpen(false); return; }
              }
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run({ instruction: input }); return; }
              if (e.key === '@' && selection.length && !e.metaKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault();
                addSelectionRefs();
              }
            }}
          />
        </div>
        <div className={styles.composerRow}>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className={styles.plusBtn} disabled={running} title="Attach · Improve · Draft copy" aria-label="More actions">
                <Icon name="plus" size={13} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className={styles.menu} align="start" side="top" sideOffset={6}>
                <DropdownMenu.Item className={styles.menuItem} title="Attach a reference image (png/jpg) to your next message" onSelect={() => fileInput.current?.click()}>
                  <span className={styles.menuIcon}><Icon name="photo" size={13} /></span>
                  Attach image
                  <span className={styles.menuHint}>png · jpg</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className={styles.menuItem} disabled={running} title="Generate a full ad from the brief and brand style" onSelect={() => void run({ mode: 'generate', instruction: input.trim() || 'Generate a production-ready ad from the brief and brand style.' })}>
                  <Icon name="sparkles" size={14} />
                  Generate from brief
                </DropdownMenu.Item>
                <DropdownMenu.Item className={styles.menuItem} disabled={running} title="Run a quick lint pass — spacing, contrast, alignment fixes" onSelect={() => void run({ mode: 'improve' })}>
                  <span className={styles.menuIcon}><Icon name="sparkles" size={13} /></span>
                  Improve pass
                  <span className={styles.menuHint}>lint</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className={styles.menuItem} disabled={running} title="Rewrite the text layers with stronger ad copy based on the brief and reference" onSelect={() => void run({ instruction: DRAFT_COPY_PROMPT })}>
                  <span className={styles.menuIcon}><Icon name="pencil" size={13} /></span>
                  Draft copy
                  <span className={styles.menuHint}>brief</span>
                </DropdownMenu.Item>
                {/* Self-improvement loop — only when a reference is attached (degrades to hidden). A
                    slow, multi-minute deep pass: render → score → fix → repeat until it matches. */}
                {reference ? (
                  <>
                    <DropdownMenu.Separator className={styles.menuSep} />
                    <DropdownMenu.Item
                      className={styles.menuItem} disabled={running}
                      title="Repeatedly render, score fidelity against the reference, and fix until it matches — a multi-minute deep pass on the local model. Stoppable anytime."
                      onSelect={() => void runSelfImprove()}
                    >
                      <span className={styles.menuIcon}><Icon name="check" size={13} /></span>
                      Match the reference
                      <span className={styles.menuHint}>deep · slow</span>
                    </DropdownMenu.Item>
                  </>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <button
            type="button" className={styles.atBtn}
            disabled={running || !selection.length}
            title={selection.length ? 'Reference the selected layers' : 'Select layers on the canvas first'}
            onClick={addSelectionRefs}
          >
            @
          </button>
          <input
            ref={fileInput} type="file" accept="image/*" multiple hidden
            onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }}
          />
          {running ? (
            <button
              type="button" className={styles.stopBtn}
              title="Stop the agent run (aborts it on the server and unlocks the editor)"
              onClick={stopRun}
            >
              <span className={styles.stopSquare} aria-hidden />
              stop
            </button>
          ) : (
            <button
              type="button" className={styles.sendBtn}
              disabled={!canSend}
              title="Run the agent (⌘↵)"
              aria-label="Send (⌘↵)"
              onClick={() => void run({ instruction: input })}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M8 13V4M4.5 7.5L8 4l3.5 3.5" stroke="currentColor" strokeWidth="1.6"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>

        {/* ── model footer: a quiet, non-interactive indicator of the active model. There is no
            model switching in the UI — the model is a hard default chosen server-side. ── */}
        <div className={styles.modelFooter}>
          <span className={styles.modelFooterLabel}>model</span>
          <span className={styles.model} title={modelLabel}>{modelLabel}</span>
        </div>
      </div>
      <RefLightbox target={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}
