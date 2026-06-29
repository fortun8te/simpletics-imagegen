# ImageGen Dashboard — Build Contract (v1)

A LOCAL web dashboard that mirrors the extension's job UI but as a normal web page (no MV3 eviction):
live activity, Codex integration, an image grid of everything generated, and local-file access. Dark
visual language ported from the extension (`sidepanel.html`). Every agent builds ONE file to THIS spec.
Do not deviate from the names/shapes below — they are how the pieces fit together.

## Topology
- Node ESM server `dashboard.mjs` (NO external deps) listens on **http://localhost:8788**.
- Static frontend lives in `dashboard/` : `index.html`, `dashboard.css`, `api.js`, `ui.js`, `app.js`.
- The server reads `config.json` (same dir as dashboard.mjs's parent) and the renders dir, and PROXIES
  the running bridge at `http://localhost:8787` for live status.
- Paths: `RENDERS = <HOME>/Downloads/static-factory-b1/renders`, `BRIDGE = http://localhost:8787`,
  `ROOT = <dir of dashboard.mjs>/dashboard`, `REPO = <dir of dashboard.mjs>`.

## Server routes (dashboard.mjs) — EXACT
- `GET /` and `GET /index.html` → serve `dashboard/index.html`.
- `GET /<name>.css|.js` → serve static file from `dashboard/` with correct Content-Type.
- `GET /api/config` → `200 application/json` = the parsed `config.json` verbatim.
- `GET /api/state?brand=<brandId>&batch=<batchCode>` → JSON:
  ```
  {
    brand, batch,
    ads: [ { id, title, type, variations: [ { id, label,
              prompts: [ { id, runs: [ { version:<int,1=base>, relPath:"<brand>/<batch>/ads/<ad>/<var>/<prompt>/run-N[-vN].png", mtime:<ms> } ] } ] } ] } ],
    codexProgress: <object from bridge /status .codexProgress, or null>,
    queue: <object from bridge /status .queue, or null>,
    runner: { alive: <bool> }     // is a codex-runner.mjs process running
  }
  ```
  Build `runs` by scanning `RENDERS/<brand>/<batch>/ads/<ad>/<var>/<prompt>/run-*.png`. `version`: parse
  `-vN` (base run-N.png = version 1). Sort runs by (run number, version). Tolerate missing dirs (empty array).
- `GET /img?path=<relPath>` → serve the PNG from `RENDERS/<relPath>`. MUST reject path traversal
  (resolve and verify it stays inside RENDERS); 404 if missing. `Content-Type: image/png`.
- `GET /api/codex/log` → `text/plain`, last ~6000 chars of `REPO/codex-runner.log` (empty string if none).
- `POST /api/codex/run` body `{ batch:<code>, variants:<int> }` → if a runner is already alive return
  `409 {ok:false,error:"already running"}`; else spawn detached `node codex-runner.mjs` with env
  `{ ...process.env, BATCHES:batch, VARIANTS:String(variants), COOLDOWN_MIN:'60', MAX_CYCLES:'12' }`,
  cwd REPO, `stdio:'ignore'`, `.unref()`. Return `{ok:true}`.
- `POST /api/codex/stop` → kill any running `codex-runner.mjs` and its `codexbatch.mjs` children
  (pkill-style by matching the process; safe best-effort). Return `{ok:true}`.
- `GET /api/health` → `{ ok:true, bridge:<bool reachable>, runner:<bool alive> }`.
- Detect "runner alive" by checking for a `codex-runner.mjs` process (use child_process `exec('pgrep -f codex-runner.mjs')` and resolve bool).
- On listen, `console.log('[dashboard] http://localhost:8788  renders=' + RENDERS)`.

## index.html — EXACT element ids (app.js/ui.js depend on these)
- Header bar: `<select id="brandSel">`, `<select id="batchSel">`,
  `<input id="variantCount" type="number" value="2" min="1" max="6">`,
  `<button id="runBtn">Run in Codex</button>`, `<button id="stopBtn">Stop</button>`,
  `<span id="runnerState"></span>`.
- `<section id="activity"></section>` — codex/queue activity.
- `<section id="grid"></section>` — the image grid.
- `<details id="logWrap"><summary>Codex log</summary><pre id="log"></pre></details>`.
- `<div id="lightbox" hidden></div>` — full-image overlay.
- Footer/status: `<span id="bridgeState"></span>`.
- Load order at end of body (classic scripts, NOT modules): `api.js`, `ui.js`, `app.js`. Load `dashboard.css` in head.

## dashboard.css
Port the extension's dark theme from `sidepanel.html` (READ it for the exact CSS variables, colors,
`.lane`/`.lane-dot` states, radii, typography). Define `:root` vars (`--bg,--surface,--ink,--muted,
--faint,--line,--accent,--ok,--err` + radii). Style: body/header bar, selects, buttons (primary =
accent for #runBtn), `.lane` + dot states (active pulse / done / error / warn), the grid
(`.ad`, `.variation`, `.tile`, `.tile img`, version `.badge`), `.lightbox` overlay. Clean, spacious,
matches the extension. No external fonts/libraries.

## api.js  (sets `window.DASH = window.DASH || {}; window.DASH.api = {...}`)
Thin fetch wrappers, all against same-origin (port 8788):
- `getConfig()` → `await fetch('/api/config').then(r=>r.json())`
- `getState(brand,batch)` → GET `/api/state?brand=&batch=` → json
- `imgUrl(relPath)` → returns `'/img?path=' + encodeURIComponent(relPath)`
- `getLog()` → GET `/api/codex/log` → text
- `runCodex(batch,variants)` → POST `/api/codex/run` json body → json
- `stopCodex()` → POST `/api/codex/stop` → json
- `getHealth()` → GET `/api/health` → json
Each wrapped so a network error resolves to a safe default (null/`{}`/'') rather than throwing.

## ui.js  (sets `window.DASH.ui = {...}`)  — PURE render from data, no fetching
- `populateSelectors(config, selEls)` — fill `#brandSel`/`#batchSel` from config.brands (batchSel
  reflects the currently selected brand). Signature: `populateSelectors(config)` reading the live
  `#brandSel`/`#batchSel` values; re-render batch options when brand changes.
- `renderActivity(state)` — into `#activity`: a Codex lane (label "Codex · separate quota", a thin
  mini progress bar of `done+skipped`/`total`, the current shot prettified from `codexProgress.current`
  like `b2 AD-ART-04/A`, failed count if any), plus a queue summary line if `state.queue` has work.
  Show a "runner stopped / idle" state when not running. Style with `.lane` classes from the css.
- `renderGrid(state, onOpen)` — into `#grid`: for each ad → its title + variations; each variation →
  its prompt runs as `.tile`s, each an `<img loading="lazy" decoding="async" src=DASH.api.imgUrl(relPath)>`
  with a version `.badge` (v1/v2…). Newest version first. Click a tile → `onOpen(relPath)`.
- `setRunnerState(alive)` — update `#runnerState` text + `#runBtn`/`#stopBtn` disabled states.
- `openLightbox(relPath)` / `closeLightbox()` — fill/show/hide `#lightbox` with a full `<img>` (click
  backdrop or Esc closes; app.js wires Esc).
- `setBridgeState(health)` — set `#bridgeState` text+class from `getHealth()` result.

## app.js  — bootstrap + the only polling loop
On `DOMContentLoaded`: `config = await DASH.api.getConfig()`; `DASH.ui.populateSelectors(config)`;
wire `#brandSel`/`#batchSel` change → re-render batch list + immediate refresh; wire `#runBtn` →
`DASH.api.runCodex(sel.batch, sel.variants)` then refresh; `#stopBtn` → `DASH.api.stopCodex()`.
Poll loop every **1500ms**: read selection, `state = await DASH.api.getState(brand,batch)`,
`DASH.ui.renderActivity(state)`, `DASH.ui.renderGrid(state, DASH.ui.openLightbox)`,
`DASH.ui.setRunnerState(state.runner.alive)`. Separately poll `/api/codex/log` into `#log` every 3s and
`getHealth()` into `#bridgeState` every 4s. Wire Esc → `DASH.ui.closeLightbox()`. Guard against
overlapping polls (in-flight flag). Wrap each tick in try/catch.

## Conventions
- Plain classic scripts; one global `window.DASH` namespace. No bundler, no ES `import`, no libraries.
- Match the extension's dark theme exactly. Keep it calm and spacious.
- Every file must be self-contained and parse clean (`node --check` for .mjs/.js).
