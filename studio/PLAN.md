# ImageGen Studio — spec, contract & build plan (v1)

A local SaaS app that manages AI ad-image production. Replaces the flat `dashboard.mjs` page with a
ClickUp/Linear-grade UI and a real per-slot job lifecycle. **All generation is driven from the UI; the
agent never launches codex from the terminal.** Dark theme ported from the ImageGen extension.

Approved decisions: React + Vite + TS · dark (extension palette) · full-granularity run/regenerate ·
archive = hide (never delete, never overwrite) · default landing = NanoX → Arthritis Listicle.

---

## 1. Topology

- **Backend** `studio-server.mjs` (zero-dep Node ESM) on **:8788** — owns the job queue + worker, scans
  the renders dir, proxies the bridge (:8787) for codex health, serves the built frontend + `/api/*` + `/img` + `/events` (SSE).
- **Frontend** Vite + React + TS in `studio/` → builds to `studio/dist/`, served by the backend.
  - Dev: `npm run dev` (Vite :5173, proxy `/api`,`/img`,`/events` → :8788).
  - Local-prod: `npm run build` → backend serves `dist/` at one URL (http://localhost:8788).
- Reuses `config.json`, `RENDERS = ~/Downloads/static-factory-b1/renders`, and `codexbatch.mjs`'s
  generation core. The old `dashboard.mjs` stays until Studio is verified, then is retired.

---

## 2. Data model

A **slot** is one image position: `{ brand, batch, ad, variation, prompt, run }`. Its `relPath` base is
`<brand>/<batch>/ads/<ad>/<var>/<prompt>/run-<N>[-vN].png`. Slot **status** (derived):
`empty · queued · generating · done · failed · archived`.

A **job** targets one slot generation:
```
Job = {
  id: string,                 // stable
  brand, batch, ad, variation, prompt,
  run: number,                // run index this job fills
  variants: number,           // requested in the enqueue that spawned it (for display)
  status: 'queued'|'running'|'done'|'failed'|'canceled',
  relPath?: string,           // written path (versioned) when done
  error?: string,
  enqueuedAt, startedAt, finishedAt: number|null,
  attempts: number
}
```
Persistence: `studio/.state/jobs.json` (queue+history, last 500) and `studio/.state/archive.json`
(array of archived relPaths). Both survive restart. Never delete renders; archive only hides.

---

## 3. Backend modules + API (the contract — build to these EXACTLY)

Modules (disjoint files): `studio-server.mjs` (http+routing+SSE+static), `lib/jobstore.mjs`,
`lib/worker.mjs`, `lib/state.mjs`, `lib/gen.mjs` (codex invocation).

### REST (all JSON unless noted)
- `GET /api/config` → parsed `config.json`.
- `GET /api/state?brand&batch` →
  ```
  { brand, batch,
    ads:[{ id, title, type, variations:[{ id, label,
      prompts:[{ id, slots:[{ run, status, version, relPath?, thumbUrl?, job?:{id,status,error,startedAt} }] }] }] }],
    codex:{ alive, progress }, queue:{ running, queued, done, failed }, archivedCount }
  ```
  `slots` merges disk renders (done, with newest version) + live jobs (queued/generating/failed) +
  archive set (archived). A prompt with no render + no job → one `empty` slot.
- `GET /img?path=<relPath>` → PNG from RENDERS (path-traversal-guarded). `?w=320` → downscaled thumb
  (cached to `studio/.cache/thumbs/`), used by the grid; full-res only in the drawer/lightbox.
- `POST /api/generate` body `{ brand, batch, scope:{ ads?, variation?, prompt? }, variants:number }` →
  enqueues N jobs per targeted slot (new run indices; never overwrites). Returns `{ ok, enqueued:number }`.
- `POST /api/regenerate` body `{ relPath }` → enqueue 1 job for that slot's next version. `{ ok }`.
- `POST /api/cancel` body `{ jobId }` or `{ all:true }` → cancel queued/running. `{ ok }`.
- `POST /api/archive` body `{ relPath, archived:boolean }` → toggle archive. `{ ok }`.
- `GET /api/health` → `{ ok, bridge, codex:{alive}, queue:{...} }`.
- `GET /events` → **SSE** stream. Events: `state` (a slot/job changed — payload = the changed slot
  coords + new status), `queue` (counts changed), `progress` (codex progress), `hello` (initial).
  Frontend subscribes once; falls back to polling `/api/state` every 2s if SSE drops.

### Worker (`lib/worker.mjs`)
Pulls `queued` jobs, runs ≤ `CONCURRENCY` (env, default 3) at once via `lib/gen.mjs`. On finish: writes
status + relPath, emits SSE `state`+`queue`. On a usage-limit/429 error: marks the job `queued` again and
pauses the worker for a cooldown (env `COOLDOWN_MIN`, default 30), then resumes — **this is the
auto-resume, now backend-owned**. Cap retries (3) then `failed`. `gen.mjs` calls
`python3 chatgpt-imagegen.py --backend codex` for the slot's prompt (low reasoning, CA bundle, tube ref
on tube shots) and versions the output path (never overwrite) — i.e. the proven `codexbatch` core,
factored into a single-slot function.

---

## 4. Frontend

### Stack
React 18 + Vite + TypeScript. State: **Zustand** store. Live: an **SSE hook** (`useEvents`) updating the
store; poll fallback. Primitives: **Radix** (`dialog`, `dropdown-menu`, `tooltip`, `tabs`, `scroll-area`)
styled to the dark theme. Icons: a small inline SVG icon set (no icon-font dep). No CSS framework — a
hand-built token-based stylesheet (CSS modules or a single `theme.css` + utility classes).

