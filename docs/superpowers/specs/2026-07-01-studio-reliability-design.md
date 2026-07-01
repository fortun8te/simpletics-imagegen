# ImageGen Studio — reliability & observability design

**Date:** 2026-07-01
**Status:** approved for planning
**Scope:** `NEUEGEN/studio` (the React/Vite + Node app on `:8788`). Does not touch `bridge.mjs`, the Chrome extension (`sidepanel.html`/`background.js`/`content.js`), or the older terminal scripts (`codexbatch.mjs`, `codex-runner.mjs`, `runbatch.mjs`).

## Problem

The user's report: generation is unreliable and "just does weird stuff" across sessions — tiles show failed, the app feels inconsistent, and there's no way to see or control how much Codex usage a run will burn before/while it happens.

Investigation (reading `lib/worker.mjs`, `lib/jobstore.mjs`, `lib/gen.mjs`, `lib/usage.mjs`, `lib/state.mjs`, `studio-server.mjs`, and `.state/jobs.json`) found concrete, evidenced causes:

1. **Dead Codex credential.** `~/.codex/auth.json`'s refresh token is being rejected (`token refresh failed: HTTP 401`). 194 of the last 236 failed jobs, and 100% of jobs since the last successful render (Jun 30 ~21:22), fail with this exact error. Every retry hits the same revoked credential, so retries can never succeed. This is a user/ops fix (`npm i -g @openai/codex && codex login`), not a code fix — but the app gives no indication that this is what's happening; it just shows N failed tiles indistinguishable from ordinary flakiness.
2. **No timeout on the generation subprocess.** `lib/gen.mjs`'s `spawn('python3', ...)` has no timeout. A hang (network stall, etc.) leaves a job in `running` forever, permanently occupying one of the 3 concurrency slots. This presents as a frozen run or a queue count that doesn't match reality.
3. **Restarts manufacture fake failures.** `lib/jobstore.mjs`'s `load()` hard-marks any job left `running` at process start as `failed` with `error: 'interrupted (server restarted)'`. 42 of the last 236 "failures" are this, not real generation failures. Confirmed via `.state/jobs.json`.
4. **Usage limit exists but is unreachable.** `lib/usage.mjs` already implements `setUsageLimit`/`getUsageLimit`/`isLimitReached`, and `worker.mjs`'s pull-gate already honors `isLimitReached()`. `studio-server.mjs` never imports `setUsageLimit`, so there is no route and no UI to ever set a limit. Dead code today.
5. **Concurrency is invisible and static.** `MAX_CONCURRENT_JOBS = 3`, overridable only via `CONCURRENCY` env var at process start. No UI to view or change it.
6. **(Noticed in passing, unconfirmed) an enqueue race.** `enqueueSlot()`'s next-run-number computation (`doneRunCount + inflightCount + 1`) is read-then-write with no lock. Two near-simultaneous `/api/generate` calls targeting the exact same slot could compute the same run number. The on-disk write path (`versionedRelPath`) still prevents an actual file overwrite, but the gallery's "keep newest version per run" display logic could make a version appear to vanish. No direct evidence this has happened; cheap to close off regardless.
7. **(Noticed in passing) `avgDurationSeconds()` is polluted by instant failures.** `lib/jobstore.mjs`'s `recordDuration()` is called from both `complete()` and `fail()`. A batch of near-instant auth failures (each ~0.3–0.5s) drags the rolling average toward zero, making the GenerateDialog/TopBar ETA meaningless whenever recent jobs have been failing fast. Duration should only be a signal from real generations.

What's already solid and gets no changes: the queue drag-to-reorder (`ActivityDock.tsx` + `jobstore.reorder()`/`nextQueued()` — it's a real priority rewrite, not cosmetic), the ETA math itself (rolling average + live extrapolation), and the pause/resume/cooldown run-state machine.

## Goals

- Turn "everything is silently failing" into "the app tells you exactly why, once, clearly" — without the user having to inspect individual red tiles.
- Make a stuck/hung generation impossible to mistake for a healthy one.
- Make Codex usage limit and concurrency real, visible, adjustable controls instead of dead/hardcoded values.
- Stop restart artifacts from inflating the apparent failure rate.
- Zero real Codex/OpenAI API calls during implementation or verification of this work.

## Non-goals

