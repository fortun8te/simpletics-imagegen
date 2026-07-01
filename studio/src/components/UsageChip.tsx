// Codex usage ring — shows the REAL 5h + weekly remaining % from codex's own rate-limit snapshot
// (codexUsage.codex, the same data codex `/usage` reports). A quiet glyph inline in the account row;
// hover for the full breakdown and the snapshot's freshness.
//
// Staleness handling: this snapshot only updates when the codex CLI completes a turn locally — it
// does NOT capture usage from the Codex desktop app or other machines/sessions, so the gap can be
// large. Past STALE_MS we still show the last known number but strip color and motion — flat gray,
// no gradient, no animation — so it reads as "last known" rather than "live now."
import { useId, useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useStore } from '../store';
import { api } from '../api';
import s from './UsageChip.module.css';

function fmt(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
function ago(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const SIZE = 22;
const CENTER = SIZE / 2;
const OUTER_R = 9;
const INNER_R = 5.8;
const LOW_THRESHOLD = 15;
const STALE_MS = 3 * 60 * 60 * 1000;

function arcGeom(r: number, usedFrac: number) {
  const c = 2 * Math.PI * r;
  const dash = usedFrac * c;
  const endAngle = (-90 + usedFrac * 360) * (Math.PI / 180);
  const startAngle = (-90) * (Math.PI / 180);
  return {
    c,
    dash,
    startX: CENTER + Math.cos(startAngle) * r,
    startY: CENTER + Math.sin(startAngle) * r,
    endX: CENTER + Math.cos(endAngle) * r,
    endY: CENTER + Math.sin(endAngle) * r,
  };
}

type ArcGradProps = {
  id: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  inner?: boolean;
};

function ArcGrad({ id, startX, startY, endX, endY, inner }: ArcGradProps) {
  return (
    <linearGradient
      id={id}
      gradientUnits="userSpaceOnUse"
      x1={startX}
      y1={startY}
      x2={endX}
      y2={endY}
    >
      <stop offset="0%" stopColor={inner ? 'var(--accent-2)' : 'var(--accent-2)'} stopOpacity={inner ? 0.45 : 0.55} />
      <stop offset="60%" stopColor="var(--accent)" />
      <stop offset="100%" stopColor="rgba(255,255,255,.88)" />
    </linearGradient>
  );
}

export default function UsageChip() {
  const uid = useId().replace(/:/g, '');
  const usage = useStore((st) => st.codexUsage);
  const setUsage = useStore((st) => st.setUsage);
  const setBlockers = useStore((st) => st.setBlockers);
  const [pendingChecks, setPendingChecks] = useState(0);
  const codex = usage?.codex;

  if (!codex || codex.fivehLeft == null) return null;

  const stale = Date.now() - codex.asOf > STALE_MS;
  const fivehLeft = Math.max(0, Math.min(100, codex.fivehLeft));
  const weeklyLeft =
    codex.weeklyLeft != null ? Math.max(0, Math.min(100, codex.weeklyLeft)) : null;
  const fivehUsed = (100 - fivehLeft) / 100;
  const weeklyUsed = weeklyLeft != null ? (100 - weeklyLeft) / 100 : 0;
  const low = !stale && fivehLeft <= LOW_THRESHOLD;
  const weeklyLow = !stale && weeklyLeft != null && weeklyLeft <= LOW_THRESHOLD;
  const checking = pendingChecks > 0;

  const outer = arcGeom(OUTER_R, fivehUsed);
  const inner = weeklyLeft != null ? arcGeom(INNER_R, weeklyUsed) : null;

  const outerGradId = `usage5h-${uid}`;
  const innerGradId = `usageWk-${uid}`;

  const checkNow = () => {
    setPendingChecks((n) => n + 1);
    api.refreshUsage()
      .then((r) => {
        const nextAsOf = r.codexUsage?.codex?.asOf ?? 0;
        const currentAsOf = useStore.getState().codexUsage?.codex?.asOf ?? 0;
        if (r.codexUsage && nextAsOf >= currentAsOf) setUsage(r.codexUsage);
        if (r.blockers) setBlockers(r.blockers);
      })
      .finally(() => setPendingChecks((n) => Math.max(0, n - 1)));
  };

  const ariaBits = [
    `5h: ${fivehLeft}% remaining`,
    weeklyLeft != null ? `weekly: ${weeklyLeft}% remaining` : null,
    stale ? `last known snapshot, ${ago(codex.asOf)}` : null,
    'click to check for a newer reading',
  ].filter(Boolean).join('. ');

  const outerStroke = stale || low ? undefined : `url(#${outerGradId})`;
  const innerStroke =
    weeklyLeft == null || stale || weeklyLow ? undefined : `url(#${innerGradId})`;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className={s.chip}
          onClick={checkNow}
          disabled={checking}
          aria-busy={checking}
          aria-label={checking ? 'Checking Codex usage…' : `Codex usage. ${ariaBits}`}
        >
          <svg
            className={`${s.ring} ${checking ? s.ringBusy : ''}`}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            aria-hidden
          >
            {!stale && (
              <defs>
                {outer.dash > 0.01 && !low && (
                  <ArcGrad
                    id={outerGradId}
                    startX={outer.startX}
                    startY={outer.startY}
                    endX={outer.endX}
                    endY={outer.endY}
                  />
                )}
                {inner && inner.dash > 0.01 && !weeklyLow && (
                  <ArcGrad
                    id={innerGradId}
                    startX={inner.startX}
                    startY={inner.startY}
                    endX={inner.endX}
                    endY={inner.endY}
                    inner
                  />
                )}
              </defs>
            )}

            <circle className={s.track} cx={CENTER} cy={CENTER} r={OUTER_R} />
            {outer.dash > 0.01 && (
              <circle
                className={`${s.fill} ${stale ? s.fillStale : low ? s.fillLow : s.fillLive}`}
                cx={CENTER}
                cy={CENTER}
                r={OUTER_R}
                stroke={outerStroke}
                strokeDasharray={`${outer.dash} ${outer.c - outer.dash}`}
                transform={`rotate(-90 ${CENTER} ${CENTER})`}
              />
            )}
            {!stale && !low && outer.dash > 0.01 && (
              <circle className={s.edge} cx={outer.endX} cy={outer.endY} r="1.15" />
            )}

            {inner && (
              <>
                <circle className={`${s.track} ${s.trackInner}`} cx={CENTER} cy={CENTER} r={INNER_R} />
                {inner.dash > 0.01 && (
                  <circle
                    className={`${s.fill} ${s.fillInner} ${stale ? s.fillStale : weeklyLow ? s.fillLow : s.fillLiveInner}`}
                    cx={CENTER}
                    cy={CENTER}
                    r={INNER_R}
                    stroke={innerStroke}
                    strokeDasharray={`${inner.dash} ${inner.c - inner.dash}`}
                    transform={`rotate(-90 ${CENTER} ${CENTER})`}
                  />
                )}
                {!stale && !weeklyLow && inner.dash > 0.01 && (
                  <circle className={`${s.edge} ${s.edgeInner}`} cx={inner.endX} cy={inner.endY} r="0.85" />
                )}
              </>
            )}

            {checking && (
              <circle
                className={s.checkArc}
                cx={CENTER}
                cy={CENTER}
                r={OUTER_R}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="1.65"
                strokeLinecap="round"
                strokeDasharray={`${outer.c * 0.28} ${outer.c * 0.72}`}
              />
            )}
          </svg>
          <span className={`${s.pcts} ${checking ? s.pctsChecking : ''}`}>
            <span className={`${s.pct} ${stale ? s.pctStale : ''}`}>{fivehLeft}%</span>
            {weeklyLeft != null && (
              <span className={`${s.pctWeekly} ${stale ? s.pctStale : ''}`}>
                W{weeklyLeft}%
              </span>
            )}
          </span>
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={s.tip} side="top" align="start" sideOffset={8}>
          <div className={s.tipRow}>
            <span className={s.tipLabel}>5h window</span>
            <span className={s.tipVal}>{fivehLeft}% left · resets {fmt(codex.fivehResetsAt)}</span>
          </div>
          {weeklyLeft != null && (
            <div className={s.tipRow}>
              <span className={s.tipLabel}>Weekly</span>
              <span className={s.tipVal}>{weeklyLeft}% left · resets {fmt(codex.weeklyResetsAt)}</span>
            </div>
          )}
          <div className={s.tipFoot}>
            From codex CLI activity · {stale ? 'last known' : 'updated'} {ago(codex.asOf)}
          </div>
          {stale && (
            <div className={s.tipFoot}>
              No newer local reading — this can lag behind the Codex app. For live numbers, run
              <code style={{ marginLeft: 4 }}>codex</code> and check <code>/usage</code>.
            </div>
          )}
          <Tooltip.Arrow className={s.tipArrow} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
