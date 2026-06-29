# Studio frontend — UI contract & design language (build to this EXACTLY)

React 18 + TS + Vite. **Containers read the Zustand store directly** (`useStore`) and call `api` +
store actions; **leaf components take props**. Each component = `Component.tsx` + (if it needs styling)
`Component.module.css` (CSS Modules; Vite handles them). Use the CSS variables from `src/theme.css`
(`--bg/--surface/--surface-2/--surface-3/--ink/--muted/--faint/--line/--line-strong/--accent/
--accent-soft/--accent-ink/--ok/--warn/--err` + `--r-*`, `--space-*`, `--dur`, `--ease`). Import shared
types from `../types`, store from `../store`, api from `../api`.

## Design language (the "clean" bar — Linear/ClickUp restraint)
- **Surfaces:** page `--bg`; sidebar/topbar/cards `--surface`/`--surface-2`; popovers/drawer `--surface-3`. Hairline borders `1px solid var(--line)` (use `--line-strong` on hover/active).
- **Radii:** cards/drawer/dialog `--r-lg` (13px); controls/inputs/buttons `--r-md` (9px); pills `999px`.
- **Type:** body 13px/1.45; section labels 11px, `--muted`, `letter-spacing:.06em`, UPPERCASE only for tiny eyebrow labels (sentence case everywhere else); titles 14–15px/500. Weights 400/500/600 only.
- **Spacing:** use `--space-*` (4/8/12/16/24/32). Generous; let it breathe.
- **Color = meaning:** one accent (`--accent`). Status → `done`=neutral, `generating`=accent, `queued`=muted, `failed`=`--err`, `archived`=dimmed. Status tints use the `*-soft` bg + the role color text.
- **Motion:** `transition: ... var(--dur) var(--ease)` on hover/open; spinners only while running; honor reduced-motion (already global).
- **Buttons:** primary = `--accent` bg + white text; secondary = transparent + `--line-strong` border + `--ink`; ghost = transparent, hover `--surface-2`. 28–32px tall, `--r-md`, 8–12px padding, icon+label gap 6px. Disabled = 0.45 opacity, not-allowed.
- **Icons:** a single inline-SVG set in `components/Icon.tsx` (`<Icon name="…" size={16}/>`). NO icon-font/CDN. Needed names: `sparkles, chevron-down, chevron-right, layout-grid, columns, table, activity, settings, stop, plus, refresh, archive, restore, download, expand, x, loader, alert, check, clock, photo, filter, sliders, dot`. Stroke icons, `currentColor`, 1.6 stroke width.
- **Every state designed:** empty (inviting, a verb CTA), loading (skeleton shimmer blocks, not spinners everywhere), error (reason + retry), offline (a slim banner when `/api/health` bridge/codex down). Sentence case; contractions; verb-first buttons; rounded numbers.
- **No layout thrash:** lists keyed by stable ids; images load eager in fixed `aspect-ratio:1` boxes (NO `loading=lazy`).

## Components (containers read store; leaves take props)

### App.tsx (already written) → renders `<AppShell/>`; owns config load, default select (nanox/b2), refresh on selection-change + SSE/poll.

### components/AppShell.tsx  (container)
CSS grid: `grid-template-columns: 248px 1fr; grid-template-rows: 52px 1fr`. Sidebar spans both rows
(column 1); TopBar in row 1 col 2; main scroll area row 2 col 2 renders `<BatchView/>`. Mounts (once)
`<ActivityDock/>`, `<DetailDrawer/>`, `<GenerateDialog/>`. Collapsible sidebar: store `ui` could hold a
`sidebarCollapsed` — OPTIONAL; if added, collapse to 64px. Reads nothing but layout; children read store.

