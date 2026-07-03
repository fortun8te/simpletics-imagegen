# System v2 — Elements, Inline Editing, and Panel Architecture rebuild

Why: the element system is unusable for both humans and the agent. Root flaw: elements are
built by hand-tuned canvas fractions (never measured), edited by raw style side-effects
(never rebuilt), and inline-edited through a textarea that is a *different renderer* than
the canvas. Every observed glitch — oversized handwritten-note boxes, the red caption edit
overlay, stat-card edit breakage, pill toggles that don't reset — traces to one of those three.

## A. Elements v2 — measurement-first builders (the core rebuild)

**Principle: a box is OUTPUT of measurement, never input.** No fractional `w/h` guesses.

1. **New build pipeline** (`lib/elements.mjs` → rewrite `buildElement` + a new tiny layout kit):
   - Builders declare CONTENT + LAYOUT INTENT, not boxes: a mini stack model —
     `col(gap, [textItem(role, text, style), row(gap, […])])` with an anchor
     (e.g. `{ x: 'left'|'center', y: 0.12, maxW: 0.86 }`).
   - A shared `layoutElement()` pass resolves boxes: measure each text item
     (`estimateTextBoxH`/`estimateLineCount` server-side, `textMetrics.ts` in the browser —
     same wrap math), give it its **intrinsic width** (measured line width, capped at maxW),
     stack with gaps, then position by anchor. The handwritten note's box hugs its text;
     the caption pill is as wide as its longest line, not 86% of the canvas.
   - Card-type elements (receipt, x-post, stat-card, comparison-table) size the CARD from the
     measured content height — item count changes never clip again.
2. **Single edit path: params, not side-effects.**
   - Every visual knob of an element becomes a param (including `pill`, `align`, `size`,
     colors). The properties panel and the agent both edit element instances ONLY via
     `setParams` → full rebuild in place (`scaleNodeInto` keeps user resize). Raw `setStyle`
     on element children is rejected with a pointer to the right param (agent already gets
     this via `sizeLocked`; the UI panel must follow).
   - Toggling pill/text off = rebuild without that param → zero stale styles. Fixes the
     "doesn't reset" bug by construction.
   - `setText` on an element child routes to the matching text param (`text`, `items[i]`,
     `quote` …) via a `paramRef` stamped on each built layer — then rebuild. Editing a receipt
     row re-measures the whole receipt.
3. **Resize semantics**: user/agent resize of an element instance re-runs `layoutElement()` at
   the new maxW (re-wrap + re-stack) instead of geometric scaling — text stays readable at
   any width.
4. **Migration**: old element instances rebuild from their stamped `{id, params}` on load
   (provenance already exists). Non-element raw layers untouched.
5. **Registry audit**: port all 29 elements to the stack model; `scripts/audit-elements.mjs`
   drops its BY_DESIGN allowlist (strict 8% threshold on everything, autoH or not) and gains
   a param-fuzz mode (long items, many items, tiny canvas).

## B. Inline editing v2 — same-renderer WYSIWYG

Replace the floating `<textarea>` entirely:
- Edit IN the Stage's own text node: set `contentEditable` on the very DOM element the Stage
  renders (per-line pill backgrounds, fonts, letter-spacing all identical — it IS the canvas).
  Commit on blur/Escape; live re-measure via the existing `textLayout` on input (debounced);
  caret preserved because nothing remounts (keep the one-shot focus guard).
- For element children, commit routes through `paramRef → setParams` (see A2).
- Delete the textarea code path and its style-mirroring; there is nothing to keep in sync.

## C. Panel architecture — bottom-anchored, full-height

- **AgentPanel**: `display:flex; flex-direction:column; height:100%` — header (one row:
  title · model chip · clear), messages `flex:1; overflow-y:auto`, **composer pinned to the
  bottom** (Cursor-style). BrandKitPanel MOVES OUT of the agent tab → collapsible section at
  the bottom of the Design (inspector) tab. Model switcher into a quiet footer row under the
  composer.
- **Right panel + left layers panel**: full column height (`max-height: none`, flex column),
  scroll only their list regions, panels stretch to the bottom of the viewport instead of
  floating at content height.
- **Design tab**: inspector sections reordered — selection props first, element params second,
  brand kit last (collapsed).

## D. Agent tab redesign (on the C skeleton)

- Header: `Agent · deepseek-v4-flash` one line, no BrandKit block above the chat.
- Messages: user lines and one collapsed row per run (keep), mini-timeline + shimmer current
  step while running (shipped), auto-scroll pinned unless the user scrolled up.
- Composer (bottom-pinned): ref chips row above input, attachment squares, textarea grows to
  4 rows max, footer row: ＋ menu · @ · model footer · send.
- Working overlay on canvas + edit-flash on touched nodes (shipped) stay.

## E. Verification

- `node scripts/audit-elements.mjs` strict — zero flags, no allowlist.
- New `test/elements-v2.test.mjs`: for every element × {default, long-text, many-items,
  square/portrait/story}: measured box fits content (≤8% error), rebuild idempotent,
  param-toggle leaves no stale style keys.
- Manual matrix in the preview browser: double-click-edit caption/handwritten/stat-card/
  receipt row — caret stable, box hugs text, pill preview identical to render.
- `npm run test:inspo -- --level=6 --live --refs=6` after: layout scores must not regress.

## Order

A1→A2 (pipeline + param editing) → B (editing) → A3–A5 (resize, migration, ports) → C → D → E.
A is the engine; B is unblocked by A2; C/D are independent and can interleave.
