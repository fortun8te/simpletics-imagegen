# NanoXtreme Arthritis — Image Plan (Phase 2)

Reviewed every image on the page (downloaded to `assets/originals/`). Verdict per image below.
Generation route: **nanox-batch → simpletics-imagegen → `runbatch.mjs --brand=nanox`** (free ChatGPT-web,
UGC realism wrapper, black NANO X tube auto-attached on product shots), anti-AI checked, then the new
file's Shopify CDN URL replaces the `src` in BOTH `preview/index.html` and `sections/*.liquid`.

## The core problem
Every people shot is the same: an older person (60s-70s) smiling, holding the tube, selfie-style.
Right demographic, zero arthritis. No stiff hands, no jar, no knee, no morning. The copy moved to
arthritis; the imagery didn't. Product + diagram shots are fine and stay.

## Full inventory

| # | File / role | What it is now | Verdict | Aspect |
|---|---|---|---|---|
| 1 | `hero_2x2-grid` (HERO) | 4 older people holding tube, selfie collage | **SWAP** | 1080x1080 |
| 2 | `r3_application` (Reason 3) | Squeezing cream onto a knee/leg on a couch | **SWAP (do first)** | 1080x1080 |
| 3 | `r4_3x3-grid` (Reason 4) | 9 older people holding tube collage | **SWAP** | 1080x1080 |
| 4 | `testi_joe` (Testimonial) | Older man, selfie + tube | Optional | 600x600 circle |
| 5 | `r4_dale` | Older man, selfie + tube | Optional | 120x120 circle |
| 6 | `r4_carol` | Older woman, selfie + tube | Optional | 120x120 circle |
| 7 | `r4_janet` | Older woman in car + tube | Optional | 120x120 circle |
| 8 | `r1_tube-ingredients` (Reason 1) | Black tube on grass | **KEEP** (product) | 1080x1080 |
| 9 | 6 ingredient icons | Menthol/Turmeric/etc. tiles | **KEEP** | 600x600 |
| 10 | `r2_cross-section` (Reason 2) | Diagram: "sinks deep to the muscle and joint" | **KEEP** (already on-message) | 1080x1080 |
| 11 | `r5_guarantee` (Reason 5) | Older woman + tube + 60-day badge | **KEEP** (badge/product) | 1080x1080 |
| 12 | `offer_tube` (Offer) | Clean black tube render | **KEEP** (product hero) | 800x800 |

## Priority order (what to change first)

**1. `r3_application` — the single highest-ROI swap.** It sits directly under the new strongest reason
("The Morning Stops Being the Worst Part of the Day"). Swap the leg/knee squeeze for a tight close-up of
weathered older hands in morning window light, one hand working cream into a swollen knuckle. A hand
close-up reads "arthritis" in a quarter second. Tube on the table, not the focus.

**2. `hero_2x2-grid` — first impression.** It's the hero visual. Regenerate the 4 tiles so each older
person is in a *joint moment* (flexing stiff fingers, rubbing a knee, easing a wrist, opening a jar),
some still holding the NANO X tube. Keeps the social-proof collage, adds the arthritis tell.

**3. `r4_3x3-grid` — same treatment**, 9 tiles, mix of joint moments + tube-holding.

**4. Portraits (Joe / Dale / Carol / Janet) — optional, low priority.** They match the demo and the copy
carries the joint specifics. Only regenerate if we want each face to echo its story (Dale's hands, etc.).

**KEEP, do not touch:** tube-on-grass, 6 ingredient icons, cross-section diagram (already says "joint"),
guarantee shot, offer tube. The product is unchanged, so product/mechanism art stays.

## nanox-batch concepts for the swaps (UGC realism wrapper, older 60-75)
- **r3 morning hands:** weathered older hands in soft morning window light, one thumb rubbing cream into a
  swollen knuckle, candid phone photo, real unflattering skin, age spots, no product label in focus.
- **hero grid tiles (x4):** (a) older woman flexing stiff fingers by a kitchen window, (b) older man
  rubbing a stiff knee on the edge of the bed, (c) older woman easing a sore wrist, (d) older man holding
  the NANO X tube. Same selfie/candid energy as the originals.
- **3x3 tiles:** more of the same mix across 9.

## Handoff note
Sections use hardcoded `<img src>` (no image_picker), so swapping = generate -> user uploads new files to
Shopify (Files) -> replace the CDN URL in preview + liquid. For the preview I can point at local renders
immediately; the liquid gets the real Shopify URL once uploaded.