### components/Sidebar.tsx  (container)
Reads `config, brand, batch`; actions `select`. Top: app mark (`Icon sparkles` accent) + "ImageGen Studio".
**Brand switcher**: a Radix `dropdown-menu` button showing the current brand name + chevron; items = `config.brands` → `select(brandId, firstBatchOfBrand)`. Section label "Batches". **Batch list**: the current
brand's `batches` → a row each (`Icon layout-grid` + `batch.name`); active (`batch===code`) = `--accent-soft`
bg + `--accent-ink` text (full radius, NOT a left-border). Footer: "Activity" + "Settings" rows (Settings can be inert for v1) and a health line: read `api.getHealth()` (poll 5s or via store) → a dot (`--ok` up / `--err` down) + "Codex ready · bridge up/down".

### components/TopBar.tsx  (container)
Reads `brand, batch, ui`; actions `setUI`; api `cancel`. Left: breadcrumb `<brandName> / <batchName>` (slash `--faint`, batch `--ink`/500). Right (gap 8): **view switch** segmented control (Grid|Board|Table → `setUI({view})`, active segment `--surface-2`+`--ink`); a **filter** menu (Radix dropdown: All / Done / Generating / Queued / Failed → `setUI({filterStatus})`); a **density** toggle (comfortable/compact → `setUI({density})`); **Stop** (ghost, `Icon stop`) → `api.cancel({all:true})`; **Generate** primary button (`Icon sparkles` + "Generate" + chevron) → `setUI({genOpen:true})`.

### components/BatchView.tsx  (container)
Reads `state, ui.view, loading`. If `loading && !state` → `<SkeletonGrid/>` (a few shimmer cards). If `state` empty (no ads) → `<EmptyState/>` "Pick a batch". Else switch `ui.view` → `<GridView/>` | `<BoardView/>` | `<TableView/>`. Also renders an **offline banner** at top when health shows bridge/codex down (optional; can live here or AppShell).

