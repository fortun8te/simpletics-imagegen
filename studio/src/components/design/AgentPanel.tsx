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
import { useStore, type AgentEvent } from '../../store';
import { api } from '../../api';
import { Icon } from '../Icon';
import DiamondLoader from './DiamondLoader';
import TextShimmer from './TextShimmer';
import { PersonaIdentity } from '../ai/Persona';
import {
  ChainOfThought, ChainOfThoughtHeader, ChainOfThoughtContent, ChainOfThoughtStep,
  type ChainStepStatus,
} from '../ai/ChainOfThought';
import { Reasoning, ReasoningTrigger, ReasoningContent } from '../ai/Reasoning';
import { ModelSelector, type ModelOption } from '../ai/ModelSelector';
import type { DesignDoc } from '../../lib/sceneGraph';
import styles from './AgentPanel.module.css';

// map an agent step's tool/kind → an Icon name for the ChainOfThought marker
const stepIcon = (kind?: string): string => {
  const k = (kind || '').toLowerCase();
  if (k.includes('observe') || k.includes('read') || k.includes('inspect')) return 'eye';
  if (k.includes('search') || k.includes('find')) return 'search';
  if (k.includes('plan') || k.includes('think')) return 'sparkles';
  if (k.includes('text') || k.includes('copy') || k.includes('write')) return 'pen';
  if (k.includes('image') || k.includes('photo')) return 'photo';
  if (k.includes('verify') || k.includes('lint') || k.includes('check')) return 'check';
  return 'dot';
};

export interface ChatResult {
  applied?: number; source?: string; model?: string;
  inTok?: number; outTok?: number; turns?: number; parts?: number;
  verifyReady?: boolean;
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
}

const DRAFT_COPY_PROMPT =
  'Rewrite the text layers with stronger ad copy based on the brief and reference';

const clearedKey = (docId: string) => `neuegen.design.chatCleared.${docId}`;

