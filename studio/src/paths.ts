// Render-directory path helpers. Mirrors studio-server relPath layout:
// `<brand>/<batch>/ads/<ad>/<variation>/<prompt>/run-N[-vN].png`

export interface RelPathCoords {
  brand: string;
  batch: string;
  ad: string;
  variation: string;
  prompt: string;
  run: number;
  version: number;
}

export interface DownloadNameOpts {
  brandName?: string;
  batchName?: string;
  batchVersion?: string;
  adTitle?: string;
  slotVersion?: number;
}

/** Parse a render relPath into slot coordinates. */
export function parseRelPath(relPath: string): RelPathCoords | null {
  const clean = String(relPath || '').replace(/^\/+/, '');
  const parts = clean.split('/');
  if (parts.length < 7 || parts[2] !== 'ads') return null;
  const [brand, batch, , ad, variation, prompt] = parts;
  const m = /^run-(\d+)(?:-v(\d+))?\.png$/i.exec(parts[parts.length - 1] ?? '');
  if (!m) return null;
  return {
    brand,
    batch,
    ad,
    variation,
    prompt,
    run: Number(m[1]),
    version: m[2] ? Number(m[2]) : 1,
  };
}

/** Filesystem-safe segment for download filenames. */
export function sanitizeFilenamePart(value: string, max = 48): string {
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

/**
 * Build a descriptive download filename:
 * `{brand}-{batch}[-{batchVersion}]-{ad}-{variation}-{prompt}-run{N}[-v{revision}].png`
 */
export function buildDownloadFilename(relPath: string, opts: DownloadNameOpts = {}): string {
  const coords = parseRelPath(relPath);
  if (!coords) return sanitizeFilenamePart(relPath.split('/').pop() || 'image', 80) + '.png';

  const revision = opts.slotVersion ?? coords.version;
  const parts = [
    sanitizeFilenamePart(opts.brandName || coords.brand),
    sanitizeFilenamePart(opts.batchName || coords.batch),
  ];
  if (opts.batchVersion) parts.push(sanitizeFilenamePart(opts.batchVersion));
  parts.push(
    sanitizeFilenamePart(opts.adTitle || coords.ad),
    sanitizeFilenamePart(coords.variation),
    sanitizeFilenamePart(coords.prompt),
    `run${coords.run}`,
  );
  if (revision > 1) parts.push(`v${revision}`);

  return `${parts.join('-')}.png`;
}

export function variationRelDir(
  brand: string,
  batch: string,
  ad: string,
  variation: string,
  prompt?: string,
): string {
  const base = `${brand}/${batch}/ads/${ad}/${variation}`;
  return prompt ? `${base}/${prompt}` : base;
}
