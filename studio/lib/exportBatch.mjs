// Batch zip export — walks RENDERS for a brand/batch, folders per ad → variation → prompt.
import { existsSync, readdirSync, statSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const part = (v) => String(v || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');

function sanitize(value, max = 48) {
  return (
    String(value || '')
      .trim()
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, max) || 'x'
  );
}

function buildName(relPath, opts = {}) {
  const clean = String(relPath || '').replace(/^\/+/, '');
  const parts = clean.split('/');
  if (parts.length < 7 || parts[2] !== 'ads') return sanitize(parts[parts.length - 1] || 'image', 80) + '.png';
  const [, , , ad, variation, prompt] = parts;
  const m = /^run-(\d+)(?:-v(\d+))?\.png$/i.exec(parts[parts.length - 1] ?? '');
  if (!m) return sanitize(parts[parts.length - 1] || 'image', 80);
  const revision = m[2] ? Number(m[2]) : 1;
  const segs = [
    sanitize(opts.adTitle || ad),
    sanitize(variation),
    sanitize(prompt),
    `run${m[1]}`,
  ];
  if (revision > 1) segs.push(`v${revision}`);
  return `${segs.join('-')}.png`;
}

/** Collect exportable PNG entries for a batch. */
export function collectBatchFiles({ renders, brand, batch, config, store, includeArchived = false }) {
  const brandCfg = config?.brands?.find((b) => b.id === brand);
  const batchCfg = brandCfg?.batches?.find((b) => b.code === batch);
  const batchLabel = sanitize(batchCfg?.name || batch, 32);
  const root = join(renders, part(brand), part(batch));
  const files = [];

  const walk = (dir, relBase) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, relBase ? `${relBase}/${e.name}` : e.name);
        continue;
      }
      if (!/^run-.*\.png$/i.test(e.name)) continue;
      const relPath = relBase ? `${relBase}/${e.name}` : e.name;
      if (store?.isArchived?.(relPath) && !includeArchived) continue;
      const coords = relPath.split('/');
      const adId = coords[2] === 'ads' ? coords[3] : coords[1];
      const adCfg = batchCfg?.ads?.find((a) => a.id === adId);
      const zipPath = [
        batchLabel,
        `${sanitize(adId)}_${sanitize(adCfg?.title || adId, 36)}`,
        sanitize(coords[coords.length - 3] || 'variation'),
        sanitize(coords[coords.length - 2] || 'prompt'),
        buildName(relPath, { adTitle: adCfg?.title }),
      ].join('/');
      files.push({ absPath: full, zipPath, relPath });
    }
  };

  if (existsSync(root)) walk(root, `${part(brand)}/${part(batch)}`);
  return files;
}

/** Build a zip file on disk; returns absolute path to the zip. */
export async function buildBatchZip(files) {
  if (!files.length) throw new Error('no images to export');
  const tmp = await mkdtemp(join(tmpdir(), 'neuegen-export-'));
  const zipPath = join(tmp, 'export.zip');
  try {
    for (const f of files) {
      const dest = join(tmp, 'root', f.zipPath);
      mkdirSync(dirname(dest), { recursive: true });
      try {
        symlinkSync(f.absPath, dest);
      } catch {
        const { copyFileSync } = await import('node:fs');
        copyFileSync(f.absPath, dest);
      }
    }
    await execFileAsync('zip', ['-r', '-q', '-9', zipPath, '.'], { cwd: join(tmp, 'root') });
    return { zipPath, tmp, data: readFileSync(zipPath) };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}
