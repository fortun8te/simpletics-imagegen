# NEUEGEN Studio — Creative OS Brief

> **Status:** Pre-build spec. Research-backed. Codebase-audited Jul 2026.  
> **North star:** Brief or competitor ref → planned spec → generated images → designed comp → Figma-ready layers.  
> **Hard problems (order):** Design mode → Deep planning → UGC/native compositing.

---

## TLDR

NEUEGEN Studio is **70% built**. Images mode works. Plan mode is a **read/edit spec UI with no brain**. Design mode is an **empty shell**. TrendTrack is **unwired**. Faces exist in config but **don't flow into generation**.

**Do not fine-tune an ad LLM.** Ship taste via **cached retrieval + scoring + visible agents + template compositor**. Fine-tuning is Phase 4+ optional.

**Build order:** Phase 0 (TrendTrack cache + ref fix) → Phase 1 (Plan thinks) → Phase 2 (Design MVP) → Phase 3 (agentic design) → Phase 4 (taste layer).

---

## System map

```
                    ┌─────────────────────────────────────────┐
                    │           EXTERNAL INPUTS               │
                    │  Brief · Brand kit · TrendTrack ads     │
                    │  Competitor URL · Saved ref sets        │
                    └─────────────────┬───────────────────────┘
                                      │
                    ┌─────────────────▼───────────────────────┐
                    │  PLAN (thinking — NOT BUILT)              │
                    │  Agent: classify · rank refs · write spec │
                    │  Output → config.json (prompts, refs)   │
                    └─────────────────┬───────────────────────┘
                                      │
                    ┌─────────────────▼───────────────────────┐
                    │  IMAGES (BUILT)                         │
                    │  Codex worker · queue · revise · export │
                    └─────────────────┬───────────────────────┘
                                      │
                    ┌─────────────────▼───────────────────────┐
                    │  DESIGN (NOT BUILT)                     │
                    │  Scene graph · templates · captions     │
                    │  Export → PNG + Figma clipboard layers  │
                    └─────────────────────────────────────────┘
```

**Bidirectional flows (Plan must support both):**

| Direction | Input | Output |
|-----------|-------|--------|
| Brief → refs | Angle + ad type + brand | Ranked cache hits from TrendTrack |
| Refs → brief | 1–3 competitor ads | Hypothesis, hooks, gen prompts |
| Brand-aware | Your approved ads | Nearest-neighbor in competitor corpus |
| Image → design | Done slot + ad type | Template + copy layers |

---

## What already exists (codebase audit)

### Shipped ✅

| Area | Key files | Notes |
|------|-----------|-------|
| **Images pipeline** | `lib/worker.mjs`, `lib/gen.mjs`, `lib/jobstore.mjs`, `lib/state.mjs` | Queue, pause, cooling, revise, archive, ZIP export |
| **Images UI** | `GridView`, `SlotCard`, `DetailDrawer`, `GenerateDialog`, `ActivityDock` | Per-slot lifecycle, drag-reorder queue, schedule (now/30m/1h) |
| **Plan UI** | `PlanView.tsx`, `batchPlan.ts`, `AdSection`, `RefLightbox` | Ads → variations → prompts; inline `patchPrompt`; ref strips; search |
| **Server** | `studio-server.mjs`, `api.ts`, `INTERFACES.md` | REST + SSE `:8788`; zero npm deps on backend |
| **UI shell** | `theme.css`, `AppAura`, `AppShell`, `TopBar`, `Sidebar` | Glass dark SaaS, light mode, Geist + Fraunces |
| **Codex gen** | `lib/gen.mjs` → `chatgpt-imagegen.py` | Usage caps via `lib/usage.mjs`, bridge `:8787` |
| **Faces (display)** | `batchPlan.ts` `kind:'face'`, `ModelsPool` in PlanView | Thumbs from `{brand}/{batch}/models/{adId}/{modelId}/run-1.png` — display-only, no picker to set `variation.model` |
| **Export ZIP** | `lib/exportBatch.mjs`, `GET /api/export/batch` | Batch render download |
| **Usage chip** | `UsageChip.tsx` in Sidebar | Codex quota ring — extend for TrendTrack in Phase 0.6 |
| **Keyboard** | `useKeyboardShortcuts.ts` | ⌘E export, 1/2 mode switch, `/` search |
| **Mode tabs** | `BatchView.tsx`, `TopBar.tsx` | Plan / Images / Design routed |

### Gaps ❌

