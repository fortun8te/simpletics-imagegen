#!/usr/bin/env node
// scripts/recompile-prompts.mjs — v1 generic JSON-patch applier for config.json prompt entries.
// Zero external deps (node:* only).
//
// WHAT THIS IS (v1):
//   The most honest first version of "recompile prompts": it does NOT know anything about
//   reusable prompt "blocks" or how a compiled prompt string was assembled. It just applies a
//   patch file you hand it. The patch file says, for each prompt id, what the new `prompt`
//   string (and optionally `recipe`) should be. This script finds that prompt entry inside
//   config.json's brands -> batches -> ads -> variations -> prompts[] tree and updates it.
//
// HOW A FUTURE BLOCK-LIBRARY TOOL PLUGS IN (item 2, owned by a separate agent working on
// ~/.claude/skills/nanox-batch):
//   That tool is expected to own a shared block-library file (e.g. reusable named text
//   fragments like "candid-phone-selfie-style" or "no-text-no-graphics-output-rule") and know
//   how to recompile a prompt's `recipe.blocks` (see src/types.ts PromptRecipe) into a new full
//   `prompt` string whenever a block version changes. The intended flow is:
//     1. The block-library tool recompiles whichever prompts reference the changed block(s).
//     2. It writes the results out as a patch JSON in the exact shape this script expects
//        (see --help below), with `recipe.compiledAt` set to an ISO timestamp.
//     3. It invokes this script with `--patch <that-file> --apply` to land the change.
//   This keeps "what changed and why" (block recompilation logic) decoupled from "how config.json
//   gets safely rewritten" (this script's job: find-by-id, dry-run preview, atomic backup+replace).
//
//   ALTERNATIVE NOT IMPLEMENTED IN v1: a `--block name=value` mode that does a literal-substring
//   replace, scoped only to prompts whose `recipe.blocks[name]` is already set (so we know the
//   prompt was built from that block and a substring match is safe). This is deliberately left
//   unimplemented here because there is no shared block-library file yet to define block names/
//   values or substring boundaries; building it now would be guessing at a contract that doesn't
//   exist. Once item 2 lands, add a `--block` flag to this script (or a new one) that walks the
//   same id-index built below, filters to prompts with a matching `recipe.blocks[name]`, and does
//   a targeted String.replace on the old block value -> new value within `prompt`.
//
// USAGE:
//   node scripts/recompile-prompts.mjs --patch <file.json> [--dry-run | --apply] [--help]
//
// FLAGS:
//   --patch <file>   Required. Path to a patch JSON file (see PATCH FILE SHAPE below).
//   --dry-run        Default behavior. Prints a summary of what WOULD change. No writes.
//   --apply          Actually writes the changes to config.json (atomic, with a timestamped
//                    backup made first). Mutually exclusive in effect with --dry-run; if both
//                    are passed, --apply wins.
//   --help           Print this usage and exit 0.
//
// PATCH FILE SHAPE:
//   {
//     "prompts": [
//       {
//         "id": "p1",
//         "prompt": "<new compiled string>",
//         "recipe": { "blocks": { "blockName": "blockValue" }, "compiledAt": "2026-06-30T00:00:00.000Z" }
//       }
//     ]
//   }
//   - "id" is required and must match an existing prompt id somewhere in config.json's
//     brands[].batches[].ads[].variations[].prompts[].
//   - "prompt" is required: the new compiled string to write.
//   - "recipe" is optional. If present it is written verbatim onto the prompt entry's `recipe`
//     field (see src/types.ts PromptRecipe: { blocks: Record<string,string>, compiledAt: string|null }).
//
// SAFETY (--apply mode only):
//   1. Back up config.json to config.json.bak-<ISO-timestamp-with-no-colons> BEFORE touching it.
//   2. Write the new JSON to a temp file (config.json.tmp-<pid>), JSON.parse it back to validate
//      it really is valid JSON, then fs.renameSync the temp file onto config.json (atomic on
//      POSIX — no partially-written config.json is ever visible).
//
// Unknown patch ids are warned about and skipped — this script never crashes on a bad id, it
// just tells you and moves on.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(HERE, '..', 'config.json');

