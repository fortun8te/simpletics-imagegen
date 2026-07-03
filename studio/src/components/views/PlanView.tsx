// Plan view — creative spec: concepts, prompts, refs, inline edit, search.
// Layout: each variation is one grouped card (concept header + prompt rows separated by
// hairlines) instead of loose nested cards, so the spec reads as a document, not a pile of boxes.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import AdSection from '../AdSection';
import { EmptyState } from '../EmptyState';
import { RefLightbox, type RefLightboxTarget } from '../RefLightbox';
import { api } from '../../api';
import { filterPlan, getBatchPlan, type PlanAd, type PlanPrompt } from '../../lib/batchPlan';
import type { PromptRef } from '../../types';
import PlannerRail from '../PlannerRail';
import { classifyAdType } from '../../lib/adType';
import styles from './PlanView.module.css';

const REF_LABELS: Record<PromptRef['role'], string> = {
  product: 'Product',
  layout: 'Layout',
  model: 'Model',
  extra: 'Extra',
  tube: 'Tube',
};

const PromptRow = memo(function PromptRow({
  adId,
  variationId,
  prompt,
  brand,
  batch,
  onSaved,
}: {
  adId: string;
  variationId: string;
  prompt: PlanPrompt;
  brand: string;
  batch: string;
  onSaved: () => void;
}) {
  const setUI = useStore((s) => s.setUI);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(prompt.text);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lightbox, setLightbox] = useState<RefLightboxTarget | null>(null);

  useEffect(() => { setDraft(prompt.text); }, [prompt.text]);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  };

  const viewImages = () => {
    setUI({ batchViewMode: 'gallery' });
    const targetId = `gallery-${adId}-${variationId}-${prompt.id}`;
    const scrollTo = () =>
      document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.requestAnimationFrame(() => {
      scrollTo();
      window.setTimeout(scrollTo, 120);
    });
  };

  const savePrompt = async () => {
    if (draft === prompt.text) { setEditing(false); return; }
    setSaving(true);
    const r = await api.patchPrompt(brand, batch, adId, variationId, prompt.id, { prompt: draft });
    setSaving(false);
    if (r.ok) { setEditing(false); onSaved(); }
  };

  const blocks = prompt.recipe?.blocks ? Object.entries(prompt.recipe.blocks) : [];

  return (
    <article className={styles.promptRow}>
      <div className={styles.promptMain}>
        <div className={styles.promptHead}>
          <span className={styles.promptId}>{prompt.id}</span>
          <span className={styles.promptLabel}>{prompt.label}</span>
          {blocks.length > 0 ? (
            <span className={styles.recipe}>
              {blocks.map(([key, val]) => (
                <span key={key} className={styles.recipeChip}>{key}:{val}</span>
              ))}
            </span>
          ) : null}
          <span className={styles.stats}>{prompt.slotSummary}</span>
        </div>

        {prompt.refs.length > 0 ? (
          <div className={styles.refStrip} aria-label="Reference images">
            {prompt.refs.map((ref, i) => {
              // Badge text: with a single ref the role is obvious from context, so skip the
              // badge entirely; with multiple refs (mirroring how the prompt addresses each
              // as @img1, @img2, …) show just the index — the corner badge is tiny, a full
              // "N · ROLE" string doesn't fit and isn't needed to disambiguate.
              const multi = prompt.refs.length > 1;
              return (
                <button
                  key={ref.url}
                  type="button"
                  className={styles.refItem}
                  title={`@img${i + 1} · ${REF_LABELS[ref.role]} · ${ref.name}`}
                  onClick={() => setLightbox({
                    url: ref.url,
                    label: `@img${i + 1} · ${REF_LABELS[ref.role]}`,
                    name: ref.name,
                  })}
                >
                  <img
                    className={styles.refImg}
                    src={ref.url}
                    alt={REF_LABELS[ref.role]}
                    decoding="async"
                    loading="lazy"
                    onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.35'; }}
                  />
                  {multi ? <span className={styles.refTag}>{i + 1}</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
        <RefLightbox target={lightbox} onClose={() => setLightbox(null)} />

        {editing ? (
          <div className={styles.promptEditWrap}>
            <textarea
              className={styles.promptEdit}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              spellCheck={false}
            />
            <div className={styles.editActions}>
              <span className={styles.charCount}>{draft.length.toLocaleString()} chars</span>
              <button type="button" className={styles.textBtn} onClick={() => { setEditing(false); setDraft(prompt.text); }}>
                Cancel
              </button>
              <button type="button" className={styles.saveBtn} onClick={savePrompt} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={`${styles.promptBody} ${expanded ? styles.promptBodyOpen : ''}`}
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Collapse prompt' : 'Show full prompt'}
          >
            {prompt.text || '—'}
          </button>
        )}

        {!editing ? (
          <div className={styles.promptActions}>
            <button type="button" className={styles.textBtn} onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Hide prompt' : 'Prompt'}
            </button>
            <button type="button" className={styles.textBtn} onClick={() => { setEditing(true); setExpanded(true); }}>
              Edit
            </button>
            <button type="button" className={`${styles.textBtn} ${copied ? styles.copied : ''}`} onClick={copyPrompt}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className={styles.textBtn} onClick={viewImages}>
              Images
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
});

function ModelsPool({
  brand,
  batch,
  adId,
  models,
}: {
  brand: string;
  batch: string;
  adId: string;
  models: { id: string }[];
}) {
  if (!models.length) return null;
  return (
    <div className={styles.modelsPool} aria-label="Model candidates">
      <span className={styles.modelsLabel}>Models</span>
      <div className={styles.modelsRow}>
        {models.map((m) => {
          const rel = `${brand}/${batch}/models/${adId}/${m.id}/run-1.png`;
          const url = `/img?path=${encodeURIComponent(rel)}&w=240`;
          return (
            <a
              key={m.id}
              className={styles.modelThumb}
              href={`/img?path=${encodeURIComponent(rel)}`}
              target="_blank"
              rel="noreferrer"
              title={m.id}
            >
              <img src={url} alt="" decoding="async" loading="lazy" onError={(e) => {
                (e.target as HTMLImageElement).style.opacity = '0.3';
              }} />
              <span>{m.id}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

export default function PlanView() {
  const config = useStore((s) => s.config);
  const state = useStore((s) => s.state);
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const setConfig = useStore((s) => s.setConfig);

  // Search input lives in the TopBar (ui.planQuery); this view just filters on it.
  const query = useStore((s) => s.ui.planQuery);
  const setUI = useStore((s) => s.setUI);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeAdId, setActiveAdId] = useState<string | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 180);
    return () => window.clearTimeout(t);
  }, [query]);

  const plan = useMemo(() => {
    if (!brand || !batch) return null;
    return getBatchPlan(config, brand, batch, state);
  }, [config, brand, batch, state]);

  const ads = useMemo(() => {
    if (!plan) return [];
    return filterPlan(plan, debouncedQuery).ads;
  }, [plan, debouncedQuery]);

  const activeAd = ads.find((a) => a.id === activeAdId) ?? ads[0] ?? null;
  const activeIndex = activeAd ? ads.findIndex((a) => a.id === activeAd.id) : -1;

  // Publish the scroll cursor to the TopBar; clear it when the view unmounts.
  useEffect(() => {
    setUI({
      adCursor: activeAd ? { index: activeIndex, total: ads.length, title: activeAd.title } : null,
    });
  }, [activeAd, activeIndex, ads.length, setUI]);
  useEffect(() => () => { useStore.getState().setUI({ adCursor: null }); }, []);

  const onPromptSaved = useCallback(() => {
    api.getConfig().then(setConfig);
  }, [setConfig]);

  useEffect(() => {
    if (!ads.length) { setActiveAdId(null); return; }
    if (!activeAdId || !ads.some((a) => a.id === activeAdId)) setActiveAdId(ads[0].id);
  }, [ads, activeAdId]);

  useEffect(() => {
    const nodes = [...sectionRefs.current.values()];
    if (!nodes.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        const top = visible[0]?.target.getAttribute('data-ad-id');
        if (top) setActiveAdId(top);
      },
      { root: null, rootMargin: '-72px 0px -62% 0px', threshold: [0.12, 0.35] },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [ads]);

  if (!plan?.ads.length) {
    return (
      <EmptyState icon="layout-list" title="No plan data" hint="This batch has no ads in config.json yet." />
    );
  }

  return (
    <div className={styles.planWithRail}>
    <div className={styles.plan}>
      {ads.length === 0 ? (
        <EmptyState icon="search" title="No matches" hint={`Nothing matches “${query.trim()}”.`} />
      ) : (
        <div className={styles.sections}>
          {ads.map((ad: PlanAd) => (
            <div
              key={ad.id}
              id={`plan-ad-${ad.id}`}
              data-ad-id={ad.id}
              ref={(el) => {
                if (el) sectionRefs.current.set(ad.id, el);
                else sectionRefs.current.delete(ad.id);
              }}
            >
              <AdSection
                adId={ad.id}
                title={ad.title}
                type={ad.type}
                adTypeTag={classifyAdType({ kind: ad.kind, type: ad.type, title: ad.title })}
                showActions={false}
              >
                {ad.kind === 'face' && brand && batch ? (
                  <ModelsPool brand={brand} batch={batch} adId={ad.id} models={ad.models ?? []} />
                ) : null}
                {ad.variations.map((variation) => (
                  <section key={variation.id} className={styles.variation}>
                    <div className={styles.conceptHead}>
                      <h3 className={styles.conceptLabel}>{variation.label}</h3>
                      {variation.copy ? <p className={styles.conceptCopy}>{variation.copy}</p> : null}
                    </div>
                    <div className={styles.promptList}>
                      {variation.prompts.map((p) => (
                        <PromptRow
                          key={p.id}
                          adId={ad.id}
                          variationId={variation.id}
                          prompt={p}
                          brand={brand!}
                          batch={batch!}
                          onSaved={onPromptSaved}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </AdSection>
            </div>
          ))}
        </div>
      )}
    </div>
    <PlannerRail />
    </div>
  );
}
