# NEUEGEN Studio — Master Bug Catalog & Remediation Plan

Generated 2026-07-04 from a 20+-agent audit wave (read-only, evidence-based; every finding carries
file:line + confidence in the source reports). ~330 distinct documented findings across 11 domains.
This file is the executive index + the fix plan. Full per-finding detail lives in the audit
transcripts; IDs here match those reports (CHAT-n, RUN-n, ERR-n, STATE-n, UI-n, LAYER-n, DEAD-n, AI-n).

---

## The five systemic root causes (fix these, ~60% of symptoms disappear)

1. **Conditional-render-as-tab-switcher** (CHAT-1, STATE-2/3/4). `Editor.tsx` renders AgentPanel via
   a ternary → every Design↔Agent switch unmounts it, wiping ~15 pieces of state (chat draft,
   localEcho, running flag, revert snapshot…). Same anti-pattern at `BatchView.tsx` (top-level tabs
   destroy PlannerRail's in-progress brief) and `DesignView.tsx` (gallery↔editor). Worse:
   `insertLayers`/`insertPreset` force-switch tabs programmatically (CHAT-22/23), so users lose agent
   state without ever clicking a tab. **Fix pattern already in the codebase:** Radix
   `Dialog.Root open={...}` style always-mounted + visibility toggle (STATE-12).

2. **Two unbridged cancellation systems** (RUN-1/2/13). `extractLayout()` never receives the
   AbortSignal — it has its own older `activeRuns`/`cancelExtraction` registry that nothing calls.
   Result: copy-reference and self-improve-seed runs are **unabortable** — delete doesn't stop them,
   Stop button is cosmetic for them (plain edits abort correctly — live-verified A/B, RUN-4).

3. **Deterministic retries** (AI-1/10, EXTRACT). `llmVision` hardcodes `temperature:0`, so
   `visionRead`'s 5-attempt retry loop re-sends identical input → provably identical wrong output,
   5× per pass, ~5 wasted minutes per hard extraction. Verified live: 5 attempts, byte-identical
   `in=1696 out=284` every time.

4. **Non-atomic state writes** (ERR-29/34/35/36/37). `designstore.saveDesign` (the comps themselves,
   on a 250ms-autosave hot path), agent chats, brand kits, llm-config all use bare `writeFileSync`.
   A crash mid-write truncates the file; the read path silently treats corrupt as empty → **silent
   data loss**. `jobstore.mjs` already has the correct atomic tmp+rename pattern to copy.

5. **No save conflict detection** (ERR-16/17). Two tabs on the same comp silently last-write-wins
   clobber each other; the "Updated in another tab" chip doesn't block the next autosave; the server
   has zero version checks.

---

## Domain index (finding counts + the top items)

### CHAT — Agent chat state & tab switching (26 findings, live-reproduced)
Root cause #1 above. Also: CHAT-4/5 (remounted panel forgets an in-flight run → no Stop button,
locked canvas with no explanation = "top-most element no longer visible"), CHAT-10 (undo button
reappears after tab switch → double-undo data corruption), CHAT-20 (agentBusy set/clear race between
orphaned and new run can unlock canvas mid-run), CHAT-21 (pendingCopy nonce can double-fire a copy).

### RUN — Run lifecycle, abort, delete, revert (28 findings, live-verified)
Root cause #2 above. Also: RUN-6/7 (self-improve loop seed + scorer not abort-aware), RUN-8
(extractLayout's cleanup() runs before its self-check tail → even old cancel can't stop it),
RUN-14 (`api.deleteDesign` has ZERO UI call sites — how is the owner deleting?), RUN-25/26 (harness
retry paths skip signal checks).