const HELP = `recompile-prompts.mjs — v1 JSON-patch applier for config.json prompt entries.

Usage:
  node scripts/recompile-prompts.mjs --patch <file.json> [--dry-run | --apply] [--help]

Flags:
  --patch <file>   Required. Path to a patch JSON file (see below).
  --dry-run        Default. Print a summary of what would change. No writes.
  --apply          Actually write the changes (atomic, with a timestamped backup first).
  --help           Print this message and exit.

Patch file shape:
  {
    "prompts": [
      { "id": "p1",
        "prompt": "<new compiled string>",
        "recipe": { "blocks": { "blockName": "blockValue" }, "compiledAt": "2026-06-30T00:00:00.000Z" }
      }
    ]
  }
  - "id" must match an existing prompt id under config.json's
    brands[].batches[].ads[].variations[].prompts[].
  - "prompt" (required): new compiled string to write onto that entry's "prompt" field.
  - "recipe" (optional): written verbatim onto the entry's "recipe" field if present.

v1 is a generic patch-applier only. It does not know how a prompt string was assembled from
reusable blocks — that is the job of a future block-library tool (see header comment in this
file for the intended handoff). Unknown ids in the patch are warned about and skipped.
`;

function parseArgs(argv) {
  const out = { patch: null, apply: false, dryRun: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--patch') out.patch = argv[++i];
    else if (a === '--apply') { out.apply = true; out.dryRun = false; }
    else if (a === '--dry-run') out.dryRun = true;
  }
  if (out.apply) out.dryRun = false;
  return out;
}

// Walk config.json's nested shape (brands -> batches -> ads -> variations -> prompts) and build
// id -> prompt-entry index. Mutates-in-place friendly: returns live references into `config`.
function buildPromptIndex(config) {
  const index = new Map(); // id -> { entry, brand, batch, ad, variation }
  const brands = Array.isArray(config.brands) ? config.brands : [];
  for (const brand of brands) {
    const batches = Array.isArray(brand.batches) ? brand.batches : [];
    for (const batch of batches) {
      const ads = Array.isArray(batch.ads) ? batch.ads : [];
      for (const ad of ads) {
        const variations = Array.isArray(ad.variations) ? ad.variations : [];
        for (const variation of variations) {
          const prompts = Array.isArray(variation.prompts) ? variation.prompts : [];
          for (const entry of prompts) {
            if (!entry || typeof entry.id !== 'string') continue;
            if (index.has(entry.id)) {
              console.warn(`WARNING: duplicate prompt id "${entry.id}" found (brand=${brand.id} batch=${batch.code} ad=${ad.id} variation=${variation.id}); patch will target the LAST one encountered in the index unless overwritten again.`);
            }
            index.set(entry.id, { entry, brand: brand.id, batch: batch.code, ad: ad.id, variation: variation.id });
          }
        }
      }
    }
  }
  return index;
}

