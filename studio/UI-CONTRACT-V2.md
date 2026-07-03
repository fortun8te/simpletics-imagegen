# NEUEGEN UI v2 — delta over UI-CONTRACT.md (apply these; everything else in v1 still holds)

The app is now **NEUEGEN**. **Light is the default theme**; `ui.theme` ('light'|'dark') is applied to
`<html data-theme>` by App, and `theme.css` defines BOTH modes under the same var names — so components
adapt automatically; just keep using the vars. New tokens available: `--shadow-sm/md/lg`, `--font-serif`.
**Premium bar (match the user's refs — RevenueX / Knowledge Base light, Quantix dark):** soft shadows on
cards / popovers / drawer (`var(--shadow-md)`), rounded (cards `--r-lg`=14px), generous spacing, refined
type, calm. **Defaults: density 'compact', theme 'light'.** Store now has `ui.theme`, `ui.settingsOpen`,
and `View='grid'` only. New api: `api.getBatches(brand)→BatchMeta[]`, `api.getPrompt(...)→PromptInfo`.

## Sidebar.tsx (rewrite)
- Wordmark = **"NEUEGEN"** (the `sparkles` mark + the name). Brand switcher (NanoX…) stays, under a
  "Workspace" eyebrow.
- **Separation fix (important):** the sidebar must read as its own panel, not melt into the main area —
  `background: var(--surface)`, `border-right: 1px solid var(--line)`, and lift with `box-shadow: var(--shadow-sm)` on its right edge. Main area is `var(--bg)`. The contrast + border + shadow must clearly divide them.
- **Batches:** fetch `api.getBatches(brand)` (BatchMeta[] = `{code,name,kind:'ads'|'listicle',modifiedAt,count}`)
  instead of config batches. Add a small **search input** (filter by name, client-side) and **sort by
  `modifiedAt` desc** by default (most-recent first; a tiny relative-time or count hint is nice). **Distinct
  icons per kind:** `kind==='listicle'` → `<Icon name="layout-list"/>`, `kind==='ads'` → `<Icon name="layout-grid"/>`.
  Active batch row = `--accent-soft` bg + `--accent-ink`.
- Footer rows: **Activity** → `setUI({...})` to reveal the dock (or scroll to it); **Settings** →
  `setUI({settingsOpen:true})`. Health line already fixed ("Codex ready/running · bridge up").
- Sectioned, RevenueX-style eyebrows ("Workspace", "Batches", "Account").

## TopBar.tsx (update)
- **REMOVE the Grid/Board/Table view switch** entirely.
- **Stop is contextual:** render it only when `state.queue.running>0 || state.queue.queued>0`; otherwise omit.
- Add a **theme toggle** icon button: `<Icon name={theme==='dark'?'sun':'moon'}/>` → `setUI({theme: theme==='dark'?'light':'dark'})` (tooltip "Switch theme").
- Add an **activity pill** (always visible when there are jobs): shows `{running} running · {queued} queued`,
  click reveals/toggles the ActivityDock. Use `state.queue`.
- Keep breadcrumb, the density toggle, and the **Generate** primary. Refined spacing, soft surfaces.

## SlotCard.tsx + GridView.tsx (update)
- Honor **compact** density (default): compact tiles smaller; grid `minmax(${density==='compact'?150:208}px,1fr)`.
- **"Generate more" after each image:** at the END of each variation's slot row, render a dashed
  "**＋ Generate more**" tile that enqueues another variant for that variation
  (`api.generate(brand,batch,{variation:{ad,variation}},1)`). Make it obvious — that's the user's ask.
- **Tooltips:** wrap each hover action icon-button in a Radix `Tooltip` (`@radix-ui/react-tooltip`,
  installed) with `delayDuration ~500` showing the action label ("Regenerate", "Make variations",
  "Archive"/"Restore", "Open"). (A single `Tooltip.Provider` is mounted in AppShell — just use `Tooltip.Root/Trigger/Content`.)

## DetailDrawer.tsx (update)
- On open, `api.getPrompt(brand,batch,ad,variation,prompt)` → render the **prompt text** in a readable
  scrollable block (mono or serif, `--surface-2`), and if `refUrl` render the **reference image(s)** (e.g.
  the NanoX tube) as labeled thumbnails. This is "click an ad → see the prompt + reference images". Keep the
  full image, versions strip, and actions. Soft shadow, premium.

## SettingsDialog.tsx (NEW — create components/SettingsDialog.tsx + .module.css)
- Radix `dialog`, open when `ui.settingsOpen`, close → `setUI({settingsOpen:false})`. **Blurred dim
  backdrop** (`backdrop-filter: blur(8px); background: color-mix(in srgb, #000 38%, transparent)`).
  Card on `--surface`, `--r-lg`, `var(--shadow-lg)`. Contents: a **Theme** segmented control
  (Light/Dark → `setUI({theme})`), a **Density** segmented control (Comfortable/Compact → `setUI({density})`),
  a **Show archived** toggle (`setUI({showArchived})`), and an "About NEUEGEN" footer line. Sentence case,
  labeled controls, Esc/backdrop/X to close.

## ActivityDock.tsx (update)
- Keep the floating dock, but make it **discoverable**: it shows whenever there are jobs, and the TopBar
  activity pill toggles it. Premium card (`--surface`, `--shadow-md`, `--r-lg`). (No store flag needed if
  the TopBar pill just scrolls/focuses it; simplest acceptable: dock auto-shows on activity as today, and
  the TopBar pill is the visible indicator. Don't leave the user unable to find activity.)
- **Image-gen live state:** use `WorkingIndicator` / `WorkingDot` from `src/components/WorkingIndicator.tsx`
  (see `docs/WORKING-INDICATOR.md`). Do not duplicate the ping animation elsewhere.

## AppShell.tsx (update)
- Mount `<SettingsDialog/>` alongside DetailDrawer/GenerateDialog/ActivityDock.
- Wrap the whole shell in ONE `<Tooltip.Provider delayDuration={500} skipDelayDuration={200}>` (Radix) so
  card tooltips work app-wide.
- Sidebar separation is in Sidebar's CSS; AppShell grid stays (sidebar col uses `--surface`, main `--bg`).

## Backend (already being added): `/api/batches?brand`, `/api/prompt?...`, `/asset?name=` — match `api.ts`.
