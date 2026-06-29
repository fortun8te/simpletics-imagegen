# ImageGen Design

How the extension generates images by driving the user's real, logged-in ChatGPT tab on their normal subscription quota, and where it goes next.

## The core idea

Browser automation cannot make ChatGPT render images: it trips Cloudflare and the automation block. The Codex backend can, but it bills the metered Codex bucket, which runs out. ImageGen sidesteps both. It runs as a normal Chrome extension inside the user's own logged-in session, so ChatGPT renders images exactly as it would for a person, on the normal image quota, with no automation flag and no Cloudflare fight.

The one rule that makes this safe to leave running: the extension drives its OWN background ChatGPT tabs. It never hijacks the tab the user is looking at.

## The three parts

- **bridge.mjs** is a tiny local HTTP server on `127.0.0.1:8787`. It is the job queue and the disk writer. Callers (gen.mjs, runbatch.mjs, Claude, Telegram) push jobs in over HTTP. It hands jobs out one at a time, takes finished PNGs back, and writes them to disk. It holds no browser and renders nothing. It is the only piece that never sleeps, so it is also the watchdog.
- **background.js** is the extension service worker. It polls the bridge, owns the pool of background ChatGPT tabs, sizes that pool to demand, and orchestrates parallel lanes. It is the agent: it decides which tab runs which job and recovers from its own eviction.
- **content.js** runs inside each ChatGPT tab. It is the hands: attach the reference images, type the whole prompt as one message, submit once, watch for the rendered image, and hand back the data URL. It also detects refusals and rate limits and returns them as clean errors.

```
caller (gen.mjs / runbatch.mjs / Claude / Telegram)
        |  POST /enqueue
        v
   bridge.mjs  (:8787 queue + disk)  <----- POST /result (PNG) -----+
        |  GET /next                                                |
        v                                                           |
 background.js (service worker)                                     |
   - polls /next                                                    |
   - sizes the owned-tab pool to demand                             |
   - runs N parallel lanes                                          |
        |  chrome.tabs.sendMessage {generate}                       |
        v                                                           |
 content.js (in an owned background chatgpt.com tab)  --------------+
   - attach refs, type ONE message, submit, capture image
```

## Job lifecycle

1. **Enqueue.** A caller POSTs `/enqueue` with `{ jobs:[...], out:"/abs/dir" }`. Each job gets an id and lands `pending`. A job is `{ name, prompt, refs, project, relativePath, variants, variantPaths, aspect }`. `refs` may be inline `{ dataUrl, name }` or `{ path }` that the bridge reads off disk so callers can send tiny payloads instead of megabytes of base64.
2. **Serve.** The worker polls `GET /next`. The bridge returns one `pending` job, flips it to `running`, stamps `startedAt`, and bumps `attempts`. Pool sizing uses `/status.pending` so demand, not a fixed pool, decides how many tabs open.
3. **Prepare.** The lane ensures its tab sits in the right ChatGPT project (create-once, shared cache, see below). A project hiccup is non-fatal: the lane falls back to a plain home chat (`noProject`) and still generates.
4. **Generate.** content.js attaches the refs in order (so they map to `@img1, @img2, ...`), types the prompt plus the variants line plus the aspect line as ONE message, submits once, and waits for the new image. It returns `images:[...]`, one entry per variation.
5. **Return.** The worker POSTs `/result` with the first image. The bridge writes it to `OUT/relativePath` and marks the job `done`. Extra variations are written client-side by Chrome's downloader (rooted at `~/Downloads`), which is why `--out` must live under Downloads.
6. **Settle.** `/status` reflects `done | error | skipped`. Callers that passed `--wait` poll until their job settles, then wait briefly for every variation file to hit disk.

## The agentic-control model

This is what makes the extension a hands-off worker rather than a button you babysit.

**Owned background tabs, never the foreground tab.** Every working tab is one the extension opened itself (`ownedTabs`), created with `active:false` in the user's last focused window so it shares the session cookies and stays out of the way. The user's own foreground ChatGPT tab is never typed into. A last-resort fallback reuses an existing tab only if Chrome refuses to open a new background tab at all, so a job still runs rather than failing outright.

