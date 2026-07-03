// Plan view data layer — merges config.json authoring with /api/state slot status.
import type {
  BatchState,
  Config,
  ConfigAd,
  ConfigVariation,
  PromptRecipe,
  PromptRef,
  Slot,
  SlotStatus,
} from '../types';
import { variationRelDir } from '../paths';

const TUBE_RE = /image 1 is the [^.]*tube|tube reading/i;

/** Mirror studio-server promptEntries: explicit prompts[] or legacy variation.prompt → p1. */
export function promptEntries(variation: ConfigVariation) {
  const list = variation.prompts?.length
    ? variation.prompts
    : variation.prompt
      ? [{ id: 'p1', prompt: variation.prompt }]
      : [];
  return list.map((e, i) => ({
    id: e.id || `p${i + 1}`,
    label: e.label,
    prompt: e.prompt,
    recipe: e.recipe,
  }));
}

export interface PlanPrompt {
  id: string;
  label: string;
  text: string;
  recipe?: PromptRecipe;
  slots: Slot[];
  slotSummary: string;
  path: string;
  refs: PromptRef[];
}

export interface PlanVariation {
  id: string;
  label: string;
  copy?: string;
  model?: string;
  path: string;
  prompts: PlanPrompt[];
}

export interface PlanAd {
  id: string;
  title: string;
  type?: string;
  kind?: string;
  product?: string;
  models?: ConfigAd['models'];
  variations: PlanVariation[];
}

export interface BatchPlan {
  ads: PlanAd[];
}

function isTubeShot(text: string) {
  return TUBE_RE.test(text);
}

/** Client-side ref URL builder (mirrors studio-server /api/prompt). */
export function buildPromptRefs(
  brand: string,
  batch: string,
  ad: ConfigAd,
  variation: ConfigVariation,
  promptText: string,
): PromptRef[] {
  const refs: PromptRef[] = [];
  const seen = new Set<string>();

  const push = (role: PromptRef['role'], name: string, url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    refs.push({ role, name, url });
  };

  if (ad.product) {
    push('product', ad.product, `/asset?name=${encodeURIComponent(ad.product)}`);
  }
  if (ad.ref) {
    push('layout', ad.ref, `/refs?name=${encodeURIComponent(ad.ref)}`);
  }
  if (ad.kind === 'face') {
    const modelId = variation.model || ad.models?.[0]?.id;
    if (modelId) {
      const rel = `${brand}/${batch}/models/${ad.id}/${modelId}/run-1.png`;
      push('model', modelId, `/img?path=${encodeURIComponent(rel)}&w=320`);
    }
  }
  for (const key of ad.extraRefs ?? []) {
    push('extra', key, `/asset?name=${encodeURIComponent(key)}`);
  }
  // Tube ref only when the prompt needs it AND we don't already have the same asset as product.
  if (isTubeShot(promptText)) {
    const tubeUrl = '/asset?name=nanox';
    const hasProductTube = refs.some((r) => r.url === tubeUrl || r.name === 'nanox');
    if (!hasProductTube) push('tube', 'nanox', tubeUrl);
  }
  return refs;
}

const STATUS_ORDER: SlotStatus[] = [
  'done', 'generating', 'waiting', 'queued', 'empty', 'failed', 'archived',
];

const STATUS_LABELS: Record<SlotStatus, string> = {
  done: 'done',
  generating: 'generating',
  waiting: 'starting',
  queued: 'queued',
  empty: 'empty',
  failed: 'failed',
  archived: 'archived',
};

export function summarizeSlots(slots: Slot[]): string {
  const counts = new Map<SlotStatus, number>();
  for (const slot of slots) {
    counts.set(slot.status, (counts.get(slot.status) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const status of STATUS_ORDER) {
    const n = counts.get(status);
    if (!n) continue;
    parts.push(`${n} ${STATUS_LABELS[status]}`);
  }
  return parts.join(' · ') || '0 slots';
}

function findStateSlots(
  state: BatchState | null,
  adId: string,
  variationId: string,
  promptId: string,
): Slot[] {
  const ad = state?.ads.find((a) => a.id === adId);
  const variation = ad?.variations.find((v) => v.id === variationId);
  const prompt = variation?.prompts.find((p) => p.id === promptId);
  return prompt?.slots ?? [{ run: 1, status: 'empty' }];
}

export function getBatchPlan(
  config: Config,
  brand: string,
  batch: string,
  state: BatchState | null,
): BatchPlan | null {
  const brandCfg = config.brands.find((b) => b.id === brand);
  const batchCfg = brandCfg?.batches.find((b) => b.code === batch);
  if (!batchCfg?.ads?.length) return null;

  const ads: PlanAd[] = batchCfg.ads.map((ad) => {
    const variations = (ad.variations ?? []).map((variation) => {
      const prompts = promptEntries(variation).map((entry) => {
        const path = variationRelDir(brand, batch, ad.id, variation.id, entry.id);
        const slots = findStateSlots(state, ad.id, variation.id, entry.id);
        return {
          id: entry.id,
          label: entry.label || entry.id,
          text: entry.prompt,
          recipe: entry.recipe,
          slots,
          slotSummary: summarizeSlots(slots),
          path,
          refs: buildPromptRefs(brand, batch, ad, variation, entry.prompt),
        };
      });
      return {
        id: variation.id,
        label: variation.label || variation.id,
        copy: variation.copy,
        model: variation.model,
        path: variationRelDir(brand, batch, ad.id, variation.id),
        prompts,
      };
    });
    return {
      id: ad.id,
      title: ad.title || ad.id,
      type: ad.type,
      kind: ad.kind,
      product: ad.product,
      models: ad.models,
      variations,
    };
  });

  return { ads };
}

/** In-batch search for Plan mode: ad title, variation label/copy, prompt label/text. */
export function filterPlan(plan: BatchPlan, query: string): BatchPlan {
  const q = query.trim().toLowerCase();
  if (!q) return plan;

  const ads = plan.ads
    .map((ad) => {
      const adHit =
        `${ad.title} ${ad.id} ${ad.type ?? ''} ${ad.kind ?? ''}`.toLowerCase().includes(q);
      const variations = ad.variations
        .map((v) => {
          const vHit =
            adHit ||
            `${v.label} ${v.id} ${v.copy ?? ''} ${v.path}`.toLowerCase().includes(q);
          const prompts = v.prompts.filter(
            (p) =>
              adHit ||
              vHit ||
              `${p.label} ${p.id} ${p.text} ${p.path}`.toLowerCase().includes(q),
          );
          return prompts.length ? { ...v, prompts } : null;
        })
        .filter((v): v is PlanVariation => v != null);
      return variations.length ? { ...ad, variations } : null;
    })
    .filter((ad): ad is PlanAd => ad != null);

  return { ads };
}