### Theme tokens (ported from the extension — dark, fixed)
```
--bg:#0c0d11; --surface:#15161c; --surface-2:#1c1e26; --surface-3:#21232d;
--ink:#eef0f5; --muted:#9498a4; --faint:#5f636e;
--line:#23252d; --line-soft:#1b1d24; --line-strong:#2e313c;
--accent:#1f7bff; --accent-soft:#16243d; --accent-ink:#9ec3ff;
--ok:#6fcf9b; --ok-soft:#16291f; --warn:#e6b566; --warn-soft:#2a2417; --err:#ff8071; --err-soft:#2c1a18;
--r-sm:6px; --r-md:9px; --r-lg:13px; --r-xl:18px;
type: 13px base / 1.45; -apple-system stack; weights 400/500/600 only;
space scale 4/8/12/16/24/32; focus ring: 0 0 0 2px var(--accent) at 35%.
```

### Component tree (disjoint files; props are the contract between agents)
```
src/
  main.tsx, App.tsx
  store.ts            // Zustand: config, selection{brand,batch}, stateByBatch, ui{view,drawerSlot,genDialog,showArchived,density,filter}
  api.ts              // typed fetch wrappers + types (mirror §3 shapes)
  useEvents.ts        // SSE subscription → store; poll fallback
  theme.css, base.css
  components/
    AppShell.tsx      // grid: sidebar | (topbar / main); mounts ActivityDock, DetailDrawer, GenerateDialog
    Sidebar.tsx       // brand switcher (Radix dropdown) + batch list (active highlight) + Activity/Settings + health dot
    TopBar.tsx        // breadcrumb · view switch (Grid|Board|Table) · filter · density · Stop · Generate▾
    BatchView.tsx     // chooses Grid/Board/Table by ui.view
    views/GridView.tsx     // ads → variations → SlotCard grid (default)
    views/BoardView.tsx    // kanban columns by status: Queued/Generating/Done/Failed (cards = slots)
    views/TableView.tsx    // dense table: ad/variation/prompt/version/status/actions
    SlotCard.tsx      // the per-image card; renders by status (empty/queued/generating/done/failed/archived); hover actions
    AdSection.tsx, VariationRow.tsx
    DetailDrawer.tsx  // Radix slide-over: full image, prompt, versions strip, actions (regenerate, variations, archive, download)
    ActivityDock.tsx  // floating panel: running+queued+recent jobs, cancel/retry, collapsible
    GenerateDialog.tsx// Radix dialog: scope (batch/selected ads/variation) + variants 1-6 + estimate → POST /api/generate
    StatusPill.tsx, Spinner.tsx, Thumb.tsx, EmptyState.tsx, Icon.tsx
```

### Per-card states (SlotCard)
`empty` dashed + “＋ Generate” (click → enqueue 1) · `queued` muted, “Queued · #k” · `generating` accent
border + spinner + elapsed + indeterminate bar · `done` thumb + version badge + hover row
(regenerate / variations / archive / expand) + click → drawer · `failed` danger tint + reason + Retry ·
`archived` only shown when `ui.showArchived`, dimmed, “Restore”.

---

## 5. The “clean” bar (non-negotiable polish)

- Calm, spacious; Linear-grade restraint. One accent. Hairline `0.5px` borders. 12–13px radii on cards.
- Motion: 120–160ms ease on hover/drawer/dialog; reduced-motion respected; spinners only while running.
- Every state designed: empty (inviting, not “nothing here”), loading (skeleton shimmer, not spinners-everywhere), error (reason + action), offline (bridge/codex down banner).
- Keyboard + a11y: focus-visible rings, Esc closes drawer/dialog, `aria-live` on the activity dock + status changes, `role=progressbar` on bars, all icon buttons labeled.
- Density toggle (comfortable/compact) changes tile size + paddings.
- No layout thrash: slot updates patch a single card (keyed), never re-render the whole grid; images load eager with fixed aspect boxes (no `loading=lazy`).
- Sentence case, contractions, verb-first buttons; numbers rounded.

---

## 6. Build / run

`studio/package.json` scripts: `dev` (vite), `build` (vite build → dist), `preview`. Deps: react,
react-dom, vite, @vitejs/plugin-react, typescript, @types/*, zustand, @radix-ui/react-{dialog,
dropdown-menu,tooltip,tabs,scroll-area}. Launch: `node studio-server.mjs` (serves dist + api). A
`studio/run.sh` starts the bridge (if needed) + the server.

---

## 7. Build phases (each = one agent fan-out against this contract; I integrate + verify in-browser between)

1. **Scaffold** (me): Vite project, configs, theme/base css, store/api/useEvents types, npm install.
2. **Backend**: jobstore, worker, gen, state, server+SSE+routes. Verify via curl (state/generate/SSE).
3. **Shell + theme**: AppShell, Sidebar, TopBar, store wiring, Icon/StatusPill/Spinner/Thumb/EmptyState.
4. **Views**: GridView + SlotCard (all states), AdSection/VariationRow; then BoardView, TableView.
5. **Drawer + Dock + Dialog**: DetailDrawer, ActivityDock, GenerateDialog, wired to api + store.
6. **Live + polish**: useEvents SSE end-to-end; loading/empty/error/offline states; density; a11y;
   in-browser verification (claude-in-chrome) + screenshot proof; retire old dashboard.

---

## 8. Defaults & guarantees
- Lands on **NanoX → Arthritis Listicle**.
- Generation only via the UI; backend owns the worker + auto-resume. No terminal-launched runs.
- Never overwrite (versioned writes); archive hides, never deletes.
- Full granularity: batch / ad / variation / slot generate + per-slot regenerate + make-N-variations.
