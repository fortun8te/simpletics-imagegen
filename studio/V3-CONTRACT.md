# NEUEGEN v3 build contract (single dark theme + lime). Build to this; foundation is already in code.

Theme is ONE dark theme (no toggle, no `[data-theme]`). Tokens live in `src/theme.css` — USE THEM, never
hardcode colors. Removed from the store: `theme`, `view`, `filterStatus`. New in `src/types.ts`:
`RunInfo` + `CodexUsage` on `BatchState` (`state.run`, `state.codexUsage`). New api: `api.pause/resume/reset`.

## Design language (Antimetal-grade, lime accent)
- Type: UI `var(--font-sans)` (Geist); **display `var(--font-display)` (Fraunces)** for the batch hero +
  key titles (use the `.display` helper or the font var). `.eyebrow` helper for tiny uppercase tracked labels.
  Scale tokens: `--t-display/title/section/body/label`.
- Surfaces: nested "tray" cards — a subtle `--tray` shell with a hairline, holding an inner `--surface`
  core with concentric radii + `--shadow-md` + `--inset-hi`. Soft diffused shadows, not bare 1px borders.
- Accent: lime `--accent`; on a lime FILL use `--on-accent` (dark text). Active/selected = `--accent-soft`
  bg + `--accent-ink` text. Use accent sparingly (primary action, active, focus, in-progress).
- Motion: `transition: … var(--dur-2) var(--ease)` (custom bezier). Gentle hover lift on cards.
- Eyebrow tags above section/ad titles. Generous spacing in chrome; gallery stays efficient.

## Layout fix (critical — content currently slides under the sidebar)
AppShell: sidebar = fixed width column with its OWN overflow; main = an INDEPENDENT scroll container
(`overflow:auto; min-width:0`) with horizontal padding (`--space-8`) and a sensible max content width so the
grid wraps and NEVER underflows the sidebar. No element spans under the sidebar. Title text must never clip.

## Components

### AppShell.tsx — layout + mounts. Add a `<RunBar/>` slot if RunBar is separate; mount DetailDrawer,
GenerateDialog, SettingsDialog, ActivityPanel. Wrap in the `Tooltip.Provider`. Fix the scroll/clip per above.

### Sidebar.tsx (+ css) — redesign the lower half
Keep wordmark + batch list (search + recency + kind icons). FIX: remove the `ui.theme` menu item (theme is
gone). Redesign the **footer**: a clean workspace/account row (avatar mark + "NEUEGEN" / "Local") opening a
refined menu (workspace switch + Settings + About — NO theme item). Replace the ugly status line with:
- a compact **status chip** (a pill: a state dot + "Codex ready/running", a second dot + "Bridge up"), and
- a **Codex usage meter** from `state.codexUsage`: if `known`, a thin bar + label ("Codex · 62% left"); if
  `!known`, a muted "Usage · unknown" (+ optional session count). Premium, quiet, not the raw text line.

### TopBar.tsx (+ css) — breadcrumb + the RUN CONTROLS (state machine). REMOVE the filter and the theme toggle.
Drive from `state.run.state`:
- `idle` → primary **Generate** (`setUI({genOpen:true})`).
- `running` → **Pause** (`api.pause()`) + **Stop** (`api.cancel({all:true})`) + a slim inline progress
  (done/total) and rough ETA.
- `paused` → primary **Continue** (`api.resume()`) + **Stop**.
- `cooling` → a "Resuming in m:ss" countdown (from `run.resumeAt`) + **Stop** (auto-resumes; no button needed).
- A **Reset** (`api.reset()`) available when there's a queue/cooldown (clears it). Confirm before reset.
The primary button label/action changes with state. Keep the breadcrumb (brand / batch). Density toggle stays.

### RunBar (optional split of the above) — if you build it as its own component, it owns the run controls +
progress; TopBar just hosts breadcrumb + density + the RunBar. Either is fine; keep ONE source of run UI.

