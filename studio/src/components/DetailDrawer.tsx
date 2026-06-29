// DetailDrawer (container) — a wide CENTERED MODAL for one image.
// (Filename kept so AppShell's `import DetailDrawer from './DetailDrawer'` still resolves.)
// Layout: a LARGE image fills the left; a right rail holds Reference → Prompt → Revise, with clean
// action buttons (Download / Open / Regenerate / Archive) at the foot. No versions strip.
import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from './Icon';
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
  const [instruction, setInstruction] = useState('');
  const [revising, setRevising] = useState(false);
  const [revisedOk, setRevisedOk] = useState(false);

  const found = useMemo(
    () => (drawerRel && state ? locate(state.ads, drawerRel) : null),
    [drawerRel, state],
  );

  const open = drawerRel != null;
  const close = () => setUI({ drawerRel: null });

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
      .then((info) => { if (alive) setPromptInfo(info); })
      .finally(() => { if (alive) setPromptLoading(false); });
    return () => { alive = false; };
  }, [open, brand, batch, adId, variationId, promptId]);

  useEffect(() => {
    setInstruction('');
    setRevising(false);
    setRevisedOk(false);
  }, [drawerRel]);

  if (!open) return null;

  const slot = found?.slot;
  const isArchived = slot?.status === 'archived';
  const adLabel = found ? found.ad.title || found.ad.id : '—';
  const varLabel = found ? found.variation.label || found.variation.id : '';
  const coords = found ? [varLabel, found.prompt.id].filter(Boolean).join(' · ') : '';
  const refUrl = promptInfo?.refUrl || null;
  const refName = promptInfo?.refName || null;
  const promptText = promptInfo?.text?.trim() || '';

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

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.content} aria-describedby={undefined}>
          <Dialog.Close className={s.close} aria-label="Close">
            <Icon name="x" size={16} />
          </Dialog.Close>

          {/* LEFT — large image */}
          <div className={s.stage}>
            {drawerRel ? (
              <img className={s.stageImg} src={api.imgUrl(drawerRel)} alt={coords || drawerRel} decoding="async" />
            ) : (
              <div className={s.stageEmpty}>
                <Icon name="photo" size={24} />
                <span>No image found.</span>
              </div>
            )}
          </div>

          {/* RIGHT — rail */}
          <aside className={s.rail}>
            <header className={s.head}>
              <p className={s.eyebrow}>Image detail</p>
              <Dialog.Title className={s.title}>{adLabel}</Dialog.Title>
              <p className={s.coords}>{coords || drawerRel}</p>
            </header>

            <div className={s.railScroll}>
              {refUrl ? (
                <section className={s.block}>
                  <p className={s.label}>Reference</p>
                  <div className={s.refRow}>
                    <div className={s.refThumb}>
                      <img src={refUrl} alt={refName || 'Reference'} decoding="async" />
                    </div>
                    <span className={s.refName}>{refName || 'Reference image'}</span>
                  </div>
                </section>
              ) : null}

              <section className={s.block}>
                <p className={s.label}>Prompt</p>
                {promptLoading ? (
                  <div className={`${s.promptBox} ${s.promptLoading}`} aria-busy="true">
                    <span className={s.skel} /><span className={s.skel} /><span className={`${s.skel} ${s.skelShort}`} />
                  </div>
                ) : promptText ? (
                  <div className={s.promptBox}>{promptText}</div>
                ) : (
                  <div className={`${s.promptBox} ${s.promptEmpty}`}>No prompt text for this slot.</div>
                )}
              </section>

              <section className={s.block}>
                <p className={s.label}>Revise</p>
                <input
                  className={s.reviseInput}
                  type="text"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doRevise(); } }}
                  placeholder="What should change? (e.g. brighter, show the tube label)"
                  disabled={revising}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className={s.reviseBtn}
                  onClick={doRevise}
                  disabled={revising || !instruction.trim()}
                >
                  <Icon name="sparkles" size={15} />
                  <span>{revising ? 'Queuing…' : 'Revise'}</span>
                </button>
                <p className={s.hint} aria-live="polite">
                  {revisedOk ? 'Queued — a new version is on the way.' : 'Queues a new version with your change.'}
                </p>
              </section>
            </div>

            {/* Clean action buttons at the foot of the rail */}
            <footer className={s.actions}>
              <a className={s.action} href={drawerRel ? api.imgUrl(drawerRel) : undefined} download>
                <Icon name="download" size={15} /><span>Download</span>
              </a>
              <a className={s.action} href={drawerRel ? api.imgUrl(drawerRel) : undefined} target="_blank" rel="noreferrer">
                <Icon name="expand" size={15} /><span>Open</span>
              </a>
              <button type="button" className={s.action} onClick={() => drawerRel && api.regenerate(drawerRel)}>
                <Icon name="refresh" size={15} /><span>Regenerate</span>
              </button>
              <button type="button" className={s.action} onClick={() => drawerRel && slot && api.archive(drawerRel, !isArchived)} disabled={!slot}>
                <Icon name={isArchived ? 'restore' : 'archive'} size={15} /><span>{isArchived ? 'Restore' : 'Archive'}</span>
              </button>
            </footer>
          </aside>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
