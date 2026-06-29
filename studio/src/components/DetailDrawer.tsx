// DetailDrawer (container) — right slide-over for a single slot.
// Reads ui.drawerRel + state from the store; finds the slot's ad/variation/prompt
// coords; renders the full image, a versions strip (all slots under that prompt),
// and an actions row (regenerate / make variations / archive / download / copy path).
import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from './Icon';
import { Thumb } from './Thumb';
import { StatusPill } from './StatusPill';
import { useStore } from '../store';
import { api } from '../api';
import type { AdNode, VariationNode, PromptNode, Slot } from '../types';
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

  const [copied, setCopied] = useState(false);

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
    setCopied(false);
    setUI({ drawerRel: relPath });
  };

  const regenerate = () => {
    if (drawerRel) api.regenerate(drawerRel);
  };

  const makeVariations = () => {
    if (brand && batch && ad && variation && prompt) {
      api.generate(brand, batch, { prompt: { ad: ad.id, variation: variation.id, prompt: prompt.id } }, 2);
    }
  };

  const toggleArchive = () => {
    if (drawerRel && slot) api.archive(drawerRel, !isArchived);
  };

  const copyPath = async () => {
    if (!drawerRel) return;
    try {
      await navigator.clipboard.writeText(drawerRel);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.content} aria-describedby={undefined}>
          <div className={s.head}>
            <div className={s.crumb}>
              <p className={s.eyebrow}>Image detail</p>
              <Dialog.Title className={s.title}>{adLabel}</Dialog.Title>
              <div className={s.coords}>
                <span className={s.coordText}>{coords || drawerRel}</span>
                {slot ? <StatusPill status={slot.status} /> : null}
              </div>
            </div>
            <Dialog.Close className={s.close} aria-label="Close">
              <Icon name="x" size={16} />
            </Dialog.Close>
          </div>

          <div className={s.body}>
            {/* Full image, contained */}
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

            {/* Actions */}
            <div className={s.section}>
              <p className={s.label}>Actions</p>
              <div className={s.actions}>
                <button
                  type="button"
                  className={`${s.btn} ${s.primary}`}
                  onClick={regenerate}
                  disabled={!drawerRel}
                >
                  <Icon name="refresh" size={15} />
                  <span>Regenerate</span>
                </button>

                <button
                  type="button"
                  className={`${s.btn} ${s.secondary}`}
                  onClick={makeVariations}
                  disabled={!found || !brand || !batch}
                >
                  <Icon name="sparkles" size={15} />
                  <span>Make 2 variations</span>
                </button>

                <button
                  type="button"
                  className={`${s.btn} ${s.secondary} ${s.danger}`}
                  onClick={toggleArchive}
                  disabled={!slot}
                >
                  <Icon name={isArchived ? 'restore' : 'archive'} size={15} />
                  <span>{isArchived ? 'Restore' : 'Archive'}</span>
                </button>

                <a
                  className={`${s.btn} ${s.secondary}`}
                  href={drawerRel ? api.imgUrl(drawerRel) : undefined}
                  download
                  aria-disabled={!drawerRel}
                >
                  <Icon name="download" size={15} />
                  <span>Download</span>
                </a>

                <button
                  type="button"
                  className={`${s.btn} ${s.secondary}`}
                  onClick={copyPath}
                  disabled={!drawerRel}
                  style={{ gridColumn: '1 / -1' }}
                >
                  <Icon name={copied ? 'check' : 'photo'} size={15} />
                  <span>{copied ? 'Copied path' : 'Copy path'}</span>
                </button>
              </div>
              <div className={s.ok} aria-live="polite">
                {copied ? 'Path copied to clipboard.' : ''}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
