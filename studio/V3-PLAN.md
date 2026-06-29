# NEUEGEN v3 — redesign & systems plan

Goal: stop looking vibe-coded; reach Antimetal/Sui-grade premium SaaS. Plan first, then build with an
agent fleet (disjoint files, tight contract), integrate + verify in-browser between phases.

## 0. Diagnosis (what reads as "AI / vibe-coded" today)
- **Layout bug:** main content scrolls *under* the sidebar — section titles get clipped on the left. The
  shell isn't constraining the content column or its horizontal overflow.
- **Type:** flat system-sans everywhere, no display moments, no hierarchy. (Geist + Fraunces now wired but
  unused by components.)
- **Cards:** generic flat squares + hairline borders; no depth, no rhythm, no editorial moments.
- **Chrome:** the footer account block + its popup look rough; the "Codex running · bridge up" status line
  is ugly; the activity dock looks thrown-together.
- **Redundant controls:** a filter we don't need; a light/dark toggle we don't need (pick ONE theme).
- **No run model:** always "Generate" + "Stop", no Pause / Continue / Reset / progress — no sense of state.

## 1. Design language (commit to ONE theme — see "Open decision")
- **Type:** UI = **Geist** (grotesk); **display = Fraunces** (editorial serif) for the batch hero + key
  headings. Scale: display 30–40 / title 18–20 / section 15 / body 13 / label 11 (uppercase, tracked).
- **Surfaces:** nested "tray" cards (subtle outer shell + inner core, concentric radii), **soft diffused
  shadows** (not hairline borders alone), squircle radii (14–20px). Eyebrow tags on section headers.
- **Accent:** one signature accent (see Open decision) used sparingly — primary action, active state, focus.
- **Rhythm:** more generous vertical spacing in the chrome + section headers; keep the gallery dense but
  give each ad section a clear header + breathing room.
- **Motion:** custom cubic-bezier (`cubic-bezier(.32,.72,0,1)`) on hover/enter/cards; gentle, physical.

## 2. Layout architecture (fix the structural bug)
- App shell = fixed-width sidebar (its own scroll) + a main column that is an **independent scroll
  container** with proper padding and a max content width; the grid wraps and never underflows the sidebar.
- Sidebar redesign: tighter sections, a redesigned **workspace/account footer** (clean row, no ugly popup —
  a refined menu), and a small refined **status chip** (not the raw text line).

## 3. Run system — a real state machine (NEW)
- **States:** `idle · running · paused · cooling (rate-limit) · done`.
- **Backend:** worker gains pause/resume; new `POST /api/pause`, `/api/resume`, `/api/reset` (clear queue +
  cooldown); `cancel` stays = stop. `/api/state` (+SSE) reports `run: { state, running, queued, done, failed, total, resumeAt }`.
- **UI run bar** (contextual, in the top bar / a slim bar): idle → **Generate**; running → **Pause** + **Stop**
  + live progress (done/total) + rough ETA; paused → **Continue** + **Stop**; cooling → "Resuming in m:ss"
  (auto) + Stop; **Reset** clears the queue. The primary button's label/action changes with state.

## 4. Activity — redesign
- Replace the dock with a clean panel (premium card or slide-over): a header with the run state + progress
  bar, job rows grouped by status with in-progress thumbnails, cancel/retry. Reachable from the run bar.

## 5. Status + Codex usage
- Replace the text line with a compact **status chip** (state dot + label) — Codex ready/running, bridge.
- **Codex usage remaining:** backend best-effort probe of the codex quota (rate-limit info from the codex
  responses call / account); surface a small **usage meter** ("Codex · 62% left" or "N left"). If the API
  doesn't expose it, show session generations + an honest "usage unknown" — never fake a number.

## 6. Remove
- The filter control. The light/dark toggle (one committed theme).

## 7. Documentation (explicit deliverable)
- Doc-comment every module (backend `lib/*`, `studio-server.mjs`, every component) with purpose + contract.
- Add `studio/ARCHITECTURE.md` (data flow, run state machine, API + SSE, component tree) and a `README.md`
  (what it is, how to run, how generation works). A dedicated documentation agent pass after the build.

## 8. Build approach (phased fleet; I integrate + verify each phase in-browser)
- **Phase A (me):** finalize design tokens for the chosen theme; type scale; the layout-shell fix; the
  run-state types + API contract; a v3 design/contract doc the agents build to.
- **Phase B (fleet, disjoint files):**
  1. App shell + layout fix + sidebar (footer/account + status chip).
  2. Run bar + state-machine UI (generate/pause/continue/stop/reset + progress + ETA).
  3. Backend: pause/resume/reset + worker states + codex-usage probe + SSE `run`.
  4. Activity panel redesign.
  5. Batch hero + ad-section/card redesign + SlotCard premium treatment; remove filter.
- **Phase C:** documentation pass (comments + ARCHITECTURE.md + README).
- Verify in the browser after each phase; screenshots.

## 9. Out of scope for now (noted)
- Restyling the Chrome extension to match (secondary — dashboard is the priority; follow-up).

## Open decisions (confirm before Phase A)
1. **Theme:** ONE direction — dark-premium (Antimetal/Quantix) vs clean-light (Sui/RevenueX).
2. **Accent:** refined blue vs a distinctive signature (e.g. lime/chartreuse like Antimetal, or violet).
