#!/usr/bin/env node
// scripts/fetch-vtracer.mjs — download the vtracer CLI binary to .state/bin/vtracer.
//
// vtracer (visioncortex, MIT/Apache-2.0) is our first-line raster→vector engine for
// icons/badges/logos (COPY-ENGINE-V2 Phase 2 "icon/element vectorization"). Its stacking
// mode emits hole-free stacked color paths that map 1:1 onto Figma VECTOR layers.
// lib/vectorize.mjs prefers this binary when present and degrades to imagetracerjs when
// it is not — so this script failing is never fatal to the pipeline.
//
// Usage:  node scripts/fetch-vtracer.mjs [--force]
// Resolves the latest GitHub release via the API, picks the asset for this platform/arch
// (darwin-arm64 → vtracer-aarch64-apple-darwin.tar.gz), extracts the single `vtracer`
// binary, chmod +x, and verifies by running `--version`. Exit 0 on success, 1 on failure
// (offline / no matching asset / broken binary) with a plain-English report.

import { mkdirSync, existsSync, statSync, chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_DIR = join(__dirname, '..', '.state', 'bin');
const BIN_PATH = join(BIN_DIR, 'vtracer');
const RELEASES_API = 'https://api.github.com/repos/visioncortex/vtracer/releases/latest';

/** Map process.platform/arch to the release asset's rust target-triple substring. */
function assetTriple() {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (platform === 'linux') return arch === 'arm64' ? 'aarch64-unknown-linux' : 'x86_64-unknown-linux';
  return null; // windows zip layout unsupported here
}

/** Run the binary and return its --version line, or throw. */
function verify(path) {
  const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (r.error) throw new Error(`spawn failed: ${r.error.message}`);
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0 || !/vtracer/i.test(out)) throw new Error(`--version exited ${r.status}: ${out || '(no output)'}`);
  return out;
}

const force = process.argv.includes('--force');
mkdirSync(BIN_DIR, { recursive: true });

if (!force && existsSync(BIN_PATH) && statSync(BIN_PATH).size > 1e5) {
  try {
    console.log(`vtracer already present — ${verify(BIN_PATH)} (use --force to re-download)`);
    process.exit(0);
  } catch (e) {
    console.log(`existing binary failed verification (${e.message}) — re-downloading`);
  }
}

try {
  const triple = assetTriple();
  if (!triple) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);

  console.log(`querying ${RELEASES_API}`);
  const res = await fetch(RELEASES_API, {
    redirect: 'follow',
    headers: { 'user-agent': 'neuegen-fetch-vtracer', accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const release = await res.json();
  const asset = (release.assets || []).find((a) => a.name.includes(triple) && a.name.endsWith('.tar.gz'));
  if (!asset) {
    throw new Error(`release ${release.tag_name} has no .tar.gz asset for ${triple} ` +
      `(assets: ${(release.assets || []).map((a) => a.name).join(', ') || 'none'})`);
  }

  console.log(`downloading ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB, release ${release.tag_name})`);
  const dl = await fetch(asset.browser_download_url, { redirect: 'follow' });
  if (!dl.ok) throw new Error(`asset download HTTP ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.length < 1e5) throw new Error(`downloaded file suspiciously small (${buf.length} bytes)`);

  // Extract the single `vtracer` entry from the tarball into .state/bin/ via system tar
  // (node has no builtin tar; bsdtar ships with macOS and every linux we target).
  const tarPath = join(BIN_DIR, `${asset.name}.tmp`);
  writeFileSync(tarPath, buf);
  try {
    if (existsSync(BIN_PATH)) rmSync(BIN_PATH);
    const tar = spawnSync('tar', ['-xzf', tarPath, '-C', BIN_DIR], { encoding: 'utf8', timeout: 30000 });
    if (tar.status !== 0) throw new Error(`tar extract failed: ${tar.stderr || tar.error?.message}`);
    if (!existsSync(BIN_PATH)) {
      // some releases nest the binary in a directory — find it and hoist
      const find = spawnSync('find', [BIN_DIR, '-name', 'vtracer', '-type', 'f'], { encoding: 'utf8' });
      const found = (find.stdout || '').split('\n').filter(Boolean)[0];
      if (!found) throw new Error('tarball did not contain a `vtracer` binary');
      renameSync(found, BIN_PATH);
    }
  } finally {
    try { rmSync(tarPath); } catch { /* best effort */ }
  }

  chmodSync(BIN_PATH, 0o755);
  console.log(`verified — ${verify(BIN_PATH)}`);
  console.log(`OK → ${BIN_PATH}`);
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
  console.error('lib/vectorize.mjs will degrade to the imagetracerjs fallback engine.');
  process.exit(1);
}
