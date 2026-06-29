// DetailDrawer (container) — CENTERED MODAL for a single slot.
// (Kept the filename so AppShell's `import DetailDrawer from './DetailDrawer'` still resolves.)
// Reads ui.drawerRel + state from the store; finds the slot's ad/variation/prompt coords;
// renders the full image large + centered, coords + status, the prompt text (scrollable),
// the reference image (via api.getPrompt), and a primary Revise flow + quiet secondary actions.
import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from './Icon';
import { Thumb } from './Thumb';
import { StatusPill } from './StatusPill';
import { useStore } from '../store';
import { api } from '../api';
import type { AdNode, VariationNode, PromptNode, Slot, PromptInfo } from '../types';
import s from './DetailDrawer.module.css';

interface Located {
  ad: AdNode;
  variation: VariationNode;
  prompt: PromptNode;
  slot: Slot;
}

// Find the ad/variation/prompt that owns the slot whose relPath === target.
function locate(ads: AdNode[], relPath: string): Located | null {
  for (const ad of ads) {
    for (const variation of ad.variations) {
      for (const prompt of variation.prompts) {
        const slot = prompt.slots.find((sl) => sl.relPath === relPath);
        if (slot) return { ad, variation, prompt, slot };
      }
    }
  }
  return null;
}

export default function DetailDrawer() {
  const drawerRel = useStore((st) => st.ui.drawerRel);
  const state = useStore((st) => st.state);
  const brand = useStore((st) => st.brand);
  const batch = useStore((st) => st.batch);
  const setUI = useStore((st) => st.setUI);

  const [promptInfo, setPromptInfo] = useState<PromptInfo | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);

  // Revise flow
  const [instruction, setInstruction] = useState('');
  const [revising, setRevising] = useState(false);
  const [revisedOk, setRevisedOk] = useState(false);

  const found = useMemo(
    () => (drawerRel && state ? locate(state.ads, drawerRel) : null),
    [drawerRel, state]
  );

  const open = drawerRel != null;
  const close = () => setUI({ drawerRel: null });

  // Versions strip = every renderable slot under the same prompt (done/archived).
  const versions = useMemo(
    () => (found ? found.prompt.slots.filter((sl) => sl.relPath) : []),
    [found]
  );

  // Resolve the slot's ad/variation/prompt coords from state, then fetch the prompt
  // text + reference image(s). Keyed on the coords (+ brand/batch) so it refetches when you
  // switch to a slot under a different prompt, but not when you flip between versions.
  const adId = found?.ad.id ?? null;
  const variationId = found?.variation.id ?? null;
  const promptId = found?.prompt.id ?? null;

  useEffect(() => {
    if (!open || !brand || !batch || !adId || !variationId || !promptId) {
      setPromptInfo(null);
      setPromptLoading(false);
      return;
    }
    let alive = true;
    setPromptLoading(true);
    setPromptInfo(null);
    api
      .getPrompt(brand, batch, adId, variationId, promptId)
      .then((info) => {
        if (alive) setPromptInfo(info);
      })
      .finally(() => {
        if (alive) setPromptLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, brand, batch, adId, variationId, promptId]);

  // Reset the revise field + confirmation whenever the modal closes or the shown slot changes.
  useEffect(() => {
    setInstruction('');
    setRevising(false);
    setRevisedOk(false);
  }, [drawerRel]);

  const refUrl = promptInfo?.refUrl || null;
  const refName = promptInfo?.refName || null;
  const promptText = promptInfo?.text?.trim() || '';

  if (!open) return null;

  const ad = found?.ad;
  const variation = found?.variation;
  const prompt = found?.prompt;
  const slot = found?.slot;
  const isArchived = slot?.status === 'archived';

  const adLabel = ad ? ad.title || ad.id : '—';
  const varLabel = variation ? variation.label || variation.id : '';
  const coords = found
    ? [adLabel, varLabel || variation!.id, prompt!.id].filter(Boolean).join(' · ')
    : '';

  const switchTo = (relPath: string) => {
    setUI({ drawerRel: relPath });
  };

  const doRevise = async () => {
    const text = instruction.trim();
    if (!drawerRel || !text || revising) return;
    setRevising(true);
    setRevisedOk(false);
    const r = await api.revise(drawerRel, text);
    setRevising(false);
    if (r.ok) {
      setRevisedOk(true);
      setInstruction('');
      window.setTimeout(() => setRevisedOk(false), 4000);
    }
  };

  const onReviseKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doRevise();
    }
  };

  const regenerate = () => {
    if (drawerRel) api.regenerate(drawerRel);
  };

  const toggleArchive = () => {
    if (drawerRel && slot) api.archive(drawerRel, !isArchived);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.content} aria-describedby={undefined}>
          <Dialog.Close className={s.close} aria-label="Close">
            <Icon name="x" size={16} />
          </Dialog.Close>

          <div className={s.body}>
            {/* Full image — large + centered at top */}
            <div className={s.hero}>
              {drawerRel ? (
                <img
                  className={s.heroImg}
                  src={api.imgUrl(drawerRel)}
                  alt={coords || drawerRel}
                  decoding="async"
                />
              ) : (
                <div className={s.heroEmpty}>
                  <Icon name="photo" size={22} />
                  <span>No image found for this path.</span>
                </div>
              )}
            </div>

            {/* Coords + status */}
            <div className={s.meta}>
              <p className={s.eyebrow}>Image detail</p>
              <Dialog.Title className={s.title}>{adLabel}</Dialog.Title>
              <div className={s.coords}>
                <span className={s.coordText}>{coords || drawerRel}</span>
                {slot ? <StatusPill status={slot.status} /> : null}
              </div>
            </div>

            {/* Versions strip */}
            {versions.length > 1 ? (
              <div className={s.section}>
                <p className={s.label}>Versions</p>
                <div className={s.strip}>
                  {versions.map((v) => {
                    const active = v.relPath === drawerRel;
                    return (
                      <button
                        key={v.relPath}
                        type="button"
                        className={`${s.thumbBtn} ${active ? s.thumbActive : ''} ${v.status === 'archived' ? s.thumbArchived : ''}`}
                        onClick={() => switchTo(v.relPath!)}
                        aria-label={`Show version ${v.version ?? v.run}`}
                        aria-current={active}
                      >
                        <Thumb relPath={v.relPath!} alt={`v${v.version ?? v.run}`} />
                        <span className={s.thumbVer}>v{v.version ?? v.run}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* PRIMARY ACTION — Revise */}
            <div className={s.revise}>
              <label className={s.reviseLabel} htmlFor="revise-input">
                Revise this image
              </label>
              <div className={s.reviseRow}>
                <input
                  id="revise-input"
                  className={s.reviseInput}
                  type="text"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={onReviseKey}
                  placeholder="What should change? (e.g. brighter, show the tube label, less wrinkly)"
                  disabled={!drawerRel || revising}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className={s.reviseBtn}
                  onClick={doRevise}
                  disabled={!drawerRel || revising || !instruction.trim()}
                >
                  <Icon name="sparkles" size={15} />
                  <span>{revising ? 'Queuing…' : 'Revise'}</span>
                </button>
              </div>
              <div className={s.reviseHint} aria-live="polite">
                {revisedOk
                  ? 'Queued — a new version is on the way.'
                  : 'Queues a new version with your change applied.'}
              </div>
            </div>

            {/* Prompt text */}
            <div className={s.section}>
              <p className={s.label}>Prompt</p>
              {promptLoading ? (
                <div className={`${s.promptBox} ${s.promptLoading}`} aria-busy="true">
                  <span className={s.skelLine} />
                  <span className={s.skelLine} />
                  <span className={`${s.skelLine} ${s.skelShort}`} />
                </div>
              ) : promptText ? (
                <div className={s.promptBox}>{promptText}</div>
              ) : (
                <div className={`${s.promptBox} ${s.promptEmpty}`}>
                  No prompt text available for this slot.
                </div>
              )}
            </div>

            {/* Reference image(s) */}
            {refUrl ? (
              <div className={s.section}>
                <p className={s.label}>Reference</p>
                <div className={s.refRow}>
                  <div className={s.refThumb}>
                    <img
                      src={refUrl}
                      alt={refName || 'Reference image'}
                      decoding="async"
                    />
                  </div>
                  {refName ? <span className={s.refName}>{refName}</span> : null}
                </div>
              </div>
            ) : null}

            {/* Secondary actions — quiet */}
            <div className={s.secondaryRow}>
              <button
                type="button"
                className={s.quiet}
                onClick={regenerate}
                disabled={!drawerRel}
              >
                <Icon name="refresh" size={14} />
                <span>Regenerate</span>
              </button>

              <a
                className={s.quiet}
                href={drawerRel ? api.imgUrl(drawerRel) : undefined}
                download
                aria-disabled={!drawerRel}
              >
                <Icon name="download" size={14} />
                <span>Download</span>
              </a>

              <a
                className={s.quiet}
                href={drawerRel ? api.imgUrl(drawerRel) : undefined}
                target="_blank"
                rel="noreferrer"
                aria-disabled={!drawerRel}
              >
                <Icon name="photo" size={14} />
                <span>Open original</span>
              </a>

              <button
                type="button"
                className={s.archiveTiny}
                onClick={toggleArchive}
                disabled={!slot}
              >
                <Icon name={isArchived ? 'restore' : 'archive'} size={13} />
                <span>{isArchived ? 'Restore' : 'Archive'}</span>
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
