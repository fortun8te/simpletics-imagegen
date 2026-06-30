// Render-directory path helpers. Mirrors studio-server relPath layout:
// `<brand>/<batch>/ads/<ad>/<variation>/<prompt>/run-N[-vN].png`

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
