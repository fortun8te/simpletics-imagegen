# native-components

Real HTML/CSS building blocks for native-UI ad presets (X posts, IG posts/DMs, iMessage,
Notes screenshots, …) — the opposite approach from `lib/templates.mjs`, which hand-computes
every layer's `x/y/w/h` into a scene-graph. Here the **browser's layout engine** does that work:
flexbox rows size and space themselves, block-flow paragraphs wrap and stack on their own, pill
widths hug their text. No chars-per-line estimates, no manual slot-width division.

## Pattern

Each component is a single `.mjs` file exporting one pure function:

```js
export function renderXPost(params = {}) => { html, css }
```

- `html` — a self-contained fragment (e.g. `<div class="x-post">…</div>`). No `<html>`,
  `<body>`, or `<head>` tags — the caller embeds it in a larger document or a design canvas.
- `css` — a plain stylesheet body (no `<style>` wrapper) scoped by a root class
  (`.x-post …`) so multiple components' CSS can be concatenated without collisions.
- The function is a pure `params -> {html, css}` mapping: no DOM globals, safe to call from
  Node (SSR/export tooling) or the browser.

## `data-role` / `data-param` convention

Every meaningful element gets `data-role="…"` — a stable, human-readable hook name
(`name`, `handle`, `following-pill`, `action-like`, …) independent of CSS class names. Any
element whose text/attribute came directly from a param additionally gets
`data-param="paramKey"`.

These attributes aren't consumed by anything yet. They exist for a **future capture step**:
render the component in a real browser, walk `[data-role]`/`[data-param]` elements, read back
computed geometry (`getBoundingClientRect`) and styles, and use that to (a) reconcile visual
edits back onto `params`, and (b) snapshot the browser-computed layout into a scene-graph
`component` layer (see `ComponentLayer` in `src/lib/sceneGraph.ts`) if/when a design needs to
freeze to static positions.

## Adding a new component

Follow the same shape: `render<Thing>(params) => { html, css }`, real flexbox/grid instead of
absolute positioning, `data-role`/`data-param` on every meaningful node, sensible defaults so it
can be smoke-tested with `render({})`. Planned next: `ig-post`, `ig-dm`, `imessage`, `notes`.
