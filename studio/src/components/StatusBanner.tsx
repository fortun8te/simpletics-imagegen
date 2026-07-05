// StatusBanner — a single quiet strip mounted app-wide (AppShell) that surfaces the current
// generation blocker, if any. CONTAINER. Reads `blockers` + `state.run` from the store.
//
// Priority (only one shown at a time, most-actionable first):
//   auth    → "Codex sign-in expired…" + Retry all
//   ready   → "Quota should be back…" + Check & continue / Not now (never auto-resumes)
//   cooling → "Rate-limited · can continue in m:ss" (countdown only — no skip)
//   budget  → "Budget reached…" + Adjust
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { refreshState } from '../refresh';
import { Icon } from './Icon';
import s from './StatusBanner.module.css';

function fmtCountdown(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(t / 60);
  const ss = String(t % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function limitMessage(reason?: string, resetAt?: number | null): string {
  if (reason === 'still_cooling' && resetAt) {
    return `Still rate-limited — try again in ${fmtCountdown(resetAt - Date.now())}.`;
  }
  if (reason === 'still_limited') return 'Codex quota still looks full — wait a bit longer.';
  if (reason === 'probe_failed') return 'Could not reach Codex — try again in a moment.';
  return 'Not ready to continue yet.';
}

export default function StatusBanner() {
  const blockers = useStore((st) => st.blockers);
  const usage = useStore((st) => st.codexUsage);
  const run = useStore((st) => st.state?.run);
  const setUI = useStore((st) => st.setUI);
  const setUsage = useStore((st) => st.setUsage);
  const setBlockers = useStore((st) => st.setBlockers);

  const runState = run?.state;
  const cooling = blockers?.cooling ?? null;
  const resetAt = run?.resumeAt ?? cooling?.resetAt ?? null;
  const ticking = runState === 'cooling' || runState === 'ready' || !!cooling;

  const [now, setNow] = useState(() => Date.now());
  const [checking, setChecking] = useState(false);
  const [limitMsg, setLimitMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  // ── ERR-25: proactive local-LLM health ──────────────────────────────
  // Poll the existing /api/llm/config endpoint (already used by the model switcher) every ~30s.
  // If the request errors, or the response resolves with no model configured, the local model
  // (ornith via LM Studio) is unreachable — agent features (design agent, self-improve, extract)
  // would just silently fail, so surface a quiet banner proactively instead of waiting for the
  // user to hit a dead end. No server change: this is a read-only poll of a route that exists.
  const [llmDown, setLlmDown] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = () => {
      api.getLlmConfig().then((r) => {
        if (!alive) return;
        const model = r.config?.model;
        setLlmDown(!r.ok || !model);
      });
    };
    check();
    const id = window.setInterval(check, 30_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  if (!blockers) {
    if (llmDown) {
      return (
        <div className={`${s.banner} ${s.budget}`} role="status">
          <Icon name="alert" size={15} className={s.icon} />
          <span className={s.text}>Local model unreachable — agent features unavailable.</span>
        </div>
      );
    }
    return null;
  }

  const applyResumeResult = (r: Awaited<ReturnType<typeof api.resume>>) => {
    if (r.codexUsage) setUsage(r.codexUsage);
    if (r.blockers) setBlockers(r.blockers);
    if (r.resumed) {
      setLimitMsg(null);
      refreshState();
    } else if (r.stillLimited) {
      setLimitMsg(limitMessage(r.reason, r.resetAt));
    }
  };

  const checkAndContinue = () => {
    setChecking(true);
    setLimitMsg(null);
    api.resume({ verify: true })
      .then(applyResumeResult)
      .finally(() => setChecking(false));
  };

  const notNow = () => {
    setLimitMsg(null);
    api.dismissResume().then(() => refreshState());
  };

  // ── auth ────────────────────────────────────────────────────────────
  if (blockers.auth) {
    return (
      <div className={`${s.banner} ${s.auth}`} role="alert">
        <Icon name="alert" size={15} className={s.icon} />
        <span className={s.text}>
          Codex sign-in expired — run <code className={s.code}>codex login</code> in Terminal, then Retry all.
        </span>
        <button
          type="button"
          className={s.action}
          onClick={() => api.retryFailed().then(refreshState)}
        >
          <Icon name="refresh" size={14} />
          <span>Retry all</span>
        </button>
      </div>
    );
  }

  // ── ready to continue (user must opt in) ────────────────────────────
  if (runState === 'ready') {
    return (
      <div className={`${s.banner} ${s.ready}`} role="status">
        <Icon name="sparkles" size={15} className={s.icon} />
        <span className={s.text}>
          Codex quota should be back — check when you&apos;re ready to continue.
          {limitMsg ? <span className={s.sub}>{limitMsg}</span> : null}
        </span>
        <div className={s.actions}>
          <button
            type="button"
            className={s.action}
            onClick={checkAndContinue}
            disabled={checking}
          >
            <Icon name="chevron-right" size={14} />
            <span>{checking ? 'Checking…' : 'Check & continue'}</span>
          </button>
          <button
            type="button"
            className={s.actionGhost}
            onClick={notNow}
            disabled={checking}
          >
            Not now
          </button>
        </div>
      </div>
    );
  }

  // ── cooling countdown (no auto-resume, no skip) ─────────────────────
  if (runState === 'cooling' || cooling) {
    return (
      <div className={`${s.banner} ${s.cooling}`} role="status">
        <Icon name="clock" size={15} className={s.icon} />
        <span className={s.text}>
          Rate-limited · can continue in {resetAt ? fmtCountdown(resetAt - now) : '—'}
          <span className={s.sub}>Won&apos;t resume until you say so.</span>
        </span>
      </div>
    );
  }

  // ── daily cap (1.5× daily share of weekly quota) ─────────────────────
  if (blockers.dailyCap) {
    const d = blockers.dailyCap;
    const bonus = d.bonusPts > 0 ? ` (incl. +${d.bonusPts} continued)` : '';
    return (
      <div className={`${s.banner} ${s.budget}`} role="status">
        <Icon name="activity" size={15} className={s.icon} />
        <span className={s.text}>
          Daily cap reached — {d.spentToday}% of your weekly Codex quota used today
          (cap {d.allowedPts}%{bonus} · 1.5× the daily share).
          <span className={s.sub}>Queued work holds until you continue or tomorrow.</span>
        </span>
        <button
          type="button"
          className={s.action}
          onClick={() =>
            api.dailyCapContinue().then((r) => {
              if (r.blockers) setBlockers(r.blockers);
              refreshState();
            })
          }
        >
          <Icon name="chevron-right" size={14} />
          <span>Continue (+10%)</span>
        </button>
      </div>
    );
  }

  // ── budget ──────────────────────────────────────────────────────────
  if (blockers.budget) {
    const used = usage?.used5h;
    const cap = usage?.cap5h;
    const detail = used != null && cap != null ? ` (${used}/${cap} in 5h)` : '';
    return (
      <div className={`${s.banner} ${s.budget}`} role="status">
        <Icon name="activity" size={15} className={s.icon} />
        <span className={s.text}>Budget reached{detail} · frees up soon.</span>
        <button
          type="button"
          className={s.action}
          onClick={() => setUI({ settingsOpen: true, settingsSection: 'system' })}
        >
          <Icon name="settings" size={14} />
          <span>Adjust</span>
        </button>
      </div>
    );
  }

  // ── local model unreachable (lowest priority — only shown when nothing else is) ─────────
  if (llmDown) {
    return (
      <div className={`${s.banner} ${s.budget}`} role="status">
        <Icon name="alert" size={15} className={s.icon} />
        <span className={s.text}>Local model unreachable — agent features unavailable.</span>
      </div>
    );
  }

  return null;
}
