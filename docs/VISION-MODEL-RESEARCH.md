# Vision Model Research — READER for the studio reconstruction pipeline

**Date:** 2026-07-05
**Goal:** best + cheapest vision model for precision ad/design reading: verbatim text transcription, accurate bounding boxes ("grounding"), font/color/size perception. Consumed by `studio/lib/llm.mjs` (OpenAI-compatible, any base URL + key).

**Data sources:** `https://openrouter.ai/api/v1/models` + per-model `/endpoints` (fetched 2026-07-05, 340 models, 168 image-input), HuggingFace model cards (Qwen3-VL, MiMo-V2.5, GLM-4.6V — fetched live), Anthropic pricing via the claude-api reference (cached 2026-06-24). Benchmark claims are from vendor model cards unless noted — marked **unverified** where I could not confirm numbers independently.

**Cost model per ad read:** ~1600 image tokens + ~1200 prompt tokens input, ~2500 output tokens.
`cost = 2800 × $in/1M + 2500 × $out/1M`. Where OpenRouter exposes a `pricing.image` field (Gemini models), it matches the per-token input rate, so the same formula holds; for everyone else image tokens bill at the input-token rate. OpenAI's tile-based image tokenization may deviate from the flat 1600-token estimate (unverified exact count per image).

---

## Ranked table (relevance-filtered, cheapest-viable first)

