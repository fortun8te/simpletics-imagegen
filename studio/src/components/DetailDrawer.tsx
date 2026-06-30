// DetailDrawer — premium floating image modal (Linear/Raycast + Claritas feel).
// Tall glass panel: a header bar with an "ad / variation / prompt" breadcrumb + close,
// a three-part body — large image stage (left), a slim vertical action toolbar (middle),
// and a scrollable REFERENCE/PROMPT/REVISE rail (right). No footer; actions live on the side.
// Keeps all functionality, Radix Dialog primitives, and the z 100/101 + isolation fix.
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
  const refUrl = promptInfo?.refUrl || null;
  const refName = promptInfo?.refName || null;
  const promptText = promptInfo?.text?.trim() || '';

  // Breadcrumb: ad / variation / prompt (falls back to the rel path if not located).
  const crumb = found
    ? [found.ad.title || found.ad.id, found.variation.label || found.variation.id, found.prompt.id].filter(Boolean)
    : [drawerRel ?? '—'];
  const crumbLabel = crumb.join(' / ');

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
          {/* Header — breadcrumb left, close right, thin divider under */}
          <header className={s.head}>
            <Dialog.Title className={s.crumb} aria-label={crumbLabel}>
              {crumb.map((c, i) => (
                <span key={i} className={s.crumbRow}>
                  {i > 0 && <span className={s.sep} aria-hidden="true">/</span>}
                  <span className={i === crumb.length - 1 ? s.crumbNow : s.crumbItem}>{c}</span>
                </span>
              ))}
            </Dialog.Title>
            <Dialog.Close className={s.close} aria-label="Close">
              <Icon name="x" size={16} />
            </Dialog.Close>
          </header>

          {/* Body — image stage + vertical action toolbar + info rail */}
          <div className={s.body}>
            <div className={s.stage}>
              {drawerRel ? (
                <img
                  className={s.stageImg}
                  src={api.imgUrl(drawerRel)}
                  alt={crumbLabel || drawerRel}
                  decoding="async"
                />
              ) : (
                <div className={s.stageEmpty}>
                  <Icon name="photo" size={24} />
                  <span>No image found.</span>
                </div>
              )}
            </div>

            {/* Vertical action toolbar — sits between the image and the info rail */}
            <nav className={s.toolbar} aria-label="Image actions">
              <a
                className={`${s.toolBtn} ${s.toolPrimary}`}
                href={drawerRel ? api.imgUrl(drawerRel) : undefined}
                download
                title="Download image"
                aria-label="Download image"
              >
                <Icon name="download" size={18} />
              </a>
              <a
                className={s.toolBtn}
                href={drawerRel ? api.imgUrl(drawerRel) : undefined}
                target="_blank"
                rel="noreferrer"
                title="Open original in a new tab"
                aria-label="Open original"
              >
                <Icon name="expand" size={18} />
              </a>
              <button
                type="button"
                className={s.toolBtn}
                onClick={() => drawerRel && api.regenerate(drawerRel)}
                title="Regenerate this image"
                aria-label="Regenerate"
              >
                <Icon name="refresh" size={18} />
              </button>
              <span className={s.toolDivider} aria-hidden="true" />
              <button
                type="button"
                className={s.toolBtn}
                onClick={() => drawerRel && slot && api.archive(drawerRel, !isArchived)}
                disabled={!slot}
                title={isArchived ? 'Restore from archive' : 'Archive this image'}
                aria-label={isArchived ? 'Restore' : 'Archive'}
              >
                <Icon name={isArchived ? 'restore' : 'archive'} size={18} />
              </button>
            </nav>

            <aside className={s.rail}>
              <div className={s.railScroll}>
                {refUrl ? (
                  <section className={s.section}>
                    <div className={s.sectionHead}>
                      <span className={s.label}>Reference</span>
                    </div>
                    <div className={s.refCard}>
                      <div className={s.refThumb}>
                        <img src={refUrl} alt={refName || 'Reference'} decoding="async" />
                      </div>
                      <div className={s.refMeta}>
                        <span className={s.refName}>{refName || 'Reference image'}</span>
                        <span className={s.refSub}>Used for this prompt</span>
                      </div>
                    </div>
                  </section>
                ) : null}

                <section className={s.section}>
                  <div className={s.sectionHead}>
                    <span className={s.label}>Prompt</span>
                  </div>
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

                <section className={s.section}>
                  <div className={s.sectionHead}>
                    <span className={s.label}>Revise</span>
                    <span className={s.sectionHint}>queues a new version</span>
                  </div>
                  <textarea
                    className={s.reviseInput}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doRevise(); } }}
                    placeholder="What should change? e.g. brighter lighting, show the tube label"
                    disabled={revising}
                    autoComplete="off"
                    rows={3}
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
                    {revisedOk ? 'Queued — a new version is on the way.' : ''}
                  </p>
                </section>
              </div>
            </aside>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