**Demand-sized pool.** A single one-off job opens exactly one tab. A real batch scales up to the cap. The worker peeks one job, reads `/status.pending`, and opens `min(concurrency, pending + 1)` tabs, never more than `HARD_CAP` (6), with lanes staggered by 1.5s to stay under ChatGPT's rate limits. Warm tabs are reused across sweeps; idle owned tabs are reclaimed after about two minutes, keeping one warm tab for a fast follow-up.

**One-message sends.** content.js types the entire prompt, the variants instruction, and the aspect line as a single submitted message. Multi-paragraph prompts are joined with soft breaks (Shift+Enter) so the whole thing stays one turn. This matters: it keeps the conversation clean, the ratio honored, and the quota spend predictable (one message, not a back-and-forth).

**Aspect control.** A job may carry `aspect`: one of `16:9 / 9:16 / 4:5 / 5:4 / 4:3 / 3:4 / 1:1 / auto`. When set and not `auto`, content.js appends `Output the final image in <ratio> aspect ratio (<orientation>)` to the same message and stays ratio-neutral elsewhere. When `auto` (or unset), behavior is unchanged: it only forces `1:1 square` if neither the job nor the prompt already declares a shape. So `auto` is a true no-op.

**HTTP abort.** A caller POSTs `/command {type:'abort'}`. The bridge clears its queue, unpauses, resets milestone latches, and latches `abortRequested`. The next `GET /next` returns `{abort:true}` exactly once. The worker reads that and calls `abortAllTabs`, which messages every tracked pool tab and every chatgpt.com tab to stop in-flight generation. No persistent stop flag is set, so the next enqueued job runs normally on a later sweep.

**Refs by path.** `/enqueue` accepts refs as `{ path }`. The bridge reads the file and base64-encodes it, so callers enqueue tiny path payloads instead of huge inline data URLs. An unreadable path is skipped with a warning rather than crashing the enqueue.

**The gen.mjs contract.** gen.mjs is the clean single-shot entrypoint, no config.json and no brand/batch wiring. It takes `--prompt` and `--out` (which must live under `~/Downloads` so all variations land together), encodes `--refs` in order, builds per-variant paths, enqueues one job, and (unless `--no-wait`) polls `/status` until the job settles and the files appear, then prints a JSON result. It is the contract an agent codes against: one job in, files on disk out, a non-zero exit on failure.

## Agentic runbook: how Claude drives this

This is the exact order an agent follows to generate one image safely. Each step gates the next, so a bad session, a missing ref, or a typo is caught before any quota is spent.

```bash
# 1. Readiness. Is the bridge up, is the extension connected, am I logged in?
node gen.mjs --health

# 2. Dry-run. Validate the job (refs exist, out under Downloads, prompt non-empty)
#    WITHOUT generating. Prints the resolved job.
node gen.mjs --dry-run --prompt "Wide hero of the mousse in hand" \
             --out ~/Downloads/x/y.png --aspect 16:9 --refs a.png

# 3. Generate and wait. Polls until the job settles and the files land.
node gen.mjs --prompt "Wide hero of the mousse in hand" \
             --out ~/Downloads/x/y.png --aspect 16:9 --refs a.png

# 4. Read the manifest written next to the output.
cat ~/Downloads/x/y.manifest.json

# Plumbing-only smoke test (no generation, no quota): run after a code change.
node tests/agentic-smoke.mjs
```

Abort an in-flight run at any time:

```bash
node gen.mjs --abort
```

**The health contract.** `node gen.mjs --health` calls `GET /health` and returns `{ ok, bridge, extensionConnected, loggedIn, queue }`. `bridge` is true once the server answers. `extensionConnected` is true when the service worker has polled recently. `loggedIn` reflects the last `POST /ping` from the extension (it reports its logged-in state). `ok` is the AND of those: only enqueue a real batch when `ok` is true, so you fail on image zero instead of image fifty. Exit code is `4` (not ready) when `ok` is false.

**The dry-run contract.** `--dry-run` runs the full caller-side validation path (refs readable, `--out` under `~/Downloads`, prompt non-empty, aspect legal), resolves the per-variant paths, and prints the job it WOULD enqueue. It never touches `/enqueue` and spends nothing. A validation failure exits `1`. Use it as a cheap lint before every generate.

