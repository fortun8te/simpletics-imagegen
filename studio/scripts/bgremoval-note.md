# Local background removal — verification notes

Feature: in-browser background removal via `@imgly/background-removal@1.7.0`.

Files:
- `src/lib/bgRemoval.ts` — `removeBackground(srcUrl, onProgress?) → Promise<pngDataUrl>`; dynamic `import('@imgly/background-removal')` keeps it out of the main bundle.
- `src/components/design/ImageActions.tsx` + `.module.css` — self-contained "Cut out subject" button with progress + inline error. Editor wiring (onCutout → `api.uploadRef` → swap layer src) is documented in its header comment and owned elsewhere.

## Manual verification

1. Wire `<ImageActions srcUrl={layer.src} onCutout={...} />` into the Editor's image-layer panel (see header comment in ImageActions.tsx).
2. `npm run dev`, open a comp with an image layer, select it.
3. Click **Cut out subject**:
   - After ~2s with no progress, label reads "Downloading model (first run)…".
   - Then "Cutting out… NN%" as progress arrives.
   - On success, `onCutout` receives a `data:image/png;base64,...` URL with transparent background.
4. Run it a second time — should skip the download phase (model is cached by the browser).
5. Offline test: kill the network, click the button — expect the inline error mentioning the ~40MB first-run model download.
6. DevTools → Network: model/wasm requests go to `https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/…` (the lib's default `publicPath`).

## Vite caveats

- **No vite.config.ts changes were needed.** Verified with vite 5.4.21.
- **Code-splitting works.** A scratch production build with only `bgRemoval.ts` as entry produced a ~2.6 kB entry chunk and a separate ~82 kB chunk for the imgly lib (plus onnxruntime chunks) — the dynamic import is honored. The current `npm run build` shows no new chunk yet only because nothing imports `ImageActions`/`bgRemoval`; once the Editor wires it in, expect the extra lazy chunks in `dist/assets/`.
- **dist size caveat:** onnxruntime-web references its wasm via `new URL(..., import.meta.url)`, so vite copies `ort-wasm-simd-threaded.jsep-*.wasm` (~24 MB) into `dist/assets/` at build time. It is only ever downloaded by the browser if the lib's CDN `publicPath` were disabled — at runtime the default config fetches wasm + model from the imgly CDN instead. Harmless besides disk usage; if it bothers CI artifacts, it can be excluded, but don't fight it otherwise.
- **Offline bundling (not done, by design):** to serve assets locally instead of the CDN, copy `node_modules/@imgly/background-removal/dist/` (and `@imgly/background-removal-data` if installed) into `public/bgremoval/` and pass `{ publicPath: location.origin + '/bgremoval/' }` to `removeBackground`'s config. Only do this if offline use becomes a requirement — it adds ~80 MB of static assets.
- First run downloads ~40 MB of model data from `staticimgly.com`; it is cached by the browser thereafter.
