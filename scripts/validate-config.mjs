#!/usr/bin/env node
// scripts/validate-config.mjs — read-only sanity checker for config.json.
// Zero external deps (node:* only). Never writes anything.
//
// Walks brands[] -> batches[] -> ads[] -> variations[] -> prompts[] (the real nested shape, per
// studio/studio-server.mjs `promptEntries()` and the live config.json) and checks each prompt
// entry. Errors fail the run (exit 1); warnings are reported but do not fail it.
//
// Usage:
//   node scripts/validate-config.mjs [--help]
//
// Checks per prompt entry (errors):
//   - `id` present and non-empty
//   - `prompt` is a string
//   - `prompt` non-empty
//   - `prompt.length > 40`
//   - `prompt` does not contain literal "TODO", "PLACEHOLDER", or "<<"
//
// Brand-specific check (warning only) for brand id "nanox":
//   - loose case-insensitive keyword check that the prompt mentions at least one of the UGC
//     phone-photo cues real nanox prompts actually use (see KEYWORD list below). If none match,
//     a WARNING is emitted (this does not fail validation).
//
// Exit code: 0 if zero errors across the whole config (warnings are fine), 1 if any errors.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(HERE, '..', 'config.json');

const HELP = `validate-config.mjs — read-only validator for config.json prompt entries.

Usage:
  node scripts/validate-config.mjs [--help]

What it checks (per prompt entry, under brands[].batches[].ads[].variations[].prompts[]):
  Errors (fail the run):
    - id present and non-empty
    - prompt is a string, non-empty, length > 40
    - prompt does not contain "TODO", "PLACEHOLDER", or "<<"
  Warnings (brand id "nanox" only, do not fail the run):
    - prompt should mention at least one UGC phone-photo keyword (pov, phone photo, selfie,
      over-shoulder, over the shoulder, framing, candid, front-facing, handheld)

Exit code: 0 if zero errors (warnings allowed), 1 if any errors.
This script never modifies config.json.
`;

const NANOX_KEYWORDS = [
  'pov',
  'phone photo',
  'selfie',
  'over-shoulder',
  'over the shoulder',
  'framing',
  'candid',
  'front-facing',
  'handheld',
];

const BAD_SUBSTRINGS = ['TODO', 'PLACEHOLDER', '<<'];

function parseArgs(argv) {
  return { help: argv.includes('--help') || argv.includes('-h') };
}

function checkPromptEntry(entry, ctx, report) {
  const where = `brand=${ctx.brand} batch=${ctx.batch} ad=${ctx.ad} variation=${ctx.variation} prompt=${entry && entry.id != null ? entry.id : '(no id)'}`;
  report.checked++;

  if (!entry || typeof entry.id !== 'string' || entry.id.trim() === '') {
    report.errors.push(`ERROR [${where}]: missing or empty "id"`);
  }

  if (!entry || typeof entry.prompt !== 'string') {
    report.errors.push(`ERROR [${where}]: "prompt" is not a string`);
    return; // remaining checks need a string
  }

  const text = entry.prompt;

  if (text.length === 0) {
    report.errors.push(`ERROR [${where}]: "prompt" is empty`);
  }

  if (text.length <= 40) {
    report.errors.push(`ERROR [${where}]: "prompt" length (${text.length}) is not > 40`);
  }

  for (const bad of BAD_SUBSTRINGS) {
    if (text.includes(bad)) {
      report.errors.push(`ERROR [${where}]: "prompt" contains literal "${bad}"`);
    }
  }

  if (ctx.brand === 'nanox') {
    const lower = text.toLowerCase();
    const matched = NANOX_KEYWORDS.some((kw) => lower.includes(kw));
    if (!matched) {
      report.warnings.push(`WARNING [${where}]: nanox prompt does not mention any expected UGC phone-photo keyword (${NANOX_KEYWORDS.join(', ')})`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (!existsSync(CONFIG_PATH)) {
    console.error(`ERROR: config.json not found at ${CONFIG_PATH}`);
    process.exit(1);
  }

  let config;
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: failed to parse config.json as JSON: ${err.message}`);
    process.exit(1);
  }

  const brands = Array.isArray(config.brands) ? config.brands : [];
  if (brands.length === 0) {
    console.error('ERROR: config.json has no "brands" array (or it is empty).');
    process.exit(1);
  }

  let totalChecked = 0;
  let totalErrors = 0;
  let totalWarnings = 0;
  let totalBrands = 0;
  let totalBatches = 0;

  for (const brand of brands) {
    totalBrands++;
    console.log(`\n=== Brand: ${brand.id} ===`);
    const batches = Array.isArray(brand.batches) ? brand.batches : [];
    for (const batch of batches) {
      totalBatches++;
      const report = { checked: 0, errors: [], warnings: [] };
      const ads = Array.isArray(batch.ads) ? batch.ads : [];
      for (const ad of ads) {
        const variations = Array.isArray(ad.variations) ? ad.variations : [];
        for (const variation of variations) {
          const prompts = Array.isArray(variation.prompts) ? variation.prompts : [];
          const ctx = { brand: brand.id, batch: batch.code, ad: ad.id, variation: variation.id };
          for (const entry of prompts) {
            checkPromptEntry(entry, ctx, report);
          }
        }
      }

      console.log(`  Batch ${batch.code}: checked=${report.checked} errors=${report.errors.length} warnings=${report.warnings.length}`);
      for (const e of report.errors) console.log(`    ${e}`);
      for (const w of report.warnings) console.log(`    ${w}`);

      totalChecked += report.checked;
      totalErrors += report.errors.length;
      totalWarnings += report.warnings.length;
    }
  }

  console.log(`\n=== Totals ===`);
  console.log(`brands=${totalBrands} batches=${totalBatches} prompts_checked=${totalChecked} errors=${totalErrors} warnings=${totalWarnings}`);

  if (totalErrors > 0) {
    console.log(`\nFAIL: ${totalErrors} error(s) found.`);
    process.exit(1);
  }
  console.log('\nPASS: no errors.');
  process.exit(0);
}

main();
