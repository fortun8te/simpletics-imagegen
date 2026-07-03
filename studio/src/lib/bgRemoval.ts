// Local (in-browser) background removal via @imgly/background-removal.
// The library is dynamically imported so its ~1MB JS (plus lazily-fetched
// wasm/onnx model assets, served from the imgly CDN by default) stays out
// of the main bundle and is only downloaded when the user first cuts out
// a subject.

export type BgProgress = (pct: number) => void;

/**
 * Remove the background from an image.
 *
 * @param srcUrl      Same-origin URL of the source image (e.g. /img/... or /asset/...).
 * @param onProgress  Optional callback with 0-100 progress. Early values (model +
 *                    wasm download) dominate the first run; subsequent runs are fast.
 * @returns           PNG data URL with transparent background.
 */
export async function removeBackground(srcUrl: string, onProgress?: BgProgress): Promise<string> {
  onProgress?.(0);

  // Fetch the source image ourselves so failures are distinguishable from
  // model/CDN failures, and so the lib gets a Blob (no CORS surprises).
  let blob: Blob;
  try {
    const res = await fetch(srcUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } catch (e) {
    throw new Error(`Could not load the image (${e instanceof Error ? e.message : 'network error'}).`);
  }

  let lib: typeof import('@imgly/background-removal');
  try {
    lib = await import('@imgly/background-removal');
  } catch {
    throw new Error('Could not load the background-removal engine. Check your connection and retry.');
  }

  let resultBlob: Blob;
  try {
    resultBlob = await lib.removeBackground(blob, {
      output: { format: 'image/png' },
      progress: (_key, current, total) => {
        if (onProgress && total > 0) {
          onProgress(Math.max(0, Math.min(100, Math.round((current / total) * 100))));
        }
      },
    });
  } catch (e) {
    throw new Error(
      `Background removal failed (${e instanceof Error ? e.message : 'unknown error'}). ` +
        'First run downloads a ~40MB model — check your connection and retry.'
    );
  }

  onProgress?.(100);

  // Blob -> PNG data URL.
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Could not encode the cutout image.'));
    reader.readAsDataURL(resultBlob);
  });
}
