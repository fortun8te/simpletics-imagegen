#!/usr/bin/env node
// trendtrack-smoke.mjs — Phase 0.5 end-to-end smoke test for the TrendTrack wiring.
//
//   node scripts/trendtrack-smoke.mjs [brand]     (default brand: gymshark)
//
// Steps (BRIEF.md):
//   1. usage check          — 0 credits
//   2. brand lookup         — metered
//   3. fetch top 10 ads     — ≤ 10 credits, cached to disk + images downloaded
//   4. cache re-read        — 0 credits (no network; verified by balance delta)
//   5. total spent          — MUST be < 50 or the script exits 1
//
// Exits 2 with instructions when TRENDTRACK_API_KEY isn't set (studio/.env) — the wiring is
// still considered installed; the metered steps just can't run without a key.
import * as tt from '../studio/lib/trendtrack.mjs';
import * as cache from '../studio/lib/trendtrack-cache.mjs';

const brand = (process.argv[2] || 'gymshark').toLowerCase();
const MAX_SPEND = 50;

function fail(msg, code = 1) {
  console.error(`\n✗ ${msg}`);
  process.exit(code);
}

if (!tt.hasKey()) {
  console.error('✗ TRENDTRACK_API_KEY is not set.');
  console.error('  Add it to studio/.env (gitignored):  TRENDTRACK_API_KEY=tt_...');
  console.error('  Then re-run:  node scripts/trendtrack-smoke.mjs');
  process.exit(2);
}

// 1 — usage (free)
const before = await tt.getUsage();
if (before.remaining == null) fail('usage endpoint returned no balance');
console.log(`1. usage ok — ${before.remaining} credits remaining (cost: 0)`);

// 2 — lookup (zero-credit resolution; the endpoint 500s server-side sometimes — non-fatal)
try {
  const found = await tt.lookup(brand);
  console.log(`2. lookup(${brand}) ok — ${JSON.stringify(found).slice(0, 120)}…`);
} catch (e) {
  console.log(`2. lookup(${brand}) unavailable (${e.code || e.message}) — zero-credit endpoint, continuing`);
}

// 3 — top 10 ads (metered, ≤10 credits) → cache + images
const r = await tt.queryAds(
  { search: [brand], searchType: 'brand', status: 'active', sortBy: 'reach', order: 'desc' },
  { limit: 10 },
);
const rows = r?.data || [];
if (!rows.length) fail(`query returned 0 ads for "${brand}" — try another brand`);
const records = cache.cacheBrand(brand, rows);
let images = 0;
for (const rec of records) if (await cache.downloadImage(rec.id, rec.image_url)) images++;
console.log(`3. fetched ${records.length} ads → cached ${records.length} records, ${images} images on disk`);

// 4 — cache read (0 credits — pure disk, no client call)
const midCredits = tt.lastKnownCredits();
const hit = cache.getCachedBrand(brand);
if (!hit || !hit.ads.length) fail('cache read returned nothing after import');
if (tt.lastKnownCredits() !== midCredits) fail('cache read consumed credits — it must be disk-only');
console.log(`4. cache read ok — ${hit.ads.length} ads from disk, 0 credits`);

// 5 — total spend
const after = await tt.getUsage();
const spent = (before.remaining ?? 0) - (after.remaining ?? 0);
console.log(`5. total credits consumed: ${spent} (budget: < ${MAX_SPEND})`);
if (spent >= MAX_SPEND) fail(`smoke test burned ${spent} credits — over the ${MAX_SPEND} budget`);

console.log(`\n✓ smoke passed — ${after.remaining} credits remaining, ${cache.cachedAdCount()} ads cached total`);