### ERR — Error handling & edge cases (62 findings)
Root causes #4/#5 above. Also: ERR-1 (no React ErrorBoundary anywhere — any render exception =
blank white screen), ERR-24/25 (LM Studio down → raw "fetch failed" toast; no proactive health
indicator unlike the codex bridge), ERR-5/6 (no client file-size cap; 48MB server overflow resolves
`{}` → misleading error), ERR-18/20/21 (naturalWidth/canvas-w divide-by-zero paths), ERR-27
(sips-fallback mislabels webp as png on non-mac → reintroduces the 400), ERR-32 (thumb route TOCTOU
→ ERR_HTTP_HEADERS_SENT can escape the catch).

### STATE — State management & data flow (31 findings)
Root cause #1 repeats at 3 levels. Also: STATE-5 (switching workspace mid-edit keeps autosaving the
old brand's doc — cross-brand corruption risk), STATE-16/31 (designEvents/planEvents never cleared on
brand/batch switch), STATE-19 (codexUsage mirrored in 2 store slots with opposite fallback
directions), STATE-27/28 (run/runSelfImprove/runCopy = 3 hand-copied lifecycle implementations
already diverging).

### UI — Agent panel UI (42 findings)
UI-1/3 (attachment thumbnails have no click handler; purpose-built `RefLightbox` exists, used in
PlanView, never wired into AgentPanel), UI-4 (sub-agent list hard-caps at 3, silently drops others),
UI-5 (model label repeated per worker row — zero info), UI-6/7 (worker rows non-interactive +
truncate with no tooltip), UI-11 (error detection = fragile `/^fail/i` regex on prose), UI-18
(attachment remove button `tabIndex={-1}` — keyboard-unreachable), UI-27 (26px touch targets).

### LAYER — Layers, naming, text-edit, Figma (28 findings)
LAYER-27/28 (Figma export: thrown fetch/createImageBitmap — vs HTTP error — still nukes the WHOLE
doc to SVG fallback instead of per-image placeholder), LAYER-6/26 (deriveGroupName never recurses →
grouping groups always yields "Group"; Editor's manual ⌘G doesn't even attempt smart naming),
LAYER-22/23 (the 51 ComponentLayer tsc errors are REACHABLE: selecting a component leaf can read
`.style` on undefined), LAYER-1/2 (rename: no Escape-to-cancel; agent doc-replace mid-rename),
LAYER-9 (UTF-16 .slice can split emoji surrogate pairs in names).

### DEAD — Dead code & config (85 findings across 3 sweeps)
- **Frontend (26):** 7 fully-orphaned files (`StatusPill`, `Thumb`, `Spinner`, `nativeIcons.ts`,
  `ImageActions.tsx` — the cut-out UI, built but never wired!, `ai/Reasoning`, `ai/Task`); dead
  align/distribute toolbar library in sceneTree.ts (fully built, never wired); `autoCutoutShape`
  never called from the frontend; 4 dead icons; NUL byte embedded in DesignView.tsx regex (breaks
  grep); stale NewCompFlow/SkeletonLoader comments.
- **Backend (25):** codex-vision fallback dead branches (`codexVisionAllowed()` hardcoded false →
  `codexSee` unreachable); `PRESETS`/`DEFAULT_PRESET_ID` orphaned by ModelSelector removal;
  `instagram-colors.mjs` whole file never imported (the "free win" from research is STILL unwired);
  dead routes (`/api/design/thumb` read-side, `/api/skeleton/delete`, `/api/design/chat/clear`,
  `/api/daily-cap`); `draftCopy`, `listBrandSkills`, `stampAutoH` etc. dead exports.
- **Scripts/tests/config (34):** **5 of 8 test files never run by any npm script** (`test:agent`
  hardcodes 3 filenames); `figma-roundtrip.test.mjs` documented as authoritative but unrunnable via
  npm; 2 orphaned repo-root scripts; a runnable script stranded inside gitignored `.state/`;
  ARCHITECTURE.md + HARNESS-99-PLAN.md still describe Gemma/codex as the vision engine; ~10
  used-but-undocumented env vars; `.state/vision-tmp/` unbounded growth (no eviction).

