// ts-loader.mjs — a Node module-resolution hook for the cutout parity harness. Node's
// --experimental-strip-types can execute .ts files but does NOT do TS-style extensionless / dir
// resolution, so the studio's renderer imports ('../../lib/sceneGraph', '../../vendor/figma-kiwi')
// fail. This appends `.ts` (or `/index.ts` for a directory) to extensionless RELATIVE specifiers.
// Registered via node:module.register from the test file. Test-only; not shipped.
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Vite query imports (?url, ?raw, ?inline) and binary assets (fonts) have no runtime meaning here —
// stub them to an empty-string default export via a valid data: URL. Fonts don't affect cut-out
// geometry/pixels, which is all this harness tests.
const STUB_URL = 'data:text/javascript,export%20default%20%22%22%3Bexport%20const%20__stub%3Dtrue%3B';
const ASSET_RE = /\.(woff2?|ttf|otf|png|jpe?g|svg|css)(\?.*)?$/i;
const QUERY_RE = /\?(url|raw|inline)$/i;

export async function resolve(specifier, context, next) {
  if (QUERY_RE.test(specifier) || ASSET_RE.test(specifier)) {
    return { url: STUB_URL, shortCircuit: true };
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier)) {
    try {
      const asFile = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(asFile))) return next(specifier + '.ts', context);
      const asDir = new URL(specifier + '/', context.parentURL);
      const dirPath = fileURLToPath(asDir);
      if (existsSync(dirPath) && statSync(dirPath).isDirectory() && existsSync(dirPath + 'index.ts')) {
        return next(specifier + '/index.ts', context);
      }
    } catch { /* fall through to default resolution */ }
  }
  return next(specifier, context);
}