- No visual/UI redesign (explicitly out of scope per the user).
- No changes to the Chrome extension / `bridge.mjs` pipeline, and no work to unify it with the Studio (raised as a finding, explicitly declined by the user for this pass).
- No new abstractions beyond what's needed for the above (no generic plugin system, no config UI framework, etc.).

## Design

### 1. Circuit breaker: distinguish "one flaky job" from "structurally broken"

Add a **consecutive-identical-failure streak** to the worker, independent of any single job's own 3-attempt retry budget:

- New worker-local state: `lastFailSignature: string|null`, `consecutiveFails: number`, `blockedReason: string|null`.
- In `runJob()`'s ordinary-failure branch (i.e. NOT a `RATE_LIMIT:` error, which already has its own cooldown handling and stays excluded from this counter): if the new error string equals `lastFailSignature`, increment `consecutiveFails`; else reset it to 1 and store the new signature. At `consecutiveFails >= 3`, set `blockedReason` to that error string.
- Any successful completion resets `consecutiveFails` to 0 and clears `lastFailSignature` — proof the pipeline works clears the slate.
- `runState()` gains a `'blocked'` state, reported whenever `blockedReason` is set, taking priority over `cooling`/`running`/`paused` (it's the most severe — it needs a human action, unlike a self-resolving cooldown).
- The existing internal pull-gate (currently named `blocked()` in worker.mjs — will need a rename to something like `pullGated()` to avoid clashing with the new public concept) must also return true whenever `blockedReason` is set, so the worker stops pulling new jobs exactly like it does for `userPaused`/`cooling`. Already-queued jobs are left alone (not canceled) so fixing the underlying problem and resuming continues the same queue.
- **Recovery reuses the existing pause/resume plumbing**: `resume()` clears `blockedReason`/`consecutiveFails`/`lastFailSignature` in addition to its current behavior, so the UI's existing "Continue" affordance (already wired to `api.resume()`) is the retry action — no new endpoint needed. `abortRun()` (used by Reset and Stop-all) also clears the block, so Reset still works as an escape hatch.
- `gen.mjs` needs one addition: detect known-permanent errors (`token refresh failed`, `refresh_token is no longer valid`, `auth.json not found`, `no ChatGPT OAuth access_token`, and the existing "tool not found" early return) and prefix them `FATAL: `, the same way `RATE_LIMIT: ` already works. Unlike an ordinary error (existing attempts<3 requeue-then-fail treatment), `worker.mjs`'s `runJob()` sends a `FATAL:`-prefixed error straight to `store.fail()` — retrying a known-permanent error just wastes more subprocess spawns against the same dead credential. It still counts once toward the consecutive-failure streak below, so three FATAL errors in a row (or a mix of FATAL and ordinary failures with identical text) trips the breaker the same way.

**Data contract:** `RunInfo` (src/types.ts) gains `blockedReason?: string | null`. `RunState` gains `'blocked'`.

**Frontend:** `TopBar.tsx` renders a distinct (visually urgent, not neutral like the cooling countdown) banner when `state === 'blocked'`, showing a short frontend-side interpretation of `blockedReason`:
- contains "token refresh" / "auth.json" / "OAuth" → "Codex login has expired. Run `codex login` in your terminal, then hit Retry."
- contains "tool not found" → "The generation tool isn't where the server expects it. Check `CHATGPT_IMAGEGEN`, then hit Retry."
- anything else → "Generation stopped — the last 3 attempts failed the same way: “{raw error}”. Fix the underlying issue, then hit Retry."
The primary button in this state calls `api.resume()` (same call as Continue), labeled "Retry". `ActivityDock.tsx`'s "isPaused" treatment (which currently shows the pause/continue affordance for `paused`/`cooling`) extends to include `blocked`.

### 2. Generation timeout

`lib/gen.mjs`: wrap the spawned child in a timeout (default 180s, overridable via `CHATGPT_IMAGEGEN_TIMEOUT_MS`, consistent with the file's existing env-override convention for effort/verbosity). On timeout: `SIGTERM`, then `SIGKILL` after a few seconds if it hasn't exited, resolve `{ ok:false, error: 'TIMEOUT: generation exceeded {n}s' }`. A timeout is treated as an ordinary error (normal attempts<3 retry loop, not the FATAL fast-fail path) since a single hang could be transient — but repeated identical timeouts still trip the circuit breaker from §1 like any other repeating error.

### 3. Restarts don't manufacture failures

`lib/jobstore.mjs`'s `load()`: instead of marking orphaned `running` jobs `failed`, requeue them (`status = 'queued'`, bump `attempts` since it did consume one of the 3 tries, refresh `order`/`enqueuedAt` same as `requeue()` does) — unless `attempts` is already at the cap, in which case fail as today. This reuses the existing attempt-budget logic instead of adding a parallel concept.

### 4. Wire the usage limit

- `studio-server.mjs`: import `setUsageLimit` from `lib/usage.mjs`. New route `POST /api/usage-limit` body `{ limit: number|null }` (`null`/`0`/omitted = unlimited) → `setUsageLimit(...)`, respond with the resolved value.
- `SettingsDialog.tsx` → System section: a number input ("Pause after N images this session — blank for unlimited"), reading/writing via a new `api.setUsageLimit(n)` client method, pre-filled from `codexUsage.limit` (already present on the type, already returned by `getCodexUsage()` — just never settable).
- No worker change needed — `blocked()`/pull-gate already checks `isLimitReached()`.

### 5. Wire concurrency

- `lib/worker.mjs`: expose `setConcurrency(n)` (reassigns the existing local `concurrency` binding, clamped to 1–10, then calls `tick()` so raising the limit takes effect immediately) and include `concurrency` in `status()`'s return shape.
- `studio-server.mjs`: new route `POST /api/concurrency` body `{ n: number }` → `worker.setConcurrency(n)`. Include `concurrency` in the `/api/health` response.
- `SettingsDialog.tsx` → System section: a stepper/number input ("Generate N at a time"), via a new `api.setConcurrency(n)` client method, reflecting the current value from `/api/health`.

### 6. Enqueue race (minor hardening)

Serialize `enqueueSlot()`'s run-number computation per `(brand,batch,ad,variation,prompt)` key — a simple in-memory `Map`-based mutex in `studio-server.mjs` (acquire before `doneRunCount`+`inflightCount`, release after `store.enqueue()`), scoped to just that function. No behavior change for the normal (non-concurrent) case.

### 7. Stop polluting the duration average with failures

`lib/jobstore.mjs`: call `recordDuration(job)` only from `complete()`, not from `fail()`. Failed jobs no longer feed `avgDurationSeconds()`.

## Error handling / edge cases

- A rate-limit cooldown (`cooling`) and a structural block (`blocked`) are mutually exclusive triggers in practice (RATE_LIMIT errors are excluded from the consecutive-failure counter), but if both flags were ever simultaneously true, `blocked` wins for display (it needs a human action; `cooling` self-resolves).
- Manually setting concurrency below the current in-flight count doesn't cancel anything in flight — it just stops new pulls until `running` drops under the new number.
- Setting a usage limit lower than `sessionGenerated` immediately blocks further pulls (existing `isLimitReached()` behavior, unchanged).

## Files touched

`lib/worker.mjs`, `lib/gen.mjs`, `lib/jobstore.mjs`, `studio-server.mjs`, `src/types.ts`, `src/api.ts`, `src/components/TopBar.tsx`, `src/components/ActivityDock.tsx`, `src/components/SettingsDialog.tsx`. No changes to `lib/state.mjs`, `lib/usage.mjs`, `lib/INTERFACES.md` (update it, since it's the authoritative contract doc — but no logic changes there), or any other component.

## Verification (no real Codex/OpenAI calls)

`CHATGPT_IMAGEGEN` is already an env-var override for the tool path (`lib/gen.mjs`). Point it at a small throwaway local script for testing that, on command, either exits nonzero with a fixed error string, sleeps past the timeout, or writes a fake PNG and exits 0 — all instantly, all local, zero network calls. Use it to drive real `worker.mjs`/`jobstore.mjs`/`studio-server.mjs` code through: three identical failures → `blocked` state → banner → resume clears it; a hang → timeout fires → job fails, slot frees. Then exercise the new Settings controls and the banner in the browser preview against this stub — this does enqueue/run jobs, but against a fake local tool, never the real Codex backend, consistent with "don't generate real images."

## Open questions

None blocking — this is scoped tightly enough to implement directly from this doc.