**Exit codes.** gen.mjs is the contract an agent codes against:

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 1 | usage error or bridge unreachable |
| 2 | timeout (job did not settle in time) |
| 3 | job failed (see `errorCode` in the manifest) |
| 4 | not ready (`--health` `ok` was false) |

**The run manifest.** Every generation writes `<outdir>/<name>.manifest.json`, the durable record of the run:

```json
{
  "name": "01-mousse",
  "prompt": "Wide hero of the mousse in hand",
  "aspect": "16:9",
  "variants": 1,
  "refs": ["/abs/a.png"],
  "files": ["/abs/01-mousse.png"],
  "chatUrl": "https://chatgpt.com/g/.../c/...",
  "status": "done",
  "error": null,
  "errorCode": null,
  "startedAt": "2026-06-25T10:00:00.000Z",
  "finishedAt": "2026-06-25T10:02:11.000Z"
}
```

Read it instead of guessing: `status` is `done | error | skipped`, `files` are the variations on disk, `chatUrl` opens the source chat, and on failure `errorCode` tells you how to react.

**The errorCode taxonomy.** On failure the manifest carries a typed `errorCode` so an agent branches instead of blindly retrying:

| errorCode | What it means | Agent reaction |
| --- | --- | --- |
| `NOT_LOGGED_IN` | session is not logged in | stop, re-auth, re-run `--health` |
| `REFUSED` | ChatGPT refused the prompt | rewrite the prompt, do not retry as-is |
| `RATE_LIMITED` | hit the image cap | back off, retry later |
| `TIMEOUT` | no image in time | retry once, then investigate |
| `NO_IMAGE` | turn finished with no image | retry, or simplify the prompt |
| `UPLOAD_FAILED` | a ref failed to attach | check the ref file, re-run |
| `DOWNLOAD_FAILED` | image rendered but did not save | check Downloads perms, re-run |
| `UNKNOWN` | unclassified | inspect `chatUrl` manually |

**The chatUrl flow.** When a lane generates, it knows the project and the `/g/.../c/...` chat it ran in. That URL now rides through `/status` (per job) and into the manifest. So an agent can open the exact source conversation to inspect a refusal or a bad render without digging through ChatGPT history. `/status` also exposes `lastPollAt`, `lastLoggedIn`, and `lastPingAt` so a caller can see how fresh the extension's state is.

## Reliability machinery

**SW keepalive.** MV3 evicts the service worker after about 30s idle, but one generation awaits about two minutes. Without help the worker dies mid-await, the job sits `running` forever, and the batch stalls silently. Two layers fix this: a self-connected runtime port re-pinged every 20s keeps the worker classified as in use while work is active, and a 30s watchdog alarm re-drives `pollBridge` on every wake so an evicted worker resumes itself. Both stop when no work is active so an idle extension still suspends.

**Orphan watchdog (bridge side).** The bridge process never sleeps, so it is the backstop. A job `running` longer than 6 minutes is re-queued up to 3 attempts, then failed permanently so the batch settles instead of hanging. This recovers a lane whose worker was fully evicted, even if the extension stopped polling entirely.

**Create-once projects.** A batch must create its ChatGPT project at most once across many parallel lanes. A module-level `createdProjects` cache (project name to `/g/` URL) plus a per-project async lock with double-checked locking guarantees exactly one lane runs the create, then publishes the URL for everyone else. Names are canonicalized (whitespace collapsed) so the create, the find, the cache key, and the in-page move all agree on one name.

**Partial results.** ChatGPT often returns fewer images than asked. The missing variant slots are explicitly cleared so they stop spinning and the user can re-run them. A hard image cap or rate-limit error latches a pause so the queue holds its remaining jobs instead of burning them.

**Live reporting.** Every generation, panel runs included, is POSTed to `/report`, which forwards to Telegram (first-of-wave generating, each done with the photo, each failure). This is a one-way live window, separate from the queue, and is what `statusMessage` blends into a phone-friendly summary.