function summarizePrefix(s, n = 60) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function isoStampNoColons() {
  return new Date().toISOString().replace(/:/g, '');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (!args.patch) {
    console.error('ERROR: --patch <file.json> is required. Run with --help for usage.');
    process.exit(1);
  }

  const patchPath = resolve(process.cwd(), args.patch);
  if (!existsSync(patchPath)) {
    console.error(`ERROR: patch file not found: ${patchPath}`);
    process.exit(1);
  }

  let patch;
  try {
    patch = JSON.parse(readFileSync(patchPath, 'utf8'));
  } catch (err) {
    console.error(`ERROR: failed to parse patch file as JSON: ${err.message}`);
    process.exit(1);
  }

  const patchPrompts = Array.isArray(patch.prompts) ? patch.prompts : [];
  if (patchPrompts.length === 0) {
    console.error('ERROR: patch file has no "prompts" array (or it is empty). Nothing to do.');
    process.exit(1);
  }

  if (!existsSync(CONFIG_PATH)) {
    console.error(`ERROR: config.json not found at ${CONFIG_PATH}`);
    process.exit(1);
  }

  let configRaw;
  let config;
  try {
    configRaw = readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(configRaw);
  } catch (err) {
    console.error(`ERROR: failed to parse config.json: ${err.message}`);
    process.exit(1);
  }

  const index = buildPromptIndex(config);

  const mode = args.apply ? 'APPLY' : 'DRY-RUN';
  console.log(`recompile-prompts.mjs — mode=${mode}, patch=${patchPath}, prompts in patch=${patchPrompts.length}`);
  console.log('');

  let changed = 0;
  let skipped = 0;

  for (const p of patchPrompts) {
    if (!p || typeof p.id !== 'string' || !p.id) {
      console.warn('WARNING: skipping patch entry with missing/invalid "id":', JSON.stringify(p));
      skipped++;
      continue;
    }
    const hit = index.get(p.id);
    if (!hit) {
      console.warn(`WARNING: prompt id "${p.id}" not found in config.json; skipping.`);
      skipped++;
      continue;
    }
    if (typeof p.prompt !== 'string' || !p.prompt) {
      console.warn(`WARNING: patch entry for id "${p.id}" has no usable "prompt" string; skipping.`);
      skipped++;
      continue;
    }

    const { entry, brand, batch, ad, variation } = hit;
    const oldPrefix = summarizePrefix(entry.prompt);
    const newPrefix = summarizePrefix(p.prompt);
    const recipeChange = p.recipe
      ? `recipe.blocks=${JSON.stringify(p.recipe.blocks || {})} compiledAt=${p.recipe.compiledAt ?? null}`
      : '(recipe unchanged)';

    console.log(`[${entry.id}] brand=${brand} batch=${batch} ad=${ad} variation=${variation}`);
    console.log(`  old prompt: "${oldPrefix}"`);
    console.log(`  new prompt: "${newPrefix}"`);
    console.log(`  ${recipeChange}`);
    console.log('');

    if (args.apply) {
      entry.prompt = p.prompt;
      if (p.recipe) entry.recipe = p.recipe;
    }
    changed++;
  }

  console.log(`Summary: ${changed} prompt(s) ${args.apply ? 'updated' : 'would be updated'}, ${skipped} skipped.`);

  if (!args.apply) {
    console.log('\nDry-run only — no files were written. Re-run with --apply to write changes.');
    process.exit(0);
  }

  if (changed === 0) {
    console.log('\nNothing to apply (0 prompts matched). config.json left untouched.');
    process.exit(0);
  }

  // Safety: back up original file, write to temp, validate by re-parsing, then atomic rename.
  const backupPath = `${CONFIG_PATH}.bak-${isoStampNoColons()}`;
  writeFileSync(backupPath, configRaw, 'utf8');
  console.log(`Backed up original config.json to ${backupPath}`);

  const tmpPath = `${CONFIG_PATH}.tmp-${process.pid}`;
  const newJson = JSON.stringify(config, null, 2) + '\n';
  writeFileSync(tmpPath, newJson, 'utf8');

  // Validate: re-read and re-parse the temp file before swapping it in.
  const validated = JSON.parse(readFileSync(tmpPath, 'utf8'));
  if (!validated || !Array.isArray(validated.brands)) {
    console.error('ERROR: post-write validation failed (unexpected shape); aborting before rename.');
    process.exit(1);
  }

  renameSync(tmpPath, CONFIG_PATH);
  console.log(`Wrote ${changed} change(s) to ${CONFIG_PATH} (atomic replace).`);
}

main();
