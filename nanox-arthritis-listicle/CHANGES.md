# NanoXtreme → Arthritis reskin — change log (copy-first pass)

Source: broad-angle `5-reasons-why-listicle`. Target page handle: `5-reasons-why-arthritis`.
Structure, layout, fonts, colours, images, links: UNCHANGED. Only copy + image alt text changed.
Deliverable: `sections/*.liquid` (paste back into Shopify, one file = one section). Preview: `preview/index.html`.

## Copy changes per section

- **01-topbar (banner):** "given up on pain creams" → "given up on creams for stiff, aching joints".
- **02-hero:** H1 "Works On The Pain Every Other Cream Couldn't Reach" → "Reaches The Stiff, Aching Joints Every Other Cream Couldn't". "the pain came back" → "the stiffness came back". Lost-activities line: added "Opening a jar without both hands and a tea towel". Final line: "Back, knees, shoulders, hands, a spot that's never been right since surgery" → "Knuckles, knees, hips, hands, fingers that won't close first thing in the morning".
- **03-reason1:** "The ache you feel" → "The stiffness you feel". 3 ingredient descriptions nudged to joints (Methyl Salicylate / Turmeric / Cayenne / DMSO). Headline + 19-ingredient mechanism kept.
- **04-reason2:** H2 "Nothing Has Reached Your Pain" → "Your Joints". "in the muscle, the joint" → "in the joint, the knuckle". "source of the discomfort" → "source of the stiffness". Tennis-ball/nanoization/10x mechanism kept.
- **05-reason3:** "before the pain moved in" → "before the stiffness moved in". Image alt → hand application.
- **06-testimonial (Joe R.):** "drove 8 hours, and it still felt like a heating pad on my back" → "rubbed it into my knees, drove 8 hours, and they still felt like a heating pad the whole way".
- **07-reason4-reviews:** intro "Your body was just starved" → "Your joints were just starved". Dale R. lower-back/truck → aching hands gripping the wheel. Carol M. (71, knees) → kept (already arthritis). Janet P. wrist surgery → arthritis in the wrists.
- **08-reason5-guarantee:** unchanged (angle-neutral skeptic + guarantee + stats).
- **09-offer:** "finally found relief" → "finally found relief from stiff, aching joints". Tube + checkout link kept.
- **10-sticky-cta:** unchanged.

## Images flagged for Phase 2 swap (nanox-batch → simpletics-imagegen)

Regenerate to joint-specific UGC, SAME aspect ratio/crop, KEEP product + diagrams:
- 02-hero `2x2-grid.png` — people grid → stiff hands / sore knees.
- 05-reason3 application shot — rubbing cream into a stiff hand/knee.
- 06-testimonial Joe R. portrait — arthritis-appropriate older customer.
- 07-reason4 `3x3-grid.png` + Dale/Carol/Janet portraits — arthritis people.
KEEP (product/mechanism, angle-neutral): reason1 ingredient grid + diagram, reason2 cross-section, reason5 guarantee tube, offer tube.

## v2 — full restoration-angle rewrite (creativesop ch.10/11/12/13)

Angle spine: lead pain, pay off with **restoration** (Identity emotion = the unowned white space),
prove with the existing mechanism. Villain = "creams whose molecules are too big" + "it's just age".
Specific avatar moments threaded in (jar, buttons, mornings, stairs, grip). Headline kept in the
original skeleton per request. Same layout/length per block.

- **Hero opening:** now leads on the universal morning moment ("You feel it before you're even out of
  bed. The hands that won't quite close. The knee that needs a minute..."), concrete lost activities
  (jar / buttons / grandkids), and a villain line ("it was never you getting old").
- **Reason 2:** villain made explicit ("it was never your joints being too far gone"); absorption line
  ends on restoration ("down to the joint that's been keeping you stiff").
- **Reason 3:** future-paced with concrete moments (garden, stairs, a whole afternoon).
- **Testimonial (Joe R.):** now a hands/grip restoration beat ("back in the workshop, gripping tools").
- **Reason 4 intro:** villain = age ("it was never your age, it was never your fault").
- **Offer:** restoration close ("got back the jars, the stairs, and the mornings stiff joints had taken").
- **Banner:** restoration framing ("got their stiff, aching joints moving again").

## Verified
- Renders at localhost preview; 17/17 images load; 1 `<h1>`; no console errors; no em/en dashes.
- v2: preview and section .liquid copy confirmed in sync line-by-line.
