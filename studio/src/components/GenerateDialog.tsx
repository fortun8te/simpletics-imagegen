// GenerateDialog (container) — batch/ads-level entry point for generation.
// Reads ui.genOpen + state/brand/batch from the store; calls api.generate.
// Per-prompt/variation generation is triggered from cards/rows, not here.
//
// Time estimate: on open, fetches the server's rolling average single-image duration
// (api.getHealth().estimate — lib/jobstore.mjs avgDurationSeconds(), a real measurement from the
// last ~20 completed jobs, falling back to a 30s default when there's no history yet). Shown next to
// the variants stepper as "~Xs per image" + a total batch ETA (targetedSlots × variants × avgSeconds),
// recomputed live as the user changes scope/variants — no extra fetch needed for that part, just math.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from './Icon';
import { useStore } from '../store';
import { api } from '../api';
import type { AdNode, GenerateScope } from '../types';
import s from './GenerateDialog.module.css';

type Scope = 'batch' | 'ads';

// Count the slots a set of ads represents (used for the estimate).
function slotsOf(ads: AdNode[]): number {
  let n = 0;
  for (const ad of ads) for (const v of ad.variations) for (const p of v.prompts) n += p.slots.length;
  return n;
}

// Format a duration in seconds as "~4m 30s" / "~45s" / "~1h 5m" — compact, no leading zeros.
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