### AI — Model output quality (12 findings)
AI-1 (deterministic retries — root cause #3), AI-2 (ornith 9B: creative JSON generation 0/4 parse
rate at 3000 tokens — needs sequential small asks: copy → layout → style), AI-3/11 (fidelity-score
plateau: empty-corrections fallback gives vague "run autolayout" advice at score 87-89 → loop stalls
to patience instead of converging), AI-4 (extraction prompt has no embedded JSON example), AI-8
(toSkeletonLayers silently coerces broken boxes to 0 — no repair log), AI-12 (maxTokens bump-retry
never validates the bumped output).

### HARNESS — Tool-calling/op-grammar gaps (21 findings)
CRITICAL: silent `return null` in remove/ungroup/reparent ops hides WHY an op failed (929-1036);
`look`/`draftText` documented in the grammar but live outside the applyOp switch (external callers
break); context-budget truncation is invisible to the model (it references truncated nodes → silent
failure loop); validation is asymmetric (align throws, radiusCorners silently NaNs). HIGH: no
clarify/ask op for ambiguous instructions; no mid-turn rollback (a failed group op leaves the doc
partially mutated); contrast guard skips element/setParams/setText paths; done-gate loops to
MAX_TURNS without escalation. MEDIUM: missing ops (batchRename, snapToKit, reorder-vs-base);
layoutDiagnostics only fires on exact vague-keyword match ("the layout is broken" gets nothing);
edit runs start with no lint baseline; best-of-N hides per-sample scores. LOW: stale alias map after
remove (L1 can silently point at a different node later); fast-path blocks all conjunctions.

### PERF — Timeouts (audit partially rate-limited; key confirmed items)
llmVision truncation-retry doubles maxTokens **without extending timeoutMs**; extraction worst case
= 5 attempts × 90s × 2 passes ≈ 15 min exposed as a hang; client `jpost` has no timeout distinct
from server limits; recursive retry/fallback chains can 2-3× the caller's expected deadline (ERR-26).

### Cleared domains
- **Theming:** confirmed clean after the `#2c5cff` few-shot fix — remaining blues are legitimate
  platform accents. THEME_BG/FG pairs correct.
- **Cut-out parity:** 120-case matrix solid; only exotic gaps (rotated parent groups, nested-group
  opacity ordering, post-resize crop remap, blend modes).
- **Benchmark context:** artificialanalysis.ai mapping done — τ³-Banking ≈ our agentic shape,
  MMMU-Pro ≈ vision (loosely), IFBench ≈ structured output; their tok/s is hosted-API-only, not
  comparable to local; our own benchmark stays authoritative.

---

## Remediation plan

### Wave 0 — the majors (coordinator fixes these personally)
| # | Fix | Files |
|---|---|---|
| 0.1 | Always-mount AgentPanel; kill the Design↔Agent ternary; stop `insertLayers`/`insertPreset` force-switching tabs during a run | `Editor.tsx` |
| 0.2 | Thread AbortSignal end-to-end through extraction: `extractLayout(signal)` → `visionRead` → `llmVision`; abort-check the self-check tail + self-improve seed/scorer | `layout-extract.mjs`, `design-agent.mjs`, `native-ui-loop.mjs`, `llm.mjs` |
| 0.3 | Kill deterministic retries: distinguish transient (timeout/network → retry) from deterministic (parse fail → ONE bumped/simplified attempt, then stop); extend timeout when maxTokens bumps | `llm.mjs`, `layout-extract.mjs` |