### components/views/GridView.tsx  (container)
Reads `state, ui.{density,showArchived,filterStatus}`. For each ad → `<AdSection>` (title `ad.title||ad.id` + a muted `ad.type` tag) → for each variation a `<VariationRow>` (label `id — label`) → a responsive grid (`repeat(auto-fill, minmax(<comfortable 188px / compact 132px>, 1fr))`, gap 12) of `<SlotCard>` for each slot of each prompt (flatten prompts' slots; if a variation has multiple prompts, group under small prompt sub-labels only if >1 prompt). Respect `showArchived` (hide archived unless on) and `filterStatus` (show only matching). A "＋ Generate variation" affordance at the end of each row → `api.generate(brand,batch,{variation:{ad,variation}}, variants=1)` (or open dialog prefilled). 

### components/SlotCard.tsx  (LEAF — props)
`props: { slot: Slot; ad: string; variation: string; prompt: string; density: Density }`. Reads store actions (`setUI`) + calls `api` directly. Fixed `aspect-ratio:1`, `--r-lg`, `overflow:hidden`, `position:relative`. Render by `slot.status`:
- `done`/`archived`: `<img src={api.imgUrl(slot.relPath!)} ...>` (eager, `object-fit:cover`; archived → `opacity:.4`). Version `.badge` top-left (`v{slot.version}`). On hover: a bottom action bar (icon buttons, `aria-label`): regenerate (`api.regenerate(slot.relPath)`), make-variations (open dialog or `api.generate` prompt-scope ×2), archive/restore (`api.archive(slot.relPath,!archived)`), expand (`setUI({drawerRel:slot.relPath})`). Click image → `setUI({drawerRel})`.
- `generating`: `--accent-soft` bg, `--accent` border, centered `Icon loader` (spin) + "Generating" + small elapsed from `slot.job?.startedAt`; an indeterminate bar at the bottom (`role=progressbar`).
- `queued`: muted, dashed `--line-strong`, `Icon clock` + "Queued".
- `empty`: dashed `--line`, centered `Icon plus` + "Generate" → `api.generate(brand,batch,{prompt:{ad,variation,prompt}}, 1)`. (brand/batch from store.)
- `failed`: `--err-soft` bg, `Icon alert` `--err`, the error (truncated, title=full) + a "Retry" pill → `api.regenerate` (or re-generate the slot).

### components/AdSection.tsx, components/VariationRow.tsx  (LEAF-ish presentational; props: `{title,type,children}` / `{id,label,children}`)

### components/views/BoardView.tsx  (container)
Kanban: 4 columns Queued / Generating / Done / Failed. Collect all slots across the batch; place each
in its column by status (archived hidden unless showArchived; empty omitted). Column header = name + count.
Cards = a compact `<SlotCard>` (or a slim variant) labeled with `ad/variation`. Columns scroll independently.

### components/views/TableView.tsx  (container)
Dense table: columns Ad · Variation · Prompt · Version · Status (`<StatusPill>`) · Updated · Actions
(regenerate/archive/expand). One row per slot. Zebra-free, hairline row borders, hover highlight.

### components/DetailDrawer.tsx  (container)
Radix `dialog` as a right slide-over (420–480px), open when `ui.drawerRel`. Find the slot/ad/variation
for `drawerRel` from `state`. Shows: full image (`api.imgUrl(relPath)`, contained), title/coords, the
prompt text (from config — pass via store or fetch; acceptable to show coords + status if prompt text not
readily available), a **versions strip** (all runs/versions for that prompt → thumbnails, click to switch),
and actions: Regenerate, Make 2 variations, Archive/Restore, Download (`<a href download>`), Reveal path
(copy relPath). Esc / backdrop / X closes (`setUI({drawerRel:null})`).

### components/ActivityDock.tsx  (container)
Floating bottom-right panel (NOT position:fixed conflicts — it's a normal app, fixed is fine here within
the SPA). Reads `state.queue` + derives in-flight/queued/recent jobs from `state` slots whose `job` is set
(generating/queued/failed) + recent done. Header "Activity" + counts (`{running} running · {queued} queued`).
Rows: spinner/clock/check/alert icon + `ad/var` + status + elapsed; a cancel (`api.cancel({jobId})`) on
queued/running, retry on failed. Collapsible (chevron). Hidden when totally idle (no jobs). `aria-live=polite`.

### components/GenerateDialog.tsx  (container)
Radix `dialog`, open when `ui.genOpen`. Fields: **scope** (radio: "Whole batch" / "Selected ads" (a
multiselect of the batch's ads) / not needed for v1 beyond batch + ads), **variants** (number 1–6,
default 2), a computed **estimate** ("~N images"). Primary "Generate" → `api.generate(brand,batch,scope,
variants)` then `setUI({genOpen:false})`. Cancel closes. (Per-ad/variation/slot generate is triggered from
the cards/rows directly; this dialog is the batch/ads-level entry.)

### components/ui primitives (LEAF; props)
- `Icon.tsx`: `{name:string; size?:number; className?:string}` → inline SVG (the set listed above).
- `StatusPill.tsx`: `{status:SlotStatus|JobStatus}` → a small pill, role-colored.
- `Spinner.tsx`: `{size?:number}` → spinning `Icon loader` (CSS keyframe; reduced-motion safe).
- `Thumb.tsx`: `{relPath:string; alt?:string}` → eager `<img>` in a fixed aspect box (used by drawer/board).
- `EmptyState.tsx`: `{icon?:string; title:string; hint?:string; action?:{label,onClick}}`.
- `Skeleton.tsx` (optional): shimmer block for loading.

## Conventions
- Default landing nanox/b2 (App handles). All generation via `api.*` (backend worker) — never any direct/terminal calls.
- Keep components small + focused; one file each. Relative imports. No new deps beyond what's installed (react, react-dom, zustand, @radix-ui/react-{dialog,dropdown-menu,tooltip,tabs,scroll-area}).
- Run `npm run build` must succeed; transient TS strictness: prefer correct types, but `noUnusedLocals` is off.