## Endpoint reference

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Readiness: `{ ok, bridge, extensionConnected, loggedIn, queue }` |
| `/enqueue` | POST | Add jobs, set `out` and batch number |
| `/next` | GET | Serve one pending job, or `{reload}` / `{abort}` / `{paused}` |
| `/result` | POST | Return a generated image (written to disk) |
| `/ping` | POST | Extension reports its logged-in state (feeds `/health`) |
| `/report` | POST | Live generation event for Telegram (not a queue op) |
| `/status` | GET | Queue snapshot plus per-job `chatUrl`, `lastPollAt`, `lastLoggedIn`, `lastPingAt` |
| `/command` | POST | `pause / resume / skip / retry / regen / runs / abort / help` |
| `/reset` | POST | Clear the queue and unpause |
| `/reload` | POST | Ask the extension to reload itself on next poll |

## Roadmap

Grouped Done / Next / Later. Each item is one line of why.

### Done

- **Typed failure results (errorCode taxonomy).** `/result` no longer flattens failures to a bare `error`. content.js classifies the turn and the manifest carries `errorCode` (`NOT_LOGGED_IN | REFUSED | RATE_LIMITED | TIMEOUT | NO_IMAGE | UPLOAD_FAILED | DOWNLOAD_FAILED | UNKNOWN`) so an agent branches instead of blind-retrying.
- **Structured per-run manifest.** Every run writes `<outdir>/<name>.manifest.json` with name, prompt, refs, aspect, variants, files, chatUrl, status, error, errorCode, and timing. Runs are now auditable and re-runnable.
- **Chat URL returned to the caller.** The lane's `/g/.../c/...` chat URL rides through `/status` per job and into the manifest, so a caller opens the source conversation without digging through history.
- **Health check endpoint.** `GET /health` returns `{ ok, bridge, extensionConnected, loggedIn, queue }`, fed by the extension's `POST /ping`. `gen.mjs --health` exits `4` when not ready, so a 50-image batch fails on image zero, not image one.
- **Dry-run / validate mode.** `gen.mjs --dry-run` runs the full validation path (refs exist, `--out` under Downloads, prompt non-empty, aspect legal) and prints the resolved job without spending quota.
- **Multi-prompt batches in one call.** `gen.mjs --jobs file.json` enqueues a whole list with per-job prompt, refs, and aspect and waits on all of it.

### Next

- **Queue persistence across SW eviction and bridge restart.** The bridge queue is in-memory; a bridge crash mid-batch loses every pending job. Persist the queue to a small JSON file and reload on boot so a restart resumes instead of dropping work.
- **Preview thumbnail on `/status`.** chatUrl is surfaced; a small inline thumbnail per job would let a caller eyeball a render without opening the file.
- **Per-job model or quality selection.** Let a job request a specific image model or quality where ChatGPT exposes the control, so heavier jobs and quick drafts can share one queue.

### Later

- **Headless / cron operation.** With queue persistence added (health checks and the manifest already shipped), run scheduled batches unattended: a cron job enqueues, the extension drains the queue, the manifest reports the outcome. The keepalive and watchdog already make long unattended runs survivable.
- **Automatic label-fix pass.** Small-product shots often render the label wrong. An optional second pass that re-prompts with a label correction (mirroring the static-factory and imagead label-fix discipline) would cut manual rejects.
- **Per-run rate-limit budget and adaptive pacing.** Learn the user's cap over a session and pace lane starts adaptively instead of a fixed 1.5s stagger, maximizing throughput under whatever quota is live that day.

## Product registry

Generated images keep coming out at the wrong scale, usually with the product too big. To fix this the system now carries real product knowledge in two files at the extension root.

- **products.json** is a registry of the Simpletics products with honest specs (name, line, volume, approximate height in cm, form, color note) plus a natural, real-world `sizeAnchor` phrase written for prompts. For example the Sea Salt Spray is a 237 ml / 8 oz pump bottle about 18 cm tall, anchored as "about the size of a tall soda or energy can, roughly a hand-length, only as tall as his foot". Non-spray products keep their anchor qualitative and mark uncertain numbers approximate.
- **products.mjs** is a tiny dependency-free ESM helper over that JSON. It exports `getProduct(key)` (tolerant of aliases like "spray", "clay", "mousse", "powder"), `sizeAnchor(key)` (the anchor phrase, or '' if unknown), and `productList()`.

Prompt builders should call `sizeAnchor(key)` and inject the returned phrase into the prompt so the model places the product at the right real-world size instead of oversizing it. The file header shows the exact injection pattern.
