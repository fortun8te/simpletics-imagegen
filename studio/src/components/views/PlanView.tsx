// Plan view — read-only creative spec: concepts, prompts, refs, slot status from config + state.
import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import AdSection from '../AdSection';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import { getBatchPlan, type PlanPrompt } from '../../lib/batchPlan';
import type { PromptRef } from '../../types';
import styles from './PlanView.module.css';

const REF_LABELS: Record<PromptRef['role'], string> = {
  product: 'Product',
  layout: 'Layout',
  model: 'Model',
  extra: 'Extra',
  tube: 'Tube',
};

function PromptCard({
  adId,
  variationId,
  prompt,
}: {
  adId: string;
  variationId: string;
  prompt: PlanPrompt;
}) {
  const setUI = useStore((s) => s.setUI);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  };

  const viewImages = () => {
    setUI({ batchViewMode: 'gallery' });
    window.requestAnimationFrame(() => {
      document.getElementById(`gallery-${adId}-${variationId}-${prompt.id}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  };

  const blocks = prompt.recipe?.blocks ? Object.entries(prompt.recipe.blocks) : [];

  return (
    <article className={styles.promptCard}>
      <div className={styles.promptHead}>
        <div className={styles.promptMeta}>
          <span className={styles.promptId}>{prompt.id}</span>
          <span className={styles.promptLabel}>{prompt.label}</span>
        </div>
        <span className={styles.stats}>{prompt.slotSummary}</span>
      </div>

      {prompt.refs.length > 0 ? (
        <div className={styles.refStrip} aria-label="Reference images">
          {prompt.refs.map((ref) => (
            <a
              key={`${ref.role}-${ref.url}`}
              className={styles.refItem}
              href={ref.url}
              target="_blank"
              rel="noreferrer"
              title={`${REF_LABELS[ref.role]} · ${ref.name}`}
            >
              <img
                className={styles.refImg}
                src={ref.url}
                alt=""
                decoding="async"
                onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.35'; }}
              />
              <span className={styles.refBadge}>{REF_LABELS[ref.role]}</span>
            </a>
          ))}
        </div>
      ) : null}

      {blocks.length > 0 ? (
        <div className={styles.recipe}>
          {blocks.map(([key, val]) => (
            <span key={key} className={styles.recipeChip}>{key}:{val}</span>
          ))}
        </div>
      ) : null}

      <p className={`${styles.promptBody} ${expanded ? styles.promptBodyExpanded : ''}`}>
        {prompt.text || '—'}
      </p>
      <span className={styles.charCount}>{prompt.text.length.toLocaleString()} chars</span>

      <div className={styles.promptActions}>
        <button type="button" className={styles.textBtn} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
        <button
          type="button"
          className={`${styles.textBtn} ${copied ? styles.copied : ''}`}
          onClick={copyPrompt}
        >
          {copied ? 'Copied' : 'Copy prompt'}
        </button>
        <button type="button" className={styles.linkBtn} onClick={viewImages}>
          <Icon name="photo" size={13} />
          View images
        </button>
      </div>
    </article>
  );
}

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
      <span className={styles.modelsLabel}>Models pool</span>
      <div className={styles.modelsRow}>
        {models.map((m) => {
          const rel = `${brand}/${batch}/models/${adId}/${m.id}/run-1.png`;
          const url = `/img?path=${encodeURIComponent(rel)}&w=160`;
          return (
            <a
              key={m.id}
              className={styles.modelThumb}
              href={`/img?path=${encodeURIComponent(rel)}`}
              target="_blank"
              rel="noreferrer"
              title={m.id}
            >
              <img src={url} alt="" decoding="async" onError={(e) => {
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
  const plan = useMemo(() => {
    if (!brand || !batch) return null;
    return getBatchPlan(config, brand, batch, state);
  }, [config, brand, batch, state]);

  if (!plan?.ads.length) {
    return (
      <EmptyState
        icon="layout-list"
        title="No plan data"
        hint="This batch has no ads in config.json yet."
      />
    );
  }

  return (
    <div className={styles.plan}>
      <div className={styles.sections}>
        {plan.ads.map((ad) => (
          <AdSection key={ad.id} adId={ad.id} title={ad.title} type={ad.type}>
            {ad.kind === 'face' && brand && batch ? (
              <ModelsPool brand={brand} batch={batch} adId={ad.id} models={ad.models ?? []} />
            ) : null}
            {ad.variations.map((variation) => (
              <section key={variation.id} className={styles.variation}>
                <div className={styles.conceptHead}>
                  <h3 className={styles.conceptLabel}>{variation.label}</h3>
                  {variation.copy ? (
                    <p className={styles.conceptCopy}>{variation.copy}</p>
                  ) : null}
                </div>
                <div className={styles.promptList}>
                  {variation.prompts.map((p) => (
                    <PromptCard
                      key={p.id}
                      adId={ad.id}
                      variationId={variation.id}
                      prompt={p}
                    />
                  ))}
                </div>
              </section>
            ))}
          </AdSection>
        ))}
      </div>
    </div>
  );
}
