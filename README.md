# Simpletics ImageGen (Chrome extension)

Batch-generate static-ad photos through your **own logged-in ChatGPT tab**, on your **normal subscription quota**. Because it runs in your real session, ChatGPT renders the images normally (the thing browser automation could not do), and every result auto-downloads under its correct IMG name.

## Why this exists
- Codex backend = the metered Codex-usage bucket (you ran out).
- This = the normal ChatGPT image quota, in your real browser. No Cloudflare fight, no automation block.

## Install (one time)
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder: `~/Downloads/NEUEGEN`.
4. Pin the extension if you like.

## Use
1. Open **chatgpt.com** in a tab and make sure you are logged in.
2. Click the **Simpletics ImageGen** icon to open the side panel.
3. Pick the **brand** and **batch** in the panel. ImageGen creates or finds that batch’s ChatGPT project before it starts work, so it works even when the tab was open on Projects or another ChatGPT page.
4. Generate models one at a time, then choose a model for each testimonial variation. Product ads can generate immediately.
5. Every A/B/C variation has two prompts. Pick 1-10 runs for each prompt, then run one prompt, the whole variation, or all currently-ready work.

## Agentic use (gen.mjs)

For one-off jobs (no panel, no config.json), drive generation straight through the bridge. Start the bridge once, then call `gen.mjs` per image. An agent runs these in order so a bad session or a typo is caught before any quota is spent.

```bash
# 0. Start the bridge (local job queue + disk writer on :8787). Leave it running.
node bridge.mjs

# 1. Readiness: bridge up, extension connected, logged in. Exits 4 if not ready.
node gen.mjs --health

# 2. Dry-run: validate the job (refs exist, out under Downloads, prompt non-empty)
#    without generating. Prints the resolved job.
node gen.mjs --dry-run --prompt "A close product-in-hand iPhone shot of the mousse" \
             --out ~/Downloads/run/01-mousse.png --aspect 16:9

# 3. Generate one image (waits for the file, prints a JSON result).
node gen.mjs --prompt "A close product-in-hand iPhone shot of the mousse" \
             --out ~/Downloads/run/01-mousse.png

# 4. Read the run manifest written next to the output.
cat ~/Downloads/run/01-mousse.manifest.json
```

More invocations:

```bash
# Reference images (order maps to @img1, @img2, ...) and 4 variations:
node gen.mjs --prompt "Replace the person using the attached reference" \
             --refs ~/Downloads/refs/face.png,~/Downloads/refs/layout.png \
             --out ~/Downloads/run/02-face.png --variants 4

# Aspect ratio: 16:9 / 9:16 / 4:5 / 5:4 / 4:3 / 3:4 / 1:1 / auto (default auto).
node gen.mjs --prompt "Wide hero banner" --aspect 16:9 --out ~/Downloads/run/03-hero.png

# Enqueue a whole list in one call instead of one prompt per invocation.
node gen.mjs --jobs ~/Downloads/run/batch.json

# Check the queue, or fire and forget (do not block on the file).
node gen.mjs --status
node gen.mjs --prompt "..." --out ~/Downloads/run/04.png --no-wait

# Abort every in-flight run (next enqueued job still runs normally).
node gen.mjs --abort
```

Plumbing-only smoke test (no generation, no quota), run after a code change:

```bash
node tests/agentic-smoke.mjs
```