| Gap | Evidence |
|-----|----------|
| **No Plan thinking** | No `/api/plan`, no agent loop, no LLM routes |
| **Design empty** | `DesignView.tsx` → `EmptyState` only |
| **No TrendTrack** | Zero references in repo; no MCP/REST wrapper |
| **Refs not in gen** | `enqueueSlot` only attaches tube + revise refs — not product/layout/model |
| **No face gen API** | Studio assumes `run-1.png` exists; generation is external |
| **PromptRecipe unused** | Types + chip UI exist; no block library tool |
| **`api.addPrompt` orphaned** | Server route exists, no UI |

### Critical code fact (refs gap)

`buildPromptRefs()` in `studio-server.mjs` resolves product, layout, model, extra, tube for **display**.  
`enqueueSlot()` only passes refs when `refsOverride` (revise) or tube shot:

```262:272:studio/studio-server.mjs
function enqueueSlot(...) {
  ...
  const baseRef = isTubeShot(promptText) ? tubeRefPath() : null;
  const refs = (Array.isArray(refsOverride) && refsOverride.length)
    ? refsOverride.filter(Boolean)
    : (baseRef ? [baseRef] : []);
```

**Phase 0.4 fixes this** — map display refs to disk paths for `gen.mjs -i`.

### Related repo assets (outside studio/)

| Asset | Path | Relevance |
|-------|------|-----------|
| NanoX config | `config.json` | Brands, batches, ads, face kinds, prompts |
| Arthritis listicle | `nanox-arthritis-listicle/` | COPY.md, IMAGE-PLAN.md, SLOT-MAP.md — real brief example |
| Shopify reskin | `~/Downloads/liquid-reskin/arthritis/` | Liquid sections + preview — Design export target pattern |
| Skills harness | `~/.claude/skills/` | `nanox-batch`, `ugc-faces`, `model-faces`, `liquid-reskin`, `imagead`, `meta-ad-compliance` |

These skills are the **current harness**. Studio should eventually call the same logic in-process, not require external Claude.

---

## TrendTrack — pre-research

**Docs:** https://docs.trendtrack.io/en/docs  
**MCP:** `https://api.trendtrack.io/v1/mcp`  
**Agent guide:** `https://docs.trendtrack.io/docs/agent-guide.md`  
**Auth:** `Authorization: Bearer $TRENDTRACK_API_KEY` in env — never commit.

### Credits model (verified)

| Rule | Detail |
|------|--------|
| **1 credit = 1 returned row** | Not per HTTP request |
| **10,000/month** | Recurring on active plans; top-ups carry over |
| **`GET /v1/usage`** | Free — call at every agent boot |
| **Headers** | `X-Credits-Remaining`, `X-Usage-Cost`, `X-Credits-Used`, `X-Credits-Source` |
| **402** | `insufficient_credits` — stop loops before hitting this |
| **Cost control** | Small `limit` (10–25); never paginate until empty in dev |

### MCP tools (11 — use sparingly)

High-value for NEUEGEN: `lookup`, `scan_ad`, `brief_competitor`, `analyze_tracked_brand`, top-ads rankings, workspace favorites.

**Rule:** TrendTrack is **ingestion**, not runtime UI. Cache everything.

### Credit budget (~10k/month)

| Operation | Credits | When |
|-----------|---------|------|
| Boot check | 0 | Every session |
| Brand lookup + top 20 ads | ~25 | Once per competitor, cache 7d |
| Single ad scan | ~1–5 | Manual, on import |
| Competitor brief | ~50–100 | Rare, manual |
| Plan iteration | **0** | Read local cache only |
| **Monthly reserve** | ~8,000+ | Headroom |

### Cache architecture

```
POST /api/trendtrack/import  ──metered──►  TrendTrack API
         │                                      │
         ▼                                      ▼
studio/.state/trendtrack-cache/
  index.json          # brand → ad ids
  ads/{id}.json       # hook, angle, format, platform, verdict
  images/{id}.jpg     # local copy (URLs expire)
         │
         ▼
Plan agent tools (0 credits): search_cached_refs, get_ad, list_brands
```

### Cache record schema

```json
{
  "id": "ad_xxx",
  "brand": "gymshark",
  "source_url": "https://...",
  "hook": "...",
  "angle": "...",
  "primary_text": "...",
  "format": "1:1",
  "aspect": "1080x1080",
  "platform": "meta",
  "media_type": "image",
  "scaling_verdict": "scaling",
  "local_image": "images/ad_xxx.jpg",
  "tags": ["native", "ugc"],
  "fetched_at": 1710000000,
  "credits_paid": 1
}
```

---

## The three hard problems

### 1. Design mode (hardest — net new product surface)

**Goal:** Launch-ready ad comps — overlays, headlines, CTAs, native captions — exportable as **real Figma layers**, not flat PNGs.

