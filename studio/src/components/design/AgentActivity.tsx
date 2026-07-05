// AgentActivity — the ONE shared "the agent is working" feed, rendered identically by BOTH the
// design-edit agent (AgentPanel) and the copy-from-reference build (now an in-editor agent run).
// Before this, each surface grew its own loading UI; now they are structurally + visually the
// same thing.
//
// It renders, top to bottom:
//   1. TLDR narrative — the existing look the owner likes: DiamondLoader + a shimmering
//      "Thinking…" header, then the ONE current first-person action shimmering, then the
//      "look" tool actions as compact chips. (Reuses DiamondLoader + TextShimmer as-is.)
//   2. Sub-agent list — the reference screenshot look: a vertical list of up to 3 parallel
//      workers (a muted "+N more" line surfaces any beyond that), each row = an animated loading
//      glyph (DiamondLoader) + a bold title + a faint shimmering substatus line, expandable to
//      show the full untruncated title/phase. Appears ONLY when subagents are passed and
//      non-empty; degrades to nothing otherwise (nothing breaks if the backend `subagent` event
//      isn't wired up in this session).
//   3. Summary lines — muted recap lines ("Explored 7 searches, ran 2 commands") + an optional
//      "Waiting Ns" timer, matching the reference's calm footer.
//   4. The full step rail behind a default-collapsed disclosure (unchanged behaviour).
//
// Everything animated (diamond, shimmer) is kept alive through the idle / tab-hidden power-saver
// via the same `data-app-idle` / `data-tab-hidden` overrides the other run overlays use; the
// enter-fade is transition + @starting-style (never an opacity keyframe) for the same reason.
import { useEffect, useRef, useState } from 'react';
import DiamondLoader from './DiamondLoader';
import TextShimmer from './TextShimmer';
import { Icon } from '../Icon';
import type { AgentEvent } from '../../store';
import {
  ChainOfThought, ChainOfThoughtHeader, ChainOfThoughtContent, ChainOfThoughtStep,
  type ChainStepStatus,
} from '../ai/ChainOfThought';
import styles from './AgentActivity.module.css';

export type Step = NonNullable<AgentEvent['step']>;

// A parallel sub-agent worker (mirrors the backend `subagent` event shape the other agent is
// adding: {id, title, model, status, phase, parentRunId}). All fields but id/title are optional
// so a partially-populated frame still renders cleanly.
export interface SubAgent {
  id: string;
  title: string;
  model?: string;
  status?: 'running' | 'done' | 'error' | (string & {});
  phase?: string; // the faint substatus line ("Analyzing Notes assets")
}

// A spawning worker: the backend registers the row before it has picked a title/substatus for
// itself (phase 'start' with nothing to show yet). Rather than flash an empty row, show the
// reference's own lifecycle label — "New subagent" / "Starting up" — until its real title lands.
const SPAWNING_TITLE = 'New subagent';
const SPAWNING_PHASE = 'Starting up';

// map an agent step's tool/kind → an Icon name for the tool chips / rail markers
export const stepIcon = (kind?: string): string => {
  const k = (kind || '').toLowerCase();
  if (k.includes('observe') || k.includes('read') || k.includes('inspect')) return 'eye';
  if (k.includes('search') || k.includes('find')) return 'search';
  if (k.includes('plan') || k.includes('think')) return 'sparkles';
  if (k.includes('text') || k.includes('copy') || k.includes('write')) return 'pen';
  if (k.includes('image') || k.includes('photo')) return 'photo';
  if (k.includes('verify') || k.includes('lint') || k.includes('check')) return 'check';
  return 'dot';
};

const isLookStep = (s: Step): boolean => {
  const k = (s.kind || s.tool || '').toLowerCase();
  return /observe|read|inspect|view|search|find|scan/.test(k);
};

// The single first-person "what I'm doing right now" sentence: the latest non-look step's summary
// (narration reads best; ops read as an action too). Falls back to `title` then "Thinking…".
const currentAction = (steps: Step[], title?: string): string => {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (isLookStep(steps[i])) continue;
    const t = (steps[i].summary || '').trim();
    if (t) return t;
  }
  if (steps.length) return (steps[steps.length - 1].summary || '').trim() || (title || 'Working…');
  return title || 'Thinking…';
};

const lookChips = (steps: Step[]): Step[] => steps.filter(isLookStep);

const clockFmt = (secs: number): string => {
  const s = Math.max(0, Math.round(secs));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
};

interface AgentActivityProps {
  /** Live steps for THIS run (already filtered to the current runId by the caller). */
  steps: Step[];
  /** Header label + the fallback for the current-action line before the first step arrives. */
  title?: string;
  /** The muted "Thinking…" eyebrow beside the diamond. */
  thinkingLabel?: string;
  /** Up to 3 parallel sub-agents (reference look). Empty / undefined → the section is omitted. */
  subagents?: SubAgent[];
  /** Muted recap lines under the list ("Explored 7 searches, ran 2 commands"). */
  summaries?: string[];
  /** Seconds elapsed — renders a right-aligned "Waiting Ns" timer when >= 0. */
  waiting?: number | null;
  className?: string;
}