| # | Model (OpenRouter id) | $/1M in | $/1M out | est. $/ad read | Grounding (bbox) evidence | Verbatim text / OCR evidence | Availability |
|---|---|---|---|---|---|---|---|
| 1 | `qwen/qwen3-vl-32b-instruct` | 0.104 | 0.416 | **$0.0013** | Model card: "stronger 2D grounding… 3D grounding", spatial perception, GUI element recognition. Qwen VL line has published RefCOCO/grounding numbers since 2.5-VL; Qwen3-VL emits absolute-pixel bboxes. | Card: OCR in 32 languages, "robust in low light, blur, tilt", long-document structure parsing. Qwen2.5-VL-72B scored ~885 OCRBench / ~96 DocVQA (prior gen; Qwen3-VL numbers unverified here). | Alibaba (1 provider — single point of failure) |
| 2 | `qwen/qwen3-vl-8b-instruct` | 0.117 | 0.455 | $0.0015 | Same family/claims as 32B, smaller. | Same card claims; expect a step down vs 32B on dense small text. | Alibaba, Parasail (2 providers) |
| 3 | `xiaomi/mimo-v2.5` (PAID) | 0.105 | 0.28 | **$0.0010** | OR description: "surpasses MiMo-V2-Omni in multimodal perception across image and video". MiMo-VL-7B (earlier gen) published strong ScreenSpot GUI-grounding results; MiMo-V2.5 grounding format **unverified** — but it is the exact model the pipeline already runs, so its behavior is empirically known in-repo. | Empirically proven in this repo as the current reader (via free pool). | DigitalOcean/Xiaomi/Parasail/Venice/DeepInfra (5 providers — best redundancy of the cheap tier) |
| 4 | `qwen/qwen3.5-flash-02-23` | 0.065 | 0.26 | $0.0008 | "Native vision-language" hybrid-attention family; grounding claims not in OR blurb — **unverified**. | Qwen house OCR pedigree; specific numbers unverified. | Alibaba |
| 5 | `bytedance-seed/seed-1.6-flash` | 0.075 | 0.30 | $0.0010 | Multimodal deep-thinking; grounding **unverified**. | Doc understanding claims only. | ByteDance |
| 6 | `bytedance/ui-tars-1.5-7b` | 0.10 | 0.20 | $0.0008 | GUI-grounding *specialist* (ScreenSpot-class agent model, RL-trained on element localization). | Weak fit: agent model, not a transcription/design-description model. Niche second-opinion for box coordinates only. | ByteDance |
| 7 | `google/gemini-2.5-flash-lite` | 0.10 | 0.40 | $0.0013 | Google models return normalized 0-1000 bboxes on request; historically less precise than Qwen-VL on dense UI (community consensus, unverified benchmark). | Gemini OCR/doc reading is strong and reliable at this tier. | Google (2 endpoints) + AI Studio |
| 8 | `meta-llama/llama-4-scout` | 0.10 | 0.30 | $0.0010 | No grounding claims; Llama vision bbox output historically poor. | Mid OCR. Not recommended for this job. | multiple |
| 9 | `qwen/qwen3-vl-235b-a22b-instruct` | 0.20 | 0.88 | **$0.0028** | Flagship open VL. OR description explicitly: "document parsing, chart/table QA", VQA. Same grounding architecture as 32B, more capacity. | Best open-weights doc/OCR tier. | DeepInfra/Venice/Parasail/Alibaba/Novita (5 providers) |
| 10 | `z-ai/glm-4.6v` | 0.30 | 0.90 | $0.0031 | GLM-V line has native grounding tokens (`<|begin_of_box|>`) since 4.5V; card: SoTA visual understanding at scale, native multimodal function calling. | Card: 128K multimodal doc understanding, "text, layout, charts, tables jointly". | Novita, Z.AI |
| 11 | `openai/gpt-5-nano` | 0.05 | 0.40 | $0.0011 | OpenAI models do not reliably emit bboxes (well-known weakness). | Decent OCR for the price; "limited reasoning depth" per OR. | OpenAI |
| 12 | `openai/gpt-5.4-nano` | 0.20 | 1.25 | $0.0037 | Same bbox weakness. | Newer nano tier; OCR quality unverified. | OpenAI |
| 13 | `openai/gpt-5-mini` / `gpt-5.4-mini` | 0.25 / 0.75 | 2.00 / 4.50 | $0.0057 / $0.0134 | Same bbox weakness. | Good transcription. | OpenAI |
| 14 | `google/gemini-2.5-flash` | 0.30 | 2.50 | $0.0071 | As flash-lite, more capable. | Strong OCR/doc tier. | Google |
| 15 | `moonshotai/kimi-k2.5` | 0.375 | 2.025 | $0.0061 | "SOTA visual coding" (screenshot→code implies layout reading); bbox grounding unverified. | Visual-coding focus, plausible good design reading; unverified. | multiple |
| 16 | `anthropic/claude-haiku-4.5` | 1.00 | 5.00 | $0.0153 | Claude vision reads design/layout well qualitatively; no bbox-coordinate mode. | Very good verbatim transcription. | Anthropic |
| 17 | `anthropic/claude-sonnet-5` (direct API, single call) | 2.00* | 10.00* | $0.0306 | Best-in-class qualitative design perception, high-res vision (2576px); no native bbox coordinates. | Excellent. | Anthropic / OpenRouter |
| — | `nvidia/nemotron-nano-12b-v2-vl:free` | 0 | 0 | **$0** | "Document intelligence" video/doc model; grounding unverified. | Free-tier fallback only; expect rate limits. | free tier |

\* Sonnet 5 intro pricing ($2/$10 per MTok) runs through **2026-08-31**, then $3/$15 → $0.046/read direct.

### Incumbents (what we pay today)

| Incumbent | Mechanism | $/ad read | Problem |
|---|---|---|---|
| `mimo-v2.5-free` via 9router pool (`opencode-free-priority`) | free pool, `VISION_EXPECT_MODEL=mimo` guard rejects pool fallbacks | $0 | Rate-limited; pool serves text-only models under pressure (guard v2 exists precisely because of this); retries burn wall-clock time |
| Claude Sonnet 5 via agent reads | ~18k tokens/read (≈15.5k in + 2.5k out) at intro $2/$10 | **≈$0.056** (≈$0.084 after intro ends) | 40–60× the cost of a Qwen3-VL read |

The paid-API switch buys **~40×–56× cost reduction vs Sonnet agent reads** and removes the free-pool reliability tax for ~$1 per 1,000 ad reads.

---

## TOP 3 recommendation