export default function GenerateDialog() {
  const genOpen = useStore((st) => st.ui.genOpen);
  const state = useStore((st) => st.state);
  const brand = useStore((st) => st.brand);
  const batch = useStore((st) => st.batch);
  const setUI = useStore((st) => st.setUI);
  const usage = useStore((st) => st.codexUsage);

  const ads = state?.ads ?? [];

  const [scope, setScope] = useState<Scope>('batch');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [variants, setVariants] = useState(2);
  const [defer, setDefer] = useState<'now' | '30m' | '1h' | 'later'>('now');
  const [laterAt, setLaterAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Synchronous re-entrancy guard: `submitting` state isn't visible to a second click that fires
  // in the same tick as the first (before React commits the re-render that disables the button).
  // A ref mutates immediately, so back-to-back/rapid clicks past the first are turned away for real.
  const submittingRef = useRef(false);
  // Rolling-average per-image duration (seconds), fetched fresh each time the dialog opens. Defaults
  // to 30s (the server's own fallback — see lib/jobstore.mjs avgDurationSeconds()) so the estimate
  // text always has a number to show, never a blank, even before the fetch resolves.
  const [avgSeconds, setAvgSeconds] = useState(30);

  // Reset to defaults each time the dialog opens, and fetch the latest generation-time estimate.
  useEffect(() => {
    if (genOpen) {
      setScope('batch');
      setSelected(new Set());
      setVariants(2);
      setDefer('now');
      setLaterAt('');
      setSubmitting(false);
      submittingRef.current = false;
      let cancelled = false;
      api.getHealth().then((h) => {
        if (!cancelled && h.estimate) setAvgSeconds(h.estimate.seconds);
      });
      return () => { cancelled = true; };
    }
  }, [genOpen]);

  const close = () => setUI({ genOpen: false });

  const toggleAd = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Targeted slots: whole batch = all slots; selected ads = slots of chosen ads.
  const targetedSlots = useMemo(() => {
    if (scope === 'batch') return slotsOf(ads);
    return slotsOf(ads.filter((a) => selected.has(a.id)));
  }, [scope, ads, selected]);

  const estimate = targetedSlots * variants;
  // Total ETA = targeted slots × variants × the rolling average seconds-per-image (live — recomputes
  // as the user changes the variants stepper or scope, no extra fetch needed).
  const etaSeconds = estimate * avgSeconds;

  const runAt = useMemo(() => {
    const now = Date.now();
    if (defer === '30m') return now + 30 * 60 * 1000;
    if (defer === '1h') return now + 60 * 60 * 1000;
    if (defer === 'later' && laterAt) {
      const t = new Date(laterAt).getTime();
      if (t > now + 60_000) return t;
    }
    return undefined;
  }, [defer, laterAt]);

  const clampVariants = (n: number) => Math.max(1, Math.min(6, Math.round(n) || 1));

  const canSubmit =
    !submitting &&
    !!brand &&
    !!batch &&
    (scope === 'batch' || selected.size > 0);

  const submit = async () => {
    if (!canSubmit || !brand || !batch || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const payload: GenerateScope =
      scope === 'ads' ? { ads: Array.from(selected) } : {};
    await api.generate(brand, batch, payload, variants, runAt);
    close();
  };

  return (
    <Dialog.Root open={genOpen} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.content} aria-describedby={undefined}>
          <div className={s.head}>
            <div>
              <Dialog.Title className={s.title}>Generate images</Dialog.Title>
              <p className={s.subtitle}>Queue a run for this batch.</p>
            </div>
            <Dialog.Close className={s.close} aria-label="Close">
              <Icon name="x" size={16} />
            </Dialog.Close>
          </div>

          <div className={s.body}>
            {/* Scope */}
            <div className={s.field}>
              <p className={s.label} id="gen-scope-label">Scope</p>
              <div className={s.radios} role="radiogroup" aria-labelledby="gen-scope-label">
                <label className={`${s.radio} ${scope === 'batch' ? s.radioOn : ''}`}>
                  <input
                    type="radio"
                    name="gen-scope"
                    value="batch"
                    checked={scope === 'batch'}
                    onChange={() => setScope('batch')}
                  />
                  <span className={s.radioLabel}>Whole batch</span>
                </label>
                <label className={`${s.radio} ${scope === 'ads' ? s.radioOn : ''}`}>
                  <input
                    type="radio"
                    name="gen-scope"
                    value="ads"
                    checked={scope === 'ads'}
                    onChange={() => setScope('ads')}
                  />
                  <span className={s.radioLabel}>Selected ads</span>
                </label>
              </div>

              {scope === 'ads' ? (
                <div className={s.adList}>
                  {ads.length === 0 ? (
                    <p className={s.empty}>No ads in this batch yet.</p>
                  ) : (
                    ads.map((ad) => (
                      <label key={ad.id} className={s.adRow}>
                        <input
                          type="checkbox"
                          checked={selected.has(ad.id)}
                          onChange={() => toggleAd(ad.id)}
                        />
                        <span className={s.adName}>{ad.title || ad.id}</span>
                        {ad.type ? <span className={s.adType}>{ad.type}</span> : null}
                      </label>
                    ))
                  )}
                </div>
              ) : null}
            </div>

            {/* Variants */}
            <div className={s.field}>
              <label className={s.label} htmlFor="gen-variants">Variants per slot</label>
              <div className={s.variants}>
                <button
                  type="button"
                  className={s.step}
                  onClick={() => setVariants((v) => clampVariants(v - 1))}
                  disabled={variants <= 1}
                  aria-label="Fewer variants"
                >
                  <span aria-hidden>−</span>
                </button>
                <input
                  id="gen-variants"
                  className={s.number}
                  type="number"
                  min={1}
                  max={6}
                  value={variants}
                  onChange={(e) => setVariants(clampVariants(Number(e.target.value) || 1))}
                />
                <button
                  type="button"
                  className={s.step}
                  onClick={() => setVariants((v) => clampVariants(v + 1))}
                  disabled={variants >= 6}
                  aria-label="More variants"
                >
                  <Icon name="plus" size={15} />
                </button>
              </div>
            </div>

            {/* Start time */}
            <div className={s.field}>
              <p className={s.label} id="gen-defer-label">Start</p>
              <div className={s.radios} role="radiogroup" aria-labelledby="gen-defer-label">
                {(['now', '30m', '1h', 'later'] as const).map((d) => (
                  <label key={d} className={`${s.radio} ${defer === d ? s.radioOn : ''}`}>
                    <input
                      type="radio"
                      name="gen-defer"
                      value={d}
                      checked={defer === d}
                      onChange={() => setDefer(d)}
                    />
                    <span className={s.radioLabel}>
                      {d === 'now' ? 'Now' : d === '30m' ? 'In 30 min' : d === '1h' ? 'In 1 hour' : 'Later…'}
                    </span>
                  </label>
                ))}
              </div>
              {defer === 'later' ? (
                <input
                  type="datetime-local"
                  className={s.datetime}
                  value={laterAt}
                  onChange={(e) => setLaterAt(e.target.value)}
                />
              ) : null}
            </div>

            {/* Estimate */}
            <p className={s.estimate} aria-live="polite">
              ~<b>{estimate}</b> {estimate === 1 ? 'image' : 'images'}
              {targetedSlots > 0 ? <> ({targetedSlots} {targetedSlots === 1 ? 'slot' : 'slots'} × {variants})</> : null}
            </p>

            {/* Time estimate — per-image rate (rolling average from recent jobs, or the 30s default)
                + a total batch ETA. Updates live with variants/scope; no submit required to see it. */}
            {estimate > 0 && (
              <p className={s.eta} aria-live="polite">
                ~{avgSeconds}s per image · <b>~{formatDuration(etaSeconds)}</b> total
              </p>
            )}

            {/* Budget preview — how this run moves the trailing-5h usage toward the cap. Only shown
                when we have real usage numbers; omits the "/ cap" tail when 5h is uncapped. */}
            {estimate > 0 && usage?.known && usage.used5h != null && (
              <p className={s.eta} aria-live="polite">
                This run: <b>+{estimate}</b> → 5h usage {usage.used5h}→{usage.used5h + estimate}
                {usage.cap5h != null ? <> / {usage.cap5h}</> : null}
              </p>
            )}
          </div>

          <div className={s.foot}>
            <button type="button" className={`${s.btn} ${s.secondary}`} onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.primary}`}
              onClick={submit}
              disabled={!canSubmit}
            >
              <Icon name="sparkles" size={15} />
              <span>{runAt ? 'Schedule' : 'Generate'}</span>
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