export default function AgentActivity({
  steps,
  title,
  thinkingLabel = 'Thinking…',
  subagents = [],
  summaries = [],
  waiting = null,
  className,
}: AgentActivityProps) {
  // UI-4/6: still render at most 3 rows (the reference look), but never silently drop the rest —
  // a muted "+N more" line under the list surfaces the true count instead of hiding it.
  const workers = subagents.slice(0, 3);
  const hiddenWorkerCount = Math.max(0, subagents.length - workers.length);
  // UI-7: which worker row is expanded (disclosure) to show its full untruncated title + phase.
  const [openWorker, setOpenWorker] = useState<string | null>(null);
  const chips = lookChips(steps);

  // ONE current status line: a real in-progress action if we have one, else the contextual
  // eyebrow ("Reading the reference" / "Improving fidelity…" / "Thinking…"). This replaces the old
  // stacked "Thinking…" eyebrow + separate "Working…" line that showed two generic states at once.
  const line = currentAction(steps, thinkingLabel || title || 'Thinking…');

  // Live elapsed timer for the current run — self-contained: anchored to the first step's timestamp
  // (else mount time) and ticked once a second while mounted (AgentActivity only mounts while a run
  // is active), so the user can see how long the agent has been on the current task.
  const startedAt = useRef<number>(steps[0]?.at ?? Date.now());
  const [nowTs, setNowTs] = useState<number>(() => steps[0]?.at ?? Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const elapsed = Math.max(0, (nowTs - startedAt.current) / 1000);

  return (
    <div className={className ? `${styles.activity} ${className}` : styles.activity}>
      {/* ── 1. ONE status header: diamond + current action/status (shimmer) + live elapsed timer ──
          UI-10: aria-live/aria-busy scoped to just this line, not the whole feed — otherwise
          every tick (chips, workers, step rail all re-rendering) re-announces the ENTIRE feed
          to screen readers instead of just the thing that's actually changing. */}
      <div className={styles.head}>
        <DiamondLoader size={16} />
        <TextShimmer className={styles.currentLine} key={line} aria-live="polite" aria-busy="true">{line}</TextShimmer>
        <span className={styles.elapsed} title="Time on this task">{clockFmt(elapsed)}</span>
      </div>

      {chips.length ? (
        <div className={styles.chipRow}>
          {chips.map((st) => (
            <span key={`${st.at}-${st.i}`} className={styles.toolChip}>
              <Icon name={stepIcon(st.kind || st.tool)} size={11} />
              <span className={styles.toolChipLabel}>{st.summary}</span>
            </span>
          ))}
        </div>
      ) : null}

      {/* ── 2. Sub-agent list — the reference look (only when workers are actually running).
          UI-4/6: capped at 3 rows but a muted "+N more" line surfaces the true count instead of
          silently dropping the rest. UI-7: each row is a disclosure — click to expand the full
          untruncated title + phase (title/phase attrs give a hover tooltip either way). ── */}
      {workers.length ? (
        <ul className={styles.workers}>
          {workers.map((w) => {
            const done = w.status === 'done' || w.status === 'error';
            const open = openWorker === w.id;
            // Spawning: no title yet (or an explicit start phase with nothing to show) — render the
            // lifecycle placeholder instead of a blank row until the worker's real title arrives.
            const spawning = !done && !w.title?.trim();
            const title = spawning ? SPAWNING_TITLE : w.title;
            const phase = spawning ? SPAWNING_PHASE : w.phase;
            return (
              <li key={w.id} className={styles.worker} data-status={w.status || 'running'}>
                <span className={styles.workerGlyph} aria-hidden>
                  {done ? (
                    <Icon name={w.status === 'error' ? 'x' : 'check'} size={12} />
                  ) : (
                    <DiamondLoader size={16} />
                  )}
                </span>
                <button
                  type="button"
                  className={styles.workerBody}
                  data-open={open || undefined}
                  aria-expanded={open}
                  onClick={() => setOpenWorker((cur) => (cur === w.id ? null : w.id))}
                >
                  <div className={styles.workerTitleRow}>
                    <span className={styles.workerTitle} title={title} data-open={open || undefined}>
                      {title}
                    </span>
                    {/* quiet inline model label after the title (reference look) — omitted while
                        spawning since there's nothing meaningful to attribute it to yet. */}
                    {!spawning && w.model ? (
                      <span className={styles.workerModel}>{w.model}</span>
                    ) : null}
                  </div>
                  {phase ? (
                    done ? (
                      <span className={styles.workerSubStatic} title={phase} data-open={open || undefined}>
                        {phase}
                      </span>
                    ) : (
                      <TextShimmer className={styles.workerSub} title={phase} data-open={open || undefined}>
                        {phase}
                      </TextShimmer>
                    )
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {hiddenWorkerCount > 0 ? (
        <span className={styles.workersMore}>+{hiddenWorkerCount} more</span>
      ) : null}

      {/* ── 3. Summary recap lines + optional "Waiting Ns" timer ── */}
      {summaries.length || waiting != null ? (
        <div className={styles.summaryLines}>
          {summaries.map((line, i) => (
            <span key={i} className={styles.summaryLine}>{line}</span>
          ))}
          {waiting != null ? (
            <span className={styles.waiting}>Waiting {clockFmt(waiting)}</span>
          ) : null}
        </div>
      ) : null}

      {/* ── 4. Full step rail behind a default-collapsed disclosure (unchanged) ── */}
      {steps.length > 1 ? (
        <ChainOfThought className={styles.cot}>
          <ChainOfThoughtHeader>{`Steps · ${steps.length}`}</ChainOfThoughtHeader>
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
  );
}