### 1. READER — best quality-per-dollar: `qwen/qwen3-vl-32b-instruct` (~$0.0013/ad)
Only cheap-tier model with *explicit, first-party* grounding + 32-language OCR + GUI-element claims, at 32B scale for $0.104/$0.416. Caveat: single provider (Alibaba) on OpenRouter — if it flakes, `qwen/qwen3-vl-8b-instruct` (2 providers, ~$0.0015) is the same family one notch down.

```env
# studio/.env
VISION_BASE_URL=https://openrouter.ai/api/v1
VISION_MODEL=qwen/qwen3-vl-32b-instruct
VISION_API_KEY=<your openrouter key>
VISION_EXPECT_MODEL=qwen3-vl
```

### 2. JUDGE — render-vs-original comparison: `qwen/qwen3-vl-235b-a22b-instruct` (~$0.0028/ad)
Flagship open VL, 5 providers (rate-limit resilient), document/chart/table parsing named as a design goal. Escalation tier when the judge disagrees or the score is borderline: one `anthropic/claude-sonnet-5` direct call ($0.031) — still half a Sonnet agent read.

```env
VISION_BASE_URL=https://openrouter.ai/api/v1
VISION_MODEL=qwen/qwen3-vl-235b-a22b-instruct
VISION_API_KEY=<your openrouter key>
VISION_EXPECT_MODEL=qwen3-vl-235b
```

### 3. BUDGET FALLBACK — `xiaomi/mimo-v2.5` paid (~$0.0010/ad)
The exact model the pipeline already runs — zero prompt-tuning risk, empirically-known extraction behavior, and 5 paid providers. `VISION_EXPECT_MODEL=mimo` stays untouched. This is the lowest-risk switch: same brain, paid lane.

```env
VISION_BASE_URL=https://openrouter.ai/api/v1
VISION_MODEL=xiaomi/mimo-v2.5
VISION_API_KEY=<your openrouter key>
VISION_EXPECT_MODEL=mimo        # unchanged from today
```

---

## Wiring notes (from `studio/lib/llm.mjs`)

- A **remote** `VISION_BASE_URL` (non-localhost) + explicit `VISION_MODEL` takes the `remote-vision` fast path — no LM Studio probing. Just set the three vars above; also update `LLM_BASE_URL`/`LLM_MODEL`/`PREFERRED_MODEL` only if you want text calls off 9router too (OpenRouter serves both).
- `VISION_EXPECT_MODEL` is a **regex** matched (case-insensitive) against the response's `model` field. On OpenRouter the response model echoes the full id (e.g. `qwen/qwen3-vl-32b-instruct`), so `qwen3-vl` matches. Keep it set even on a single-model endpoint — it costs nothing and catches silent provider-side substitutions.
- OpenRouter is OpenAI-compatible (`/chat/completions`, `image_url` with data-URI base64) — no code changes needed; the existing `noVision` detection and reasoning-content salvage both apply as-is.
- Per-provider pricing varies on multi-provider models (e.g. mimo-v2.5: $0.105 DigitalOcean vs $0.40 DeepInfra). To pin costs, add OpenRouter's `provider` routing preference in the request body, or accept the default (price-sorted) routing which already favors the cheap endpoints.

## Honest caveats

- Qwen3-VL / MiMo-V2.5 / GLM-4.6V benchmark claims come from vendor model cards; independent ScreenSpot/OCRBench/RefCOCO numbers for these exact checkpoints were **not verifiable** from this environment (no web search). The Qwen grounding claim is the most concrete (architecture-level, consistent across the family's published history).
- The 1600-image-token estimate is a planning number; actual image tokens vary by resolution and per-vendor tokenization (Qwen ~28px patches, OpenAI tiles, Gemini fixed-per-image). At these prices the error bar is ±$0.001/read.
- No live quality test was run. Recommended next step: run the existing copy-harness (`studio/scratchpad-work/copy-harness/`) benchmark suite once per candidate (~$0.05 total for all three at these prices) and compare extraction JSONs against the incumbent before committing.