### BatchHero.tsx (NEW) — the editorial header above the grid (rendered at the top of GridView)
An `.eyebrow` (kind · "N images" · "updated …") + the batch name in **Fraunces display** (`--t-display`) +
a one-line descriptor + compact stats (done/total, variations). Subtle: a faint lime accent rule or a soft
radial in the corner. This is the "designed moment" the app lacks — make it feel premium, not a plain h1.

### GridView.tsx + AdSection.tsx + VariationRow.tsx (+ css) — redesign
Render `<BatchHero/>` first. Each ad = a section with an **eyebrow + title** (title can use display font),
the `ad.type` as a quiet tag. Variation rows labeled cleanly. Slot grid stays
`repeat(auto-fill, minmax(${density==='compact'?156:208}px,1fr))`. Keep the "＋ Generate more" tile but
restyle premium (tray, lime hover). REMOVE any `filterStatus` usage (filter is gone). Generous section spacing.

### SlotCard.tsx (+ css) — premium tile
Nested-tray feel: rounded `--r-lg`, soft shadow, gentle hover lift (`translate-y(-2px)` + shadow), image
`object-fit:cover`. Version badge = a small lime-or-neutral pill. Hover action bar with Radix tooltips
(Regenerate/Make variations/Archive/Open). `generating` = lime aura (`--glow-accent`) + spinner + elapsed;
`queued` = quiet dashed; `empty` = dashed "＋ Generate"; `failed` = `--err-soft` + reason + Retry. No flat
gray squares — everything reads crafted.

### ActivityPanel.tsx (rename/replace ActivityDock) (+ css) — redesign
A clean premium panel (bottom-right card or a right slide-over), opens on `ui.activityOpen` or when jobs
exist. Header: the **run state** + a progress bar (`run.done/total`) + the run controls echo (pause/continue/
stop). Job rows: grouped (running / queued / failed), each with a small in-progress thumb or icon, ad/var
label, elapsed, cancel/retry. Calm, not busy. `aria-live="polite"`. Close → `setUI({activityOpen:false})`.

### SettingsDialog.tsx — FIX: remove the Theme control (theme is gone). Keep Density + Show archived; add an
"About NEUEGEN" + (optional) the codex usage line. Blurred backdrop stays.

## Backend (studio-server.mjs + lib/worker.mjs + lib/state.mjs)
- worker: add `pause()` / `resume()` (stop pulling new jobs while paused; in-flight finish). Track state:
  `running` (jobs in flight), `paused`, `cooling` (rate-limit cooldown active, with resumeAt). Expose `runState()`.
- `POST /api/pause` → worker.pause(); `POST /api/resume` → worker.resume(); `POST /api/reset` →
  `store.cancel({all:true})` + clear any cooldown + worker.resume() (so a fresh Generate works). Keep `/api/cancel`.
- `buildState`/`/api/state`: add `run: RunInfo` (derive `state` from worker: jobs running→'running',
  paused→'paused', cooling→'cooling', none + queue empty + some done→'done', else 'idle'; counts from the
  store for the active run) and `codexUsage: CodexUsage`.
- **Codex usage probe** (`lib/usage.mjs`, best-effort): try to read remaining codex quota — inspect the codex
  responses error/headers for rate-limit info, or `~/.codex/auth.json`/account; cache briefly. If nothing is
  reliably available, return `{known:false, label:'unknown', sessionGenerated:<count this process>}`. NEVER
  fabricate a number. Wire into `/api/state.codexUsage` and `/api/health`.
- SSE: also emit on run-state changes.

## Documentation (Phase C, separate pass)
Doc-comment every module + add `studio/ARCHITECTURE.md` (data flow, run state machine, API+SSE, components)
and `studio/README.md` (what it is, how to run, how generation works).

## Conventions
Theme tokens only. Relative imports. No deps beyond installed (react, zustand, @radix-ui/*). `npm run build`
must pass. Remove all references to the removed store fields (`theme`, `view`, `filterStatus`).
