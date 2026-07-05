// trendtrack-cache.mjs — local disk cache for TrendTrack ads (studio/.state/trendtrack-cache/).
//
// TrendTrack is INGESTION, not runtime UI: every metered fetch lands here once and all Plan /
// UI reads come from disk at 0 credits. Image URLs from the API expire, so images are copied
// locally at import time.
//
// Layout:
//   .state/trendtrack-cache/index.json     { brands: { [brand]: { adIds: [], fetchedAt } } }
//   .state/trendtrack-cache/ads/{id}.json  normalized ad record (schema below)
//   .state/trendtrack-cache/images/{id}.jpg
//
// Record schema (BRIEF.md): id, brand, hook, angle, format, platform, scaling_verdict,
// local_image, fetched_at — plus source_url/primary_text/media_type/tags/credits_paid and the
// untouched upstream payload under `raw` (the API's exact field names may drift; keep everything).
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(STUDIO, '.state', 'trendtrack-cache');
const ADS = join(CACHE, 'ads');
const IMAGES = join(CACHE, 'images');
const INDEX = join(CACHE, 'index.json');
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d — re-import a brand after this

function ensureDirs() {
  for (const d of [CACHE, ADS, IMAGES]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

const safeId = (id) => String(id || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');

function readIndex() {
  try { return JSON.parse(readFileSync(INDEX, 'utf8')); } catch { return { brands: {} }; }
}
function writeIndex(index) {
  ensureDirs();
  writeFileSync(INDEX, JSON.stringify(index, null, 2));
}

// Pick the first present field from a list of candidate upstream names.
const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};

/** Normalize one upstream ad row into the cache record schema.
 *  Written against the REAL /v1/ads/query row shape (verified live):
 *  { id, platform, status, daysRunning, media: { type, thumbnailUrl, mediaUrl },
 *    advertiser: { name, ... }, content: { title, body, callToAction, landingPageUrl },
 *    metrics: { reach, estimatedSpend, reachDelta1d/7d/30d }, audience, rank, flags }.
 *  The full row is preserved under `raw` — never lose upstream data. */
export function normalizeAd(rawAd, brand) {
  const id = safeId(pick(rawAd, 'id', 'ad_id') || `ad-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const media = rawAd?.media || {};
  const content = rawAd?.content || {};
  const metrics = rawAd?.metrics || {};
  const body = content.body || null;
  // Hook = title when present, else the first sentence/line of the body copy.
  const hook = content.title
    || (body ? String(body).split(/[\n.!?]/)[0].trim().slice(0, 140) : null);
  // Honest scaling heuristic from the metrics we actually get (no upstream verdict field):
  // still growing after 3+ weeks = scaling; a month+ of spend = proven; else testing.
  const days = Number(rawAd?.daysRunning) || 0;
  const growing = (Number(metrics.reachDelta7d) || 0) > 0 || (Number(metrics.reachDelta30d) || 0) > 0;
  const scaling_verdict = days >= 21 && growing ? 'scaling' : days >= 30 ? 'proven' : 'testing';
  return {
    id,
    brand: String(brand || rawAd?.advertiser?.name || '').toLowerCase(),
    source_url: content.landingPageUrl || null,
    hook,
    angle: null,                    // filled by the Plan agent later (Phase 1)
    primary_text: body,
    format: media.type || null,
    aspect: null,
    platform: rawAd?.platform || null,
    media_type: media.type || null,
    scaling_verdict,
    image_url: media.thumbnailUrl || media.mediaUrl || null,
    local_image: null,              // set by downloadImage()
    tags: [rawAd?.platform, media.type, scaling_verdict].filter(Boolean),
    reach: metrics.reach ?? null,
    days_running: days || null,
    cta: content.callToAction || null,
    advertiser: rawAd?.advertiser?.name || null,
    fetched_at: Date.now(),
    credits_paid: 1,
    raw: rawAd,
  };
}

/** Write a brand's normalized ads to disk + update the index. Returns the stored records. */
export function cacheBrand(brand, ads) {
  ensureDirs();
  const key = String(brand || '').toLowerCase();
  const records = (ads || []).map((a) => normalizeAd(a, key));
  for (const rec of records) {
    writeFileSync(join(ADS, `${rec.id}.json`), JSON.stringify(rec, null, 2));
  }
  const index = readIndex();
  const prior = index.brands[key]?.adIds || [];
  index.brands[key] = {
    adIds: [...new Set([...prior, ...records.map((r) => r.id)])],
    fetchedAt: Date.now(),
  };
  writeIndex(index);
  return records;
}

/** Read one cached ad record (0 credits). */
export function getAd(id) {
  const p = join(ADS, `${safeId(id)}.json`);
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** Read a brand's cached ads (0 credits). Returns null when missing or older than the 7d TTL —
 *  callers treat null as "needs a fresh metered import". */
export function getCachedBrand(brand, { ttlMs = TTL_MS } = {}) {
  const key = String(brand || '').toLowerCase();
  const entry = readIndex().brands[key];
  if (!entry) return null;
  if (Date.now() - (entry.fetchedAt || 0) > ttlMs) return null;
  const ads = entry.adIds.map(getAd).filter(Boolean);
  return { brand: key, fetchedAt: entry.fetchedAt, ads };
}

/** All cached brands with counts + freshness (0 credits). */
export function listBrands() {
  const index = readIndex();
  return Object.entries(index.brands).map(([brand, e]) => ({
    brand,
    count: e.adIds.length,
    fetchedAt: e.fetchedAt,
    stale: Date.now() - (e.fetchedAt || 0) > TTL_MS,
  }));
}

/** Absolute path of a cached image, or null. */
export function imagePath(id) {
  const p = join(IMAGES, `${safeId(id)}.jpg`);
  return existsSync(p) ? p : null;
}

/** Download an ad's creative to images/{id}.jpg (URLs expire — copy at import time).
 *  No-op when already present. Updates the ad record's local_image on success. */
export async function downloadImage(id, url) {
  ensureDirs();
  const clean = safeId(id);
  const dest = join(IMAGES, `${clean}.jpg`);
  if (existsSync(dest)) return `images/${clean}.jpg`;
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    const rec = getAd(clean);
    if (rec) {
      rec.local_image = `images/${clean}.jpg`;
      writeFileSync(join(ADS, `${clean}.json`), JSON.stringify(rec, null, 2));
    }
    return `images/${clean}.jpg`;
  } catch {
    return null; // image fetch failures never fail an import — record stays usable without it
  }
}

/** Stamp an extracted layout's skeleton id onto a cached ad record — extraction runs once
 *  per reference; every later "copy this ad's design" is a free disk read. */
export function attachLayout(id, layoutId) {
  const rec = getAd(id);
  if (!rec) return null;
  rec.layoutId = layoutId;
  writeFileSync(join(ADS, `${safeId(id)}.json`), JSON.stringify(rec, null, 2));
  return rec;
}

/** Count of ad json files on disk (smoke-test sanity). */
/** FREE local search across the whole disk cache (0 credits): token match on brand, hook,
 *  primary_text, advertiser; ranked by hit count with a scaling-verdict boost. */
export function searchCache(q, { limit = 60 } = {}) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  ensureDirs();
  for (const f of readdirSync(ADS)) {
    if (!f.endsWith('.json')) continue;
    let ad;
    try { ad = JSON.parse(readFileSync(join(ADS, f), 'utf8')); } catch { continue; }
    const hay = `${ad.brand || ''} ${ad.advertiser || ''} ${ad.hook || ''} ${ad.primary_text || ''}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += 1;
    if (terms.length && score === 0) continue;
    if (ad.scaling_verdict === 'scaling') score += 0.6;
    else if (ad.scaling_verdict === 'proven') score += 0.3;
    out.push({ ad, score });
  }
  out.sort((a, b) => b.score - a.score || (b.ad.fetched_at || 0) - (a.ad.fetched_at || 0));
  return out.slice(0, limit).map((x) => x.ad);
}
