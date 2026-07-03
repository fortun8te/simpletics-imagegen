# Harness research notes — design-agent v5

Evidence base for the v5 harness redesign (batched plan-act-verify loop). Collected 2026-07;
each claim links its source. Use this doc when tuning the loop — don't re-litigate settled
questions without new evidence.

## Techniques adopted (ranked by expected impact for a weak DeepSeek/local engine)

1. **Template retrieval + adapt, not from-scratch generation** — `lib/layout-library.mjs`.
   Training-free SOTA layout systems are retrieval-augmented ICL: retrieve similar layouts as
   exemplars and let the model *edit* a skeleton.
   LayoutGPT: https://arxiv.org/abs/2305.15393 · PosterO: https://arxiv.org/abs/2505.07843

2. **Best-of-N with a deterministic verifier** — `bestOfSeed()` in `lib/design-agent.mjs`.
   Test-time compute lets a 1B model beat a 405B when sampled against a verifier; our
   alignment/overlap/text-fit `layoutScore` is a free verifier.
   https://arxiv.org/abs/2408.03314

3. **Batched multi-op turns with immediate per-op feedback** — `runBatchAgent` in
   `lib/agent-harness.mjs`. SWE-agent's core ACI finding: consolidated edit commands with
   instant validated feedback beat granular per-line editing.
   https://arxiv.org/abs/2405.15793

4. **In-loop render/lint-then-verify** — lint findings appended as `LINT:` lines each turn;
   `done` gated on clean lint (or findings visible ≥2 turns). VASCAR reaches SOTA
   content-aware layout quality training-free with iterative self-correction.
   https://arxiv.org/abs/2412.04237 · tldraw Make Real: https://tldraw.dev/blog/make-real-the-story-so-far

5. **Layout-as-code with pretraining-aligned naming** — CSS vocabulary in ops/skeletons
   (`left/top/width/height`, `fontSize`). LayoutNUWA: >50% improvement over numeric tuples.
   Renaming fields to pretraining conventions alone: up to +17% tool accuracy.
   https://arxiv.org/abs/2309.09506 · https://arxiv.org/abs/2510.07248 · BannerAgency (blueprints → editable components): https://arxiv.org/abs/2503.11060

6. **Whole-state resend, NOT observation diffs.** Aider's edit-format data: diff formats are
   where weak models fail. An ad scene is 10–40 layers ≈ a few hundred tokens compact — resend
   it all, spend the savings on best-of-N.
   https://aider.chat/docs/more/edit-formats.html

7. **Surfaced guard rules ("HOUSE RULES")** — every coherence guard (grid snap, kit color
   snap, radius quantize, autoH, sizeLocked) is stated in the system prompt AND reported in
   per-op feedback, so the model works with the guards instead of re-sending ops that get
   silently corrected. (SWE-agent ACI principle applied to our deterministic repair layer.)

## Explicitly rejected

- **Observation diffs** (original v3 plan) — see #6.
- **Director → scoped workers → lint-fix rerun chain** (v3) — plan-then-execute does not beat
  ReAct-style loops for sub-10B models; wins come from harness intelligence (retrieval,
  verifiers), not loop topology. One loop, one budget. https://arxiv.org/html/2512.03560v1
- **Grammar-constrained decoding** — biggest single lever (+28pt tool-format accuracy on
  Qwen2.5-7B) but needs control of inference (llama.cpp/vLLM + llguidance). Revisit if a local
  endpoint becomes primary. https://openreview.net/forum?id=FKOaJqKoio · https://github.com/guidance-ai/llguidance

## Back-test / scoring design (level-6 inspo loop)

- Deterministic suite: alignment + overlap (https://arxiv.org/abs/2108.00871) + PosterLayout's
  occlusion/readability/utility trio (https://ar5iv.labs.arxiv.org/html/2303.15937) — all
  computable zero-dep from bboxes. Ours: `layoutScore` + `lintDesign` + `verifyDesign`.
- Reference matching for regressions: Design2Code-style bbox/text/color fidelity vs a gold
  scene. https://arxiv.org/abs/2403.03163
- Pass@k + judge tie-break: rank k candidates deterministically, send top-2 to a VLM judge
  (OpenCOLE: https://arxiv.org/abs/2406.08232). Opt-in `--vision` only — never the default gate.

## Current loop shape (v5)

```
turn := {"plan": one sentence, "ops": [1–4 validated ops], "done": bool}
feedback := per-op "ok: …(repaired: …)" / "FAILED op: why" lines → next turn
observation := full compact scene, re-sent every turn (~200–400 tok)
lint := in-loop, gates done (clean, or visible ≥2 turns)
budget := MAX_TURNS=8 global, 700 completion tok/turn; degraded mode = maxOpsPerTurn:1
generate := template seed → retrieval exemplars → best-of-3 (layoutScore) → ≤2 polish turns
captions := "draftText" op — in-loop copywriter with per-layer char budgets from real boxes
```