**What it's NOT:** MagicPath environment clone. Screenshot-only export. Full Figma replacement.

#### Architecture decision: Scene graph + HTML render

| Layer | Choice | Why |
|-------|--------|-----|
| **Document model** | JSON scene graph | Agents edit structure, not pixels; diffable, serializable |
| **Renderer** | React DOM (absolute layout) | Matches existing stack; easy HTML→Figma path |
| **Templates** | 5 starter layouts | Native, static offer, testimonial, carousel frame, TrendTrack static overlay |
| **Export** | HTML preview → Figma MCP clipboard | Free Figma Starter; no Enterprise API |
| **Alt export** | PNG + JSON sidecar | Fallback when Figma unavailable |

#### Scene graph shape (v1)

```json
{
  "id": "comp_001",
  "template": "native-caption",
  "canvas": { "w": 1080, "h": 1080 },
  "layers": [
    { "type": "image", "src": "/img?path=...", "fit": "cover" },
    { "type": "text", "role": "headline", "text": "...", "box": { "x": 40, "y": 800, "w": 1000, "h": 120 }, "style": "headline" },
    { "type": "text", "role": "caption", "text": "...", "box": { ... }, "style": "body" },
    { "type": "badge", "text": "60% OFF", "box": { ... } }
  ],
  "safeZones": ["face", "product"],
  "adType": "native"
}
```

#### Design mode UI (fits existing shell)

```
┌──────────────┬─────────────────────────┬──────────────┐
│ Layer tree   │ Canvas preview          │ Properties   │
│ + templates  │ (live render)           │ + agent log  │
├──────────────┴─────────────────────────┴──────────────┤
│ Export: Copy Figma layers · PNG · JSON                │
└───────────────────────────────────────────────────────┘
```

#### TrendTrack statics in Design

Cached competitor ad image = **base layer**. Agent adds brand copy, CTA, badges on top. Not recreating the photo — **compositing**.

#### Figma export paths (researched)

| Method | Cost | Fidelity |
|--------|------|----------|
| **Figma MCP** `generate_figma_design` → clipboard | Free account | Real layers from live HTML |
| **HTML→Figma plugins** (e.g. claude-design-x-figma) | Free | DOM → auto-layout nodes |
| **PNG only** | Free | ❌ Not acceptable as primary |

#### Phase 2 deliverables

- [ ] `DesignView.tsx` — three-panel layout
- [ ] `lib/sceneGraph.ts` — types + validators
- [ ] `components/design/Canvas.tsx` — renderer
- [ ] `components/design/TemplatePicker.tsx` — 5 templates
- [ ] `POST /api/design/save`, `GET /api/design/:id`
- [ ] `POST /api/design/export` — PNG + JSON + HTML bundle
- [ ] Figma clipboard export (manual trigger, document steps)

---

### 2. Deep planning (second hardest — brain for Plan mode)

**Goal:** All creative thinking happens **inside Plan tab**. No external Claude session required.

**What it's NOT:** A chat window bolted on. Invisible backend-only agent.

#### Planner agent spec

| Property | Value |
|----------|-------|
| **Count** | 1 primary planner (Phase 1); max 2 parallel in Phase 3 |
| **Visibility** | 100% — every tool call shown in sidebar stream |
| **Step cap** | Hard limit 15 steps per run |
| **Model** | Frontier for brief writing; rules/embeddings for classify + rank |
| **Output** | Writes to `config.json` via existing `/api/prompt/patch` + new routes |

#### Tool surface (Phase 1)

| Tool | Credits | Description |
|------|---------|-------------|
| `get_usage` | 0 | TrendTrack balance check |
| `search_cached_refs` | 0 | Filter cache by brand, format, angle, ad type |
| `import_refs` | metered | Trigger cache import (user confirms cost) |
| `classify_ad_type` | 0 | native / static / offer / carousel / ugc |
| `write_hypothesis` | 0 | Angle + hook + format recommendation |
| `write_prompt` | 0 | Gen prompt using nanox-batch wrapper rules |
| `attach_refs` | 0 | Set product/layout/model refs on variation |

#### Ad-type routing (classify before everything else)

| Type | Plan writes | Design template | Gen notes |
|------|-------------|-----------------|-----------|
| `ugc` / `native` | caption, hook, primary text | minimal chrome | ugc-faces; F1/F2 camera |
| `static` | headline hierarchy, layout ref | overlays, badges | layout ref required |
| `offer` | offer frame, CTA copy | price strip, CTA button | — |
| `carousel` | slide sequence | multi-frame | per-slide prompts |
| `face` | model id or generate new | face safe zone | model ref → codex |