// ── model switching ──
interface LlmPreset { label: string; baseUrl: string; model: string }
interface LlmConfig { baseUrl?: string; model?: string; label?: string }
// Fallback presets when GET /api/llm/config omits its own list.
const DEFAULT_PRESETS: LlmPreset[] = [
  { label: 'DeepSeek v4-flash', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
  { label: 'DeepSeek v4-pro', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' },
  { label: 'LM Studio (localhost:1234)', baseUrl: 'http://localhost:1234/v1', model: '' },
];

export default function AgentPanel({
  docId, ensureSaved, onApply, onRunStart, onRunEnd, onUndoRun, flash, selection, brand = '',
}: AgentPanelProps) {
  const designEvents = useStore((s) => s.ui.designEvents);

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
  const [openAt, setOpenAt] = useState<number | null>(null); // which agent row is disclosed
  const [modelLabel, setModelLabel] = useState('codex');
  // model switcher — null until GET /api/llm/config succeeds (404 → read-only label fallback)
  const [llmCfg, setLlmCfg] = useState<LlmConfig | null>(null);
  const [llmPresets, setLlmPresets] = useState<LlmPreset[]>(DEFAULT_PRESETS);
  const [customOpen, setCustomOpen] = useState(false);
  const [customBase, setCustomBase] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [clearedAt, setClearedAt] = useState<number>(() => {
    try { return Number(localStorage.getItem(clearedKey(docId))) || 0; } catch { return 0; }
  });

  const fileInput = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // "Stop" = abandon the wait client-side (there is no server abort for /api/design/agent):
  // unlock the UI now; if the run still finishes, its result is applied as one undo step.
  // runSeqRef guards the settled promise — after a stop the user can start a NEW run while
  // the old one is still in flight, and the stale settle must not touch the new run's state.
  const abandonedRef = useRef(false);
  const runSeqRef = useRef(0);

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

  // model line — once on mount ("deepseek · deepseek-chat" style, fallback codex). The
  // configurable switcher only activates when GET /api/llm/config exists on this server.
  useEffect(() => {
    let alive = true;
    api.getLlmUsage().then((r) => {
      if (!alive) return;
      const p = r.ok ? r.provider : null;
      if (p?.model) setModelLabel(p.provider ? `${p.provider} · ${p.model}` : p.model);
      else setModelLabel('codex');
    });
    api.getLlmConfig().then((r) => {
      if (!alive || !r.ok) return; // route missing → read-only chip
      setLlmCfg(r.config || {});
      if (Array.isArray(r.presets) && r.presets.length) setLlmPresets(r.presets);
    });
    return () => { alive = false; };
  }, []);

  const applyLlmConfig = async (cfg: { baseUrl: string; model: string; apiKey?: string }, label: string) => {
    const r = await api.setLlmConfig(cfg);
    if (r.ok) {
      setLlmCfg(r.config || { ...cfg, label });
      setModelLabel(r.config?.label || r.config?.model || label);
      setCustomOpen(false);
      flash(`Model → ${r.config?.label || label}`);
    } else flash(r.error || 'Model switch failed');
  };
  const currentModelLabel = llmCfg?.label || llmCfg?.model || modelLabel;
  const presetActive = (p: LlmPreset) =>
    !!llmCfg && (llmCfg.baseUrl || '') === p.baseUrl && (!p.model || (llmCfg.model || '') === p.model);
  // ModelSelector option list, grouped by provider (host) — id encodes baseUrl+model.
  const modelOptions: ModelOption[] = llmPresets.map((p) => {
    let provider = '';
    try { provider = new URL(p.baseUrl).hostname.replace(/^www\.|:.*$/g, ''); } catch { provider = 'custom'; }
    return { id: `${p.baseUrl}::${p.model}`, name: p.label, provider, hint: p.model || undefined };
  });
  const activeModelId = llmPresets.find(presetActive)
    ? `${llmPresets.find(presetActive)!.baseUrl}::${llmPresets.find(presetActive)!.model}`
    : undefined;

  // live step feed while running — scoped to THIS doc so a run on another variant can't bleed
  // in or wipe this one's history (frames without docId — the pre-doc extract flow — pass
  // through unfiltered so that rail isn't broken).
  const docEvents = designEvents.filter((e) => e.docId == null || e.docId === docId);
  const runId = docEvents.length ? docEvents[docEvents.length - 1].runId : null;
  const liveSteps = docEvents.filter((e) => e.step && e.runId === runId).map((e) => e.step!);
  const liveStepsRef = useRef(liveSteps);
  liveStepsRef.current = liveSteps;
  const steps = running ? liveSteps : [];

  const visible = [...messages, ...localEcho]
    .filter((m) => m.at > clearedAt)
    .sort((a, b) => a.at - b.at);

  // pin to bottom on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, steps.length, running]);

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

  // ── runs ──
  const run = async (opts: { instruction?: string; mode?: 'improve' | 'generate' }) => {
    if (running) return;
    const text = (opts.instruction || '').trim();
    if (!text && !opts.mode) return;
    abandonedRef.current = false;
    const seq = ++runSeqRef.current;
    const current = () => seq === runSeqRef.current; // false once a newer run superseded this one
    onRunStart();
    setRunning(true);

    const atts = attachments.map((a) => ({ ref: a.ref, note: a.note.trim() || undefined }));
    const focusIds = refs.map((r) => r.id);
    const optimistic: ChatMessage = {
      role: 'user',
      text: text || (opts.mode === 'improve' ? 'Improve this design' : opts.mode === 'generate' ? 'Generate ad from brief' : ''),
      at: Date.now(),
      attachments: atts.length ? atts : undefined,
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
        if (current()) {
          // Even after "stop" the server run completed and SAVED the doc — apply it (one undo
          // step) so the canvas doesn't silently diverge from the persisted design. (A stale
          // settle — the user stopped AND already started a newer run — skips the apply; the
          // refreshed chat still shows its result line.)
          onApply(r.design);
          setUndoneAt(0); // fresh applied run → undo becomes available again
          if (abandonedRef.current) flash('Agent finished after stop — applied (undo to revert)');
          else {
            const v = r.verify;
            flash(v?.ready ? `Ready · layout ${v.layoutScore}` : `Applied (${r.source}) · ${v?.lintCount ?? 0} lint`);
          }
        }
        const applied = r.applied ?? (Array.isArray(r.steps) ? r.steps.length : undefined);
        // local agent line as a fallback in case the chat route isn't live yet
        setLocalEcho((l) => [...l, {
          role: 'agent',
          text: 'Applied changes to the design.',
          at: Date.now(),
          result: { applied, source: r.source, verifyReady: r.verify?.ready },
        }]);
      } else {
        if (current()) flash(r.error || 'Agent failed');
        setLocalEcho((l) => [...l, { role: 'agent', text: r.error || 'Agent run failed.', at: Date.now() }]);
      }
    } finally {
      if (current()) {
        // keep this run's full step feed for the disclosure on its row
        setLastSteps(liveStepsRef.current.slice());
        if (!abandonedRef.current) {
          setRunning(false);
          onRunEnd();
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

  // "Stop": abandon the wait NOW (no server-side abort exists for /api/design/agent) — unlock
  // the editor and say so in the chat; if the run still lands, it applies as one undoable step.
  const stopRun = () => {
    if (!running || abandonedRef.current) return;
    abandonedRef.current = true;
    setRunning(false);
    onRunEnd();
    setLocalEcho((l) => [...l, {
      role: 'agent',
      text: 'Stopped waiting. The run may still finish on the server — if it does, its result is applied as one undoable step.',
      at: Date.now(),
    }]);
    flash('Stopped waiting — editor unlocked');
  };

  const clearChat = () => {
    const now = Date.now();
    setClearedAt(now);
    setLocalEcho([]);
    try { localStorage.setItem(clearedKey(docId), String(now)); } catch { /* private mode */ }
  };

  // "1.0k tok" — total in+out, compacted
  const fmtTokens = (r?: ChatResult) => {
    if (!r || (r.inTok == null && r.outTok == null)) return null;
    const total = (r.inTok ?? 0) + (r.outTok ?? 0);
    return `${total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total)} tok`;
  };

  // one muted line per run, split into an outcome ("applied 5 ops") and quiet trailing
  // meta ("deepseek · 1.0k tok") so the part that matters reads first.
  const resultLine = (m: ChatMessage): { head: string; meta: string } => {
    const r = m.result;
    if (!r) return { head: m.text.split('\n')[0] || 'no changes', meta: '' };
    const head: string[] = [];
    if (r.applied != null) head.push(`applied ${r.applied} op${r.applied === 1 ? '' : 's'}`);
    if (r.parts != null && r.parts > 1) head.push(`${r.parts} parts`);
    const meta: string[] = [];
    if (r.model || r.source) meta.push(r.model || r.source || '');
    const tok = fmtTokens(r);
    if (tok) meta.push(tok);
    return {
      head: head.join(' · ') || m.text.split('\n')[0] || 'done',
      meta: meta.filter(Boolean).join(' · '),
    };
  };

  // the latest agent message that applied changes — its row gets undo + the step list
  const lastAgentAt = (() => {
    for (let i = visible.length - 1; i >= 0; i--) {
      if (visible[i].role !== 'user' && visible[i].result?.applied != null) return visible[i].at;
    }
    return -1;
  })();

  const canSend = !running && uploading === 0 && (!!input.trim() || attachments.length > 0);

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
      <div className={styles.messages} ref={scrollRef}>
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
        {visible.map((m, i) => (
          m.role === 'user' ? (
            <div key={`${m.at}-${i}`} className={styles.msg} data-role="user">
              <span className={styles.userMark}>›</span>
              <div className={styles.userBody}>
                {m.text ? <span className={styles.userText}>{m.text}</span> : null}
                {m.attachments?.length ? (
                  <span className={styles.msgAtts}>
                    {m.attachments.map((a, j) => (
                      <img key={`${a.ref}-${j}`} src={`/refasset?id=${encodeURIComponent(a.ref)}`}
                        alt="" title={a.note || a.ref} className={styles.msgAtt} />
                    ))}
                  </span>
                ) : null}
              </div>
            </div>
          ) : (
            <div key={`${m.at}-${i}`} className={styles.msg} data-role="agent">
              <div className={styles.agentRow}>
                <button
                  type="button" className={styles.agentLine}
                  data-open={openAt === m.at || undefined}
                  title={[resultLine(m).head, resultLine(m).meta].filter(Boolean).join(' · ')}
                  onClick={() => setOpenAt((cur) => (cur === m.at ? null : m.at))}
                >
                  <span className={styles.chev}><Icon name="chevron-right" size={9} /></span>
                  <span className={styles.agentSummary}>{resultLine(m).head}</span>
                  {resultLine(m).meta ? <span className={styles.agentMeta}>{resultLine(m).meta}</span> : null}
                </button>
                {m.at === lastAgentAt && m.at > undoneAt ? (
                  <button
                    type="button" className={styles.undoBtn} disabled={running}
                    title="Undo this run (it applied as one undo step)"
                    onClick={() => { onUndoRun(); setUndoneAt(m.at); flash('Run undone'); }}
                  >
                    undo
                  </button>
                ) : null}
              </div>
              {openAt === m.at ? (
                <div className={styles.agentDetail}>
                  {m.at === lastAgentAt && lastSteps.length ? (
                    <>
                      {/* finished run: ONE settled step rail (open — the user already asked for
                          detail by expanding the row) + the plan text if the agent narrated one.
                          The step list is the single source of truth for what happened; each
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
                      {m.text ? (
                        <Reasoning defaultOpen={false} className={styles.reasoning}>
                          <ReasoningTrigger>Plan</ReasoningTrigger>
                          <ReasoningContent>{m.text}</ReasoningContent>
                        </Reasoning>
                      ) : null}
                    </>
                  ) : (
                    m.text ? <pre className={styles.agentText}>{m.text}</pre> : null
                  )}
                </div>
              ) : null}
            </div>
          )
        ))}
        {running ? (
          // Live run: a scanning diamond + the current step shimmering, then ONE ChainOfThought
          // rail of the steps so far (fed from the store's live designEvents). The rail is the
          // single progress view — no parallel "reasoning" transcript repeating the same steps.
          <div className={styles.runningCard}>
            <div className={styles.runningHead}>
              <DiamondLoader size={26} />
              <div className={styles.runningLine}>
                <TextShimmer className={styles.runningText}>
                  {steps.length ? steps[steps.length - 1].summary : 'thinking…'}
                </TextShimmer>
                {steps.length > 1 ? (
                  <span className={styles.runningMeta}>step {steps.length}</span>
                ) : null}
              </div>
            </div>
            {steps.length > 1 ? (
              <ChainOfThought defaultOpen className={styles.cot}>
                <ChainOfThoughtHeader>Steps</ChainOfThoughtHeader>
                <ChainOfThoughtContent>
                  {steps.map((st, i) => {
                    const status: ChainStepStatus = i === steps.length - 1 ? 'active' : 'complete';
                    return (
                      <ChainOfThoughtStep
                        key={`${st.at}-${st.i}`}
                        icon={stepIcon(st.kind || st.tool)}
                        label={st.summary}
                        description={status === 'active' ? (st.kind || st.tool) : undefined}
                        status={status}
                      />
                    );
                  })}
                </ChainOfThoughtContent>
              </ChainOfThought>
            ) : null}
          </div>
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
                <button
                  key={a.ref} type="button" className={styles.attSquare}
                  data-active={activeAtt === i || undefined}
                  title={a.note || 'Click to add a usage note'}
                  onClick={() => setActiveAtt((cur) => (cur === i ? null : i))}
                >
                  <img src={a.url} alt="" />
                  <span
                    className={styles.attRemove} role="button" tabIndex={-1} title="Remove attachment"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAttachments((list) => list.filter((_, j) => j !== i));
                      setActiveAtt(null);
                    }}
                  >
                    <Icon name="x" size={8} />
                  </span>
                </button>
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

        <textarea
          ref={inputRef}
          className={styles.inputBox}
          placeholder="Describe a change…"
          value={input}
          rows={2}
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run({ instruction: input }); return; }
            if (e.key === '@' && selection.length && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              addSelectionRefs();
            }
          }}
        />
        <div className={styles.composerRow}>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className={styles.plusBtn} disabled={running} title="Attach · Improve · Draft copy" aria-label="More actions">
                <Icon name="plus" size={13} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className={styles.menu} align="start" side="top" sideOffset={6}>
                <DropdownMenu.Item className={styles.menuItem} onSelect={() => fileInput.current?.click()}>
                  <span className={styles.menuIcon}><Icon name="photo" size={13} /></span>
                  Attach image
                  <span className={styles.menuHint}>png · jpg</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className={styles.menuItem} disabled={running} onSelect={() => void run({ mode: 'generate', instruction: input.trim() || 'Generate a production-ready ad from the brief and brand style.' })}>
                  <Icon name="sparkles" size={14} />
                  Generate from brief
                </DropdownMenu.Item>
                <DropdownMenu.Item className={styles.menuItem} disabled={running} onSelect={() => void run({ mode: 'improve' })}>
                  <span className={styles.menuIcon}><Icon name="sparkles" size={13} /></span>
                  Improve pass
                  <span className={styles.menuHint}>lint</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className={styles.menuItem} disabled={running} onSelect={() => void run({ instruction: DRAFT_COPY_PROMPT })}>
                  <span className={styles.menuIcon}><Icon name="pencil" size={13} /></span>
                  Draft copy
                  <span className={styles.menuHint}>brief</span>
                </DropdownMenu.Item>
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
              title="Stop waiting and unlock the editor (the run may still finish on the server)"
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
              onClick={() => void run({ instruction: input })}
            >
              send
              <kbd className={styles.sendKbd}>⌘↵</kbd>
            </button>
          )}
        </div>

        {/* ── custom model form (Custom… in the model menu) — lives next to its trigger ── */}
        {customOpen ? (
          <div className={styles.customForm}>
            <input
              className={styles.customInput} placeholder="Base URL (OpenAI-compatible)" spellCheck={false}
              value={customBase} onChange={(e) => setCustomBase(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <input
              className={styles.customInput} placeholder="Model id" spellCheck={false}
              value={customModel} onChange={(e) => setCustomModel(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <input
              className={styles.customInput} placeholder="API key (optional)" type="password" spellCheck={false}
              value={customKey} onChange={(e) => setCustomKey(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <div className={styles.customRow}>
              <button type="button" className={styles.clearBtn} onClick={() => setCustomOpen(false)}>cancel</button>
              <button
                type="button" className={styles.customSave}
                disabled={!customBase.trim() || !customModel.trim()}
                onClick={() => void applyLlmConfig(
                  { baseUrl: customBase.trim(), model: customModel.trim(), ...(customKey.trim() ? { apiKey: customKey.trim() } : {}) },
                  customModel.trim(),
                )}
              >
                save
              </button>
            </div>
          </div>
        ) : null}

        {/* ── model footer: the ported ModelSelector (searchable, provider-grouped) ── */}
        <div className={styles.modelFooter}>
          <span className={styles.modelFooterLabel}>model</span>
          {llmCfg ? (
            <ModelSelector
              models={modelOptions}
              value={activeModelId}
              triggerLabel={currentModelLabel}
              disabled={running}
              align="start"
              side="top"
              onValueChange={(m) => {
                const p = llmPresets.find((pr) => `${pr.baseUrl}::${pr.model}` === m.id);
                if (p) void applyLlmConfig({ baseUrl: p.baseUrl, model: p.model }, p.label);
              }}
              footer={
                <DropdownMenu.Item
                  className={styles.menuItem}
                  onSelect={() => {
                    setCustomBase(llmCfg.baseUrl || '');
                    setCustomModel(llmCfg.model || '');
                    setCustomKey('');
                    setCustomOpen(true);
                  }}
                >
                  <span className={styles.menuIcon}><Icon name="sliders" size={12} /></span>
                  Custom…
                </DropdownMenu.Item>
              }
            />
          ) : (
            <span className={styles.model} title="Which model runs the agent">{modelLabel}</span>
          )}
        </div>
      </div>
    </div>
  );
}