### Wave 1 — delegated (Opus 4.8 / Sonnet 5 subagents, disjoint files)
| Track | Model | Scope | Files |
|---|---|---|---|
| Data safety | opus | Atomic writes everywhere (copy jobstore's tmp+rename); save version-conflict check (updatedAt compare-and-reject + client re-fetch flow) | `designstore.mjs`, `studio-server.mjs`, `llm-config.mjs` |
| Frontend state | opus | BatchView always-mount tabs; PlannerRail state survival; workspace-switch guard for open editor (STATE-5); store cleanup on select() | `BatchView.tsx`, `PlannerRail.tsx`, `DesignView.tsx`, `store.ts` |
| Agent panel UX | sonnet | RefLightbox wiring (UI-1/2/3); sub-agent list overflow/+N more/expand/tooltips (UI-4/6/7); a11y (UI-17/18/26/27); error-detection contract (UI-11) | `AgentPanel.tsx`, `AgentActivity.tsx` |
| Dead code & tests | sonnet | Delete 7 orphaned frontend files + backend dead exports/routes + codex-vision branches + PRESETS; fix NUL byte; glob the test script; stale docs/comments | many (all provably dead) |
| Resilience | sonnet | React ErrorBoundary; LM-Studio-down health banner; friendly LLM error mapping; file-size caps; divide-by-zero guards | `App.tsx`, `api.ts`, small guards |
| Extraction quality | opus | Embedded JSON example in prompt; per-layer repair log; sequential-asks creative generation; fidelity-plateau "name ONE delta" instruction | `layout-extract.mjs`*, `native-ui-loop.mjs`* (*after Wave 0.2/0.3 land) |

### Wave 2 — verify
Full test suite (globbed, so all 8 files actually run) + build + live walk of: New comp → attach
reference → copy streams + Stop actually aborts extraction + delete kills the run; tab-switch
retains chat; two-tab conflict prompt; Figma export with a broken image URL.

## Execution status (2026-07-04)

**Wave 0 + Wave 1 are DONE and verified integrated: `npm test` 71/71 (all 8 test files, globbed),
`npm run build` clean, prod restarted with zero console errors.**

Wave 0 (coordinator): AgentPanel always-mounted (CHAT-1) + no force-tab-switch during runs
(CHAT-23); AbortSignal threaded llmVision→visionRead→extractLayout→copy-reference (RUN-1/2/8/9 —
proof: pre-aborted returns in 49ms, mid-flight abort lands in 3ms); deterministic-retry rewrite
(transient retries vs ONE corrective temp-0.4 nudge); truncation-retry timeout scaling; save
conflict client wiring (baseUpdatedAt + 409 → "updated in another tab"); 30MB upload caps;
context-budget guard made a hard invariant (fixed the 2 chronic test failures).

Wave 1 (delegated, Opus 4.8/Sonnet 5): atomic writes on all state files + 409 conflict server-side
+ thumb TOCTOU (data safety); BatchView always-mounted tabs + PlannerRail survival + workspace-
switch guard + store cleanup + NUL byte (frontend state); attachment lightbox + sub-agent list
overflow/expand + a11y + error-detection widening (agent panel); ErrorBoundary + LLM-down banner +
friendly errors + div-by-zero guards + size caps (resilience); 5 orphaned files deleted + 2
graveyarded + dead exports removed + all 8 tests wired into `npm test` + stale docs corrected +
.env.example completed (dead code).

**Wave 2 (2026-07-04, later) — DONE and verified: `npm test` 72/72, `npx tsc --noEmit` ZERO errors
(was 51), build clean, prod restarted with zero console errors.**

Coordinator (Fable) — engine overhaul: silent-null ops → descriptive throws across
remove/ungroup/order/duplicate/reparent/element/setParams (HARNESS-1); precise error for
harness-level look/draftText via applyOp (HARNESS-3); loud STATE TRUNCATED alert to the model
(HARNESS-4); layoutDiagnostics on every multi-node edit, not just vague-keyword matches
(HARNESS-8); contrast sweep after element insert + setParams rebuild (HARNESS-9); lint baseline
handed to edit runs up-front (HARNESS-11); done-gate escalation after 3 no-fix rejections →
'lint-stuck' instead of burning MAX_TURNS (HARNESS-12); embedded complete JSON example in the
extraction prompt (AI-4); per-layer box repair log surfaced in extraction progress (AI-8);
fidelity-plateau single-delta look instruction at score ≥85 (AI-11).

Delegated (Opus/Sonnet): Cursor-style chat restyle (user bubbles, "Thought for Ns", plain chat
replies, "New subagent / Starting up" lifecycle, inline worker model label re-added); Figma
robustness (thrown fetch/createImageBitmap now degrade to per-image placeholder, never whole-doc
SVG fallback + roundtrip tests for 404/corrupt/deep-nesting); type hygiene (51→0 tsc errors incl.
the REACHABLE ComponentLayer inspector crashes, component stub panel, Escape-cancels-rename,
agent-replace drops in-flight rename, emoji-safe truncation, GridTab/setLoading removed).

**Wave 3 (2026-07-04, evening) — owner-reported issues, all root-caused:**

- FIGMA TEXT (owner: "massive text issue") — PROVEN root cause: every autoH text node shipped
  contradictory `textAutoResize:'HEIGHT'` + `textAlignVertical:'CENTER'`; Figma's HEIGHT discards
  our size.y and hugs content, so CENTER had no slack → text landed at the wrong Y, and substituted
  fonts re-wrapping shoved neighbours. Fixed: always `NONE` + exact design box; autoH travels via
  pluginData (importer re-hydrates, roundtrip lossless). Wire-format tests added. Owner check: one
  paste with a multi-line autoH headline — verticals must match Studio.
- WINDOW GLITCH (owner: "have to zoom out, it's weird") — TWO mechanisms: (1) Stage's
  ResizeObserver measured mid-sidebar-transition (260ms) and the stale fit stuck until a manual
  zoom → debounced settle at 300ms + zero/NaN box guards; (2) below 860px `.center{order:1}` was a
  no-op because `.body` switched to display:block (order needs flex) → stage rendered far below the
  layers list; `.body` stays flex-column.
- ZOOM-WHILE-AGENT-EDITS (owner ask) — root cause diagnosed: `.stageWrap[data-locked] > :not(
  .agentOverlay) { pointer-events:none }` blankets the stage scroll container, killing the ⌘-wheel
  handler attached to it; edits are already JS-guarded (`if (locked) return` at every gesture), so
  the CSS lock is redundant for edits. Fix delegated to the run-lock UI agent (in flight).
- CURSOR-FOLLOWS-TARGET (owner ask) — backend contract SHIPPED: op steps now carry `targetId` +
  `targetBox {x,y,w,h,cw,ch}` (live canvas coords); frontend glide-to-target in flight.
- COPY HARNESS (owner: fonts wrong, over-eager elements/presets) — SHIPPED: fontFamily
  deterministically stripped from setStyle on copy docs; template op rejected on populated comps
  unless the task names an archetype; element op locked on copies unless asked; copy SELF-CHECK
  (render → vision-compare vs reference → ONE constrained corrective round, fonts+text locked).
  Extraction-side geometry-over-preset directive with the running eval agent.

Still open (small): HARNESS clarify-op + missing ops (batchRename/snapToKit/reorder-vs-base) +
alias-map staleness + fast-path conjunctions; AI sequential creative asks for the 9B; cutout
exotic-matrix gaps (rotated parent groups, blend modes); multi-tab busy sync + panel minimize
(features; collapsible sidebar SHIPPED in Wave 3); element-library build-out; Apple-Figma
extraction (blocked on connector auth).

### Parked (needs owner input)
- RUN-14: where does the owner's "delete" actually come from? (`api.deleteDesign` has no UI caller.)
- Multi-tab busy sync + panel minimize + collapsible sidebar (feature work, not bugs).
- Apple-components-from-Figma extraction (blocked on Figma connector auth).
- Element-library build-out per platform research (feature work).