#### Bidirectional flow examples

**Brief → refs:** User writes "morning stiffness angle for arthritis UGC" → agent searches cache `tags:ugc` + semantic match → returns top 12 with hooks → user picks 3.

**Refs → brief:** User picks 2 scaling competitor natives → agent `scan_ad` (cached) → outputs hypothesis + 3 prompt variants → writes to config batch.

#### Existing harness to internalize (Phase 1.5+)

| Skill | Studio equivalent |
|-------|-------------------|
| `nanox-batch` | Prompt wrapper + recipe blocks in Plan |
| `ugc-faces` / `model-faces` | Face library + gen triggers |
| `meta-ad-compliance` | Pre-export copy lint in Design |
| `imagead` | Ugly-ad formula for static slots |

---

### 3. UGC / native design (third — cross-cuts Plan + Design)

**Goal:** Handle the full ad spectrum — ugly UGC natives, designed statics, offer cards — not one template.

#### Faces pipeline

| Type | Use | Source | Studio action |
|------|-----|--------|---------------|
| **UGC** | Native, testimonial | Invented (`ugc-faces` rules) | Face library + gen API |
| **Editorial model** | Lifestyle, product | `model-faces` digitals | Model pool in Plan |
| **Competitor ref** | Style only | TrendTrack cache | Optional face-blur; never copy identity |

#### Gaps to close

- [ ] `GET /api/faces` — list library renders
- [ ] `POST /api/faces/generate` — enqueue face slot (or call codex directly)
- [ ] Plan: face picker → sets `variation.model`
- [ ] Phase 0.4: model ref path → codex `-i`
- [ ] Design: safe zones when `adType` includes face
- [ ] Native: 3 caption variants → pick one → Design layer

#### Real brief example in repo

`nanox-arthritis-listicle/IMAGE-PLAN.md` documents the exact problem Design + Plan must solve: copy moved to arthritis, imagery didn't; priority swaps (r3 morning hands, hero 2x2, 3x3 grid); KEEP vs SWAP matrix. **Use this as Phase 1 acceptance test.**

---

## Model routing (research conclusion)

| Task | Model class | Phase | Rationale |
|------|-------------|-------|-----------|
| Ad-type classify | Rules + small LLM | 1 | Fast, cheap, good enough |
| Ref rank | Embeddings + rerank | 1 | No fine-tune needed |
| Brief / hypothesis | Frontier | 1 | Quality matters |
| Prompt wrap | Template (nanox-batch rules) | 1 | Deterministic > LLM |
| Layout agent | 7–9B VLM | 3 | Moves layers on scene graph |
| Pixel gen | Codex (existing) | Now | Already works |
| Taste fine-tune | Custom | 4+ | Only after feedback data exists |

**Small model agents (Phase 3):** VLM navigates structured JSON canvas (not freeform pixels). User sees agent card: `thinking → move_layer → verify`. Max 2 parallel. Hard 10-step cap per agent.

**Do not pursue:** End-to-end 9B model doing strategy + design + gen at frontier quality.

---

## Taste layer (Phase 4 — not V1)

How taste gets "in" without copying competitors:

1. **Retrieval index** — your approved ads + rejected pairs
2. **Scorer** — on-brand / format-fit / novelty (LLM or learned reranker)
3. **Constraint prompts** — "same energy, not same layout"
4. **Feedback loop** — thumbs on Plan refs, Images, Design → weight cache rankings

Fine-tuning on competitor corpus alone = **copy risk + rights issues**. Defer until you have YOUR approve/reject dataset.

---

## Build phases

### Phase 0 — Foundation (1–2 weeks) ← START HERE

**Goal:** TrendTrack wired + cached. Refs flow to codex. Zero UI polish.

| # | Task | Files |
|---|------|-------|
| 0.0 | Gitignore | Add `.env` to `studio/.gitignore` (not gitignored today) |
| 0.1 | Env + REST client | `studio/.env`, `studio/lib/trendtrack.mjs` |
| 0.2 | Cache layer | `studio/lib/trendtrack-cache.mjs`, `studio/.state/trendtrack-cache/` |
| 0.3 | API routes | `studio-server.mjs` — `/api/trendtrack/*` |
| 0.4 | Ref fix | `enqueueSlot` — map `buildPromptRefs` → disk paths for `gen.mjs -i` |
| 0.5 | Smoke script | `scripts/trendtrack-smoke.mjs` (repo root, alongside `validate-config.mjs`) |
| 0.6 | Usage chip | Extend existing `UsageChip.tsx` — TrendTrack credits alongside Codex |

