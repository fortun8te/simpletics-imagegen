#!/usr/bin/env node
// scripts/fetch-migan.mjs — download the MI-GAN inpainting ONNX model to .state/models/migan.onnx.
//
// MI-GAN (Picsart AI Research, ICCV 2023, MIT license) is our first-line photo-hole inpainter
// (COPY-ENGINE-V2 §3.4 S9). The repo's README links the official pre-converted "pipeline v2"
// ONNX on the first author's HF account — that file bundles ALL pre/post-processing inside the
// graph (uint8 RGB in, crop-around-mask, resize to 512, blend, resize back, uint8 out), so the
// runtime code in lib/inpaint.mjs stays trivial. Sources are tried in order; later entries are
// community mirrors of the same export kept as redundancy.
//
// Usage:  node scripts/fetch-migan.mjs [--force]
// After download the model is verified by actually creating an onnxruntime-node session and
// printing input/output tensor names + shapes. Exit 0 on success, 1 when every source failed.
// Callers (lib/inpaint.mjs) degrade to the deterministic patch fill when the file is absent.

import { mkdirSync, existsSync, statSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(__dirname, '..', '.state', 'models');
const MODEL_PATH = join(MODELS_DIR, 'migan.onnx');
const MIN_SIZE = 5e6; // the pipeline export is ~28MB; anything tiny is an error page

// Tried in order. `kind` is informational — lib/inpaint.mjs sniffs the actual tensor shapes.
const SOURCES = [
  { // official (linked from github.com/Picsart-AI-Research/MI-GAN README "For Developers")
    url: 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
    kind: 'pipeline-v2 (full image + mask, dynamic size, uint8)',
  },
  { // community mirror of the same pipeline export
    url: 'https://huggingface.co/anyisalin/migan-onnx/resolve/main/onnx/migan_pipeline.onnx',
    kind: 'pipeline (mirror)',
  },
  { // raw 512×512 model (no baked pre/post) — lib/inpaint.mjs handles it via crop+resize
    url: 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan.onnx',
    kind: 'migan-512 raw',
  },
];

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < MIN_SIZE) throw new Error(`too small (${buf.length} bytes) — not a model file`);
  writeFileSync(`${dest}.tmp`, buf);
  renameSync(`${dest}.tmp`, dest);
  return buf.length;
}

/** Create a real ORT session and print the tensor signature — the only trustworthy check. */
async function verify(path) {
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(path);
  const fmt = (metaList) => metaList.map((m) => `${m.name}: ${m.type}[${(m.shape || []).join(',')}]`).join('  ');
  console.log(`  inputs:  ${fmt(session.inputMetadata ?? [])}`);
  console.log(`  outputs: ${fmt(session.outputMetadata ?? [])}`);
  const names = session.inputNames;
  if (!names.includes('image') || !names.includes('mask')) {
    throw new Error(`unexpected inputs [${names.join(', ')}] — expected "image" and "mask"`);
  }
  return true;
}

const force = process.argv.includes('--force');
mkdirSync(MODELS_DIR, { recursive: true });

if (!force && existsSync(MODEL_PATH) && statSync(MODEL_PATH).size > MIN_SIZE) {
  console.log(`migan.onnx already present (${(statSync(MODEL_PATH).size / 1e6).toFixed(1)} MB) — verifying (use --force to re-download)`);
  try { await verify(MODEL_PATH); console.log('OK'); process.exit(0); }
  catch (e) { console.log(`existing file failed verification (${e.message}) — re-downloading`); }
}

let done = false;
for (const src of SOURCES) {
  process.stdout.write(`fetching ${src.kind}\n  ${src.url}\n`);
  try {
    const bytes = await download(src.url, MODEL_PATH);
    console.log(`  downloaded ${(bytes / 1e6).toFixed(1)} MB — verifying with onnxruntime-node`);
    await verify(MODEL_PATH);
    console.log(`OK → ${MODEL_PATH}`);
    done = true;
    break;
  } catch (e) {
    console.log(`  FAILED: ${e.message}`);
    try { if (existsSync(`${MODEL_PATH}.tmp`)) unlinkSync(`${MODEL_PATH}.tmp`); } catch { /* best effort */ }
  }
}

if (!done) {
  console.error('\nAll sources failed. lib/inpaint.mjs will degrade to the deterministic patch fill.');
  process.exit(1);
}
