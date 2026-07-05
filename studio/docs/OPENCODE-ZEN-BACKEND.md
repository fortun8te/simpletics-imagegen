# OpenCode Zen backend — better copy-from-reference for free

**Why:** copy-from-reference is only as good as the model that *reads* the ad. Local ornith-9b is
the bottleneck (small, slow: 2–43 min/ad, and it "lets things go" — hallucinates elements, forces
the wrong archetype). OpenCode Zen (https://opencode.ai/zen) is a hosted OpenAI-compatible gateway
whose **free** `mimo-v2.5-free` model is **vision-capable with a ~200k context window** — a real
upgrade for both the extraction (eyes) and the multi-pass reasoning (brain).

Our LLM layer is already provider-agnostic (OpenAI-compatible base URL + Bearer key), so this is
pure configuration — no code fork.

## Setup (3 steps)

1. **Get a key:** sign in at https://opencode.ai/auth, copy the API key. *(I never handle your key
   — you paste it in yourself.)*

2. **Put it in `studio/.env`:**
   ```
   OPENCODE_ZEN_API_KEY=sk-...
   VISION_BASE_URL=https://opencode.ai/zen/v1
   VISION_MODEL=mimo-v2.5-free
   VISION_API_KEY=${OPENCODE_ZEN_API_KEY}
   LLM_BASE_URL=https://opencode.ai/zen/v1
   LLM_MODEL=mimo-v2.5-free
   LLM_API_KEY=${OPENCODE_ZEN_API_KEY}
   ```
   (`.env` doesn't expand `${...}` by itself — paste the actual key into all three `*_API_KEY`
   lines, or export `OPENCODE_ZEN_API_KEY` in your shell before launching.)

3. **Confirm it works before a big run:**
   ```
   node scripts/probe-vision-backends.mjs
   ```
   It sends a real ad image to each free model and reports which actually see it, plus latency.
   `mimo-v2.5-free` should come back **VISION OK ✅**. This catches a rate cap or a wire-format
   quirk *before* you spend hours on a sweep.

## What each var controls

| var | routes | notes |
|-----|--------|-------|
| `VISION_*` | extraction + the render↔reference self-check | the eyes — must be a vision model |
| `LLM_*` | the agent's reasoning / copy-fix / layout passes | the brain — can be the same model |

Set only `LLM_*` (leave `VISION_*` on local ornith) for a **hybrid**: ornith's eyes + a stronger
remote brain. Set both for full remote. Comment all out to return to 100% local ornith (the
default — nothing breaks).

## More passes

`COPY_IMPROVE_PASSES` (env) sets the self-improve loop's max scoring rounds (default 5, tuned for
slow local ornith). A fast remote model can afford more:
```
COPY_IMPROVE_PASSES=10
```

## Honest caveats

- **Free-tier limits.** A full 128-ad sweep at 10 passes each is thousands of vision calls; the
  free tier may throttle or queue. The probe's latency numbers tell you if it's viable at scale;
  if it throttles, drop the pass count or sweep in smaller batches.
- **Data policy.** Zen's free models may use submitted data to improve the model. These ads are
  marketing creative (not confidential), but know that it leaves your machine — unlike local
  ornith, which never does.
- **Vision wire-format.** `mimo-v2.5-free` is confirmed vision-capable; the probe verifies the
  exact OpenAI `image_url` content-array format is accepted by Zen's endpoint specifically.
- **Not committed.** These are `.env` values — nothing is hardcoded; local ornith stays the
  shipped default.