**Exit criteria:**
- [ ] `GET /api/trendtrack/usage` returns balance
- [ ] One brand imported, images on disk, cache read = 0 credits
- [ ] Face ad generate passes model ref to codex
- [ ] Smoke test burns **< 50 credits**

**NOT in Phase 0:** Plan agent, Design canvas, Figma, face gen API, fine-tuning.

---

### Phase 1 — Plan thinks (2–3 weeks)

**Goal:** Brief ↔ refs ↔ ad-type inside Plan. No external Claude.

| # | Task |
|---|------|
| 1.1 | Ref import panel in PlanView (from cache) |
| 1.2 | Ad-type tag on each ad row |
| 1.3 | Planner sidebar — visible agent stream |
| 1.4 | `/api/plan/run` — agent endpoint with step cap |
| 1.5 | Brief → refs and refs → brief flows (manual triggers) |
| 1.6 | Face library picker |
| 1.7 | PromptRecipe block chips → editable (optional) |

**Acceptance test:** Run arthritis listicle brief from `IMAGE-PLAN.md` entirely inside Plan — hypothesis, ref picks, prompts written to config, no external session.

**KPI:** Brief → approved plan < 20 min; external Claude sessions → 0.

---

### Phase 2 — Design MVP (3–4 weeks)

**Goal:** Image → export-ready comp with Figma path.

| # | Task |
|---|------|
| 2.1 | Scene graph types + validator |
| 2.2 | DesignView three-panel UI |
| 2.3 | 5 templates (native, static, offer, testimonial, carousel) |
| 2.4 | Base layer from generated image OR TrendTrack cache |
| 2.5 | Text/badge/CTA editing |
| 2.6 | Export PNG + JSON + HTML bundle |
| 2.7 | Figma clipboard workflow (documented + tested once) |

**KPI:** Image → Figma-ready comp < 15 min.

---

### Phase 3 — Agentic design (4–6 weeks)

- Small VLM moves layers on scene graph
- Visible parallel agents (max 2)
- Auto-template from ad-type
- Batch design — apply template across N images

---

### Phase 4 — Taste layer (ongoing)

- Approve/reject feedback → retrieval weights
- Brand embedding index
- Optional fine-tune on YOUR corpus only

---

## What's explicitly NOT realistic (defer)

| Idea | Why not |
|------|---------|
| Fine-tuned "ad LLM" from competitor DB | Copy risk, rights, cost, no taste signal |
| MagicPath replacement with full design tool | Build template compositor instead |
| Live TrendTrack on every UI click | Credit death at 10k/mo |
| 9B model doing full pipeline at frontier quality | Use for layout nav only |
| Full Figma sync without Figma account | Need free Starter minimum |
| 40 parallel sub-agents | Max 2–3 with step caps |

---

## KPIs

| Metric | P0 | P1 | P2 |
|--------|----|----|-----|
| TrendTrack credits per workflow | < 50 | < 150 | < 50 (cached) |
| External Claude for planning | — | 0 | 0 |
| Ref relevance (you rate 1–5) | — | > 3.5 | > 4 |
| Image → export-ready design | — | — | < 15 min |
| Agent steps visible | — | 100% | 100% |
| Arthritis IMAGE-PLAN runnable in-app | — | ✅ | ✅ |

---

## Agent execution rules (all phases)

1. Call `GET /v1/usage` before any metered TrendTrack work
2. Never paginate cache imports without user confirm + cost estimate
3. Max 15 agent steps per Plan run; max 10 per Design agent
4. Every step emits UI event (SSE `plan` / `design` channel)
5. Output artifacts to disk — never only in chat
6. Stop and report if credits < 500 remaining

---

## Security

- `TRENDTRACK_API_KEY` in `studio/.env` only — add to `.gitignore` in Phase 0.0 (not ignored today)
- Rotate key if ever exposed in chat
- Competitor ad images: local cache only; don't redistribute

---

## Appendix: key file index

| Purpose | Path |
|---------|------|
| Brief (this file) | `studio/BRIEF.md` |
| API contract | `studio/lib/INTERFACES.md` |
| Studio spec | `studio/PLAN.md` |
| Plan data layer | `studio/src/lib/batchPlan.ts` |
| Ref builder (server) | `studio/studio-server.mjs` `buildPromptRefs` |
| Gen enqueue | `studio/studio-server.mjs` `enqueueSlot` |
| Design placeholder | `studio/src/components/views/DesignView.tsx` |
| Config | `config.json` |
| Arthritis example | `nanox-arthritis-listicle/IMAGE-PLAN.md` |
| Shopify target | `~/Downloads/liquid-reskin/arthritis/` |