Notes:
- `--out` must live under `~/Downloads` so every variation lands in the same folder (variant 1 is written by the bridge, the rest by Chrome's downloader, which is rooted at Downloads).
- `--wait` is the default: `gen.mjs` polls until the job settles, waits for the files, then prints `{ ok, name, done, expected, files }` and exits non-zero on failure. Pass `--no-wait` to return immediately after enqueueing.
- Every run writes `<outdir>/<name>.manifest.json` with name, prompt, aspect, variants, refs, files, chatUrl, status, error, errorCode, and timing. On failure, `errorCode` is one of `NOT_LOGGED_IN | REFUSED | RATE_LIMITED | TIMEOUT | NO_IMAGE | UPLOAD_FAILED | DOWNLOAD_FAILED | UNKNOWN`, so an agent branches instead of blind-retrying.
- Exit codes: `0` ok, `1` usage error or bridge unreachable, `2` timeout, `3` job failed, `4` not ready.
- `--port` overrides the bridge port (default 8787).
- See `docs/DESIGN.md` for the full health and manifest contract.

## How it drives ChatGPT (background-tab model)

The extension never touches the tab you are looking at. When work arrives it opens its OWN background `chatgpt.com` tab (or reuses one it opened earlier), attaches the references, types the whole prompt as ONE message, submits once, and captures the rendered image. Requirements:

- You must be logged into `chatgpt.com` in Chrome. The extension uses your real session, so images render normally and the run counts against your normal ChatGPT image quota.
- You do NOT need to keep a ChatGPT tab focused or even open for `gen.mjs` runs: the extension opens its own background tab on demand and reclaims idle ones afterward. (The side panel still drives the active session as before.)
- It sizes its tab pool to demand: a single `gen.mjs` job opens one background tab; a real batch scales up to the cap, with staggered starts to stay under rate limits.

## Aborting a run

```bash
node gen.mjs --abort                          # or:
curl -s -XPOST localhost:8787/command -d '{"type":"abort"}'
```

Abort clears the bridge queue and signals the extension on its next poll to stop every in-flight ChatGPT tab. It is not a permanent stop: the next job you enqueue runs normally. The side panel's red Stop button does the same thing for panel runs.

## Jobs format
```json
[
  { "name": "IMG02_b1_Educational_NATIVE_mousse_A", "product": "mousse",
    "prompt": "A close product-in-hand iPhone shot ..." },
  { "name": "IMG04_face_cand1", "face": true,
    "prompt": "Using the attached reference image, replace the entire person ..." }
]
```
- `name` is the chat name; ImageGen records a unique job key and destination for every run.
- `product` (optional): `mousse | saltspray | texturepowder | clay` attaches that stored ref.
- `face: true` (optional): attaches the model-faces digital ref.
- `aspect` (optional): `16:9 | 9:16 | 4:5 | 5:4 | 4:3 | 3:4 | 1:1 | auto`. `auto` (the default) stays ratio-neutral; any other value is appended to the same one message as the ratio instruction.
- `size` (optional): defaults to square.
- `refs` may be inline `{ dataUrl, name }` or `{ path }` (the bridge reads the file off disk, so you can enqueue tiny path payloads).

## Notes
- Keep the ChatGPT tab open while it runs (it drives that tab).
- Files are saved under `Downloads/<brand>/<batch>/models/<ad>/<model>/` or `Downloads/<brand>/<batch>/ads/<ad>/<variation>/<prompt>/`.
- Click a reference, model, or result thumbnail to expand it. Resetting a model also clears only the final runs that used that model; resetting a variation clears only that variation. Resets never delete saved files or ChatGPT chats.
- It is serial on purpose (no rate-limit collisions). Pace stays under ChatGPT's limits.
- Testimonials: generate the plain selfie/face here, then composite the tweet card separately (static-factory `tweet_composite.mjs`). Do not ask ChatGPT for a fake screenshot.
- Skip the design ads (Callout HYBRID, Before & After DESIGNED). This tool is for photos.
- The panel has an **Aspect** selector (next to Brand and Batch). It defaults to Auto, which keeps the old behavior; pick a ratio to apply it to every job that run.

## Build notes

- **Build 3**: Agentic single-shot driver (gen.mjs) with `--aspect`, `--jobs`, `--status`, `--abort`, `--wait`. Owned background tabs (never the foreground tab), demand-sized tab pool, one-message sends, HTTP abort, refs-by-path. Panel Aspect selector. Design doc at `docs/DESIGN.md`.
- **Build 4**: Agentic hardening. `gen.mjs --health` (readiness) and `--dry-run` (validate without generating), with exit codes `0/1/2/3/4`. Per-run manifest (`<name>.manifest.json`) with chatUrl and a typed `errorCode` taxonomy. Bridge `GET /health` and `POST /ping`; `/status` now carries per-job chatUrl and freshness stamps. Non-generating smoke test at `tests/agentic-smoke.mjs`.
- **Build 5 (v1.2.6)**: Launch polish. Home dashboard by default (general agentic frontend with live Bridge/Extension/ChatGPT status, brand loading is now an explicit step). Exact image counts (in-chat loop generates N takes per prompt with per-slot retry, N means N). Product registry (`products.json` + `products.mjs`) so prompts size products correctly. Anti-freeze: small corner worker window, SW heartbeat poking active tabs every 22s, and an audible (19 kHz, inaudible to people) keepalive so hidden tabs are not frozen by Chrome. Chat renaming hardened. Stronger reference-identity lock in prompts.
