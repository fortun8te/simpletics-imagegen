# Native-ad asset audit — 8 platforms

8 parallel research agents audited/researched the real-asset coverage needed to render convincing
native-UI ad screenshots for: Apple Notes, iMessage, TikTok comments, Instagram captions, Instagram
DMs, Facebook comments, WhatsApp, Trustpilot. This is the consolidated findings doc. Companion to
`NATIVE-ADS-PLAN.md` (the archetype-preset strategy this audit feeds into).

**Rigor bar used throughout** (set by `lib/notes-icons.mjs` and `lib/instagram-colors.mjs`, the two
existing real-asset files): every value is either **CONFIRMED** (traced from a real screenshot,
sampled live via `getComputedStyle`/canvas-sampling on a real DOM, or sourced from an official brand
page) or **RESEARCHED-APPROXIMATION** (web-search consensus / visual familiarity, explicitly labeled
as not verified). Nothing below should be treated as pixel-accurate just because it's written down.

## Headline findings

1. **Only two real (CONFIRMED) asset sets exist in the whole repo**: Apple Notes' nav-bar + checklist
   icons (`lib/notes-icons.mjs`, traced from 2 real iPhone screenshots) and Instagram's dark-mode
   bg/text/muted colors + 4 action-icon SVG paths (`lib/instagram-colors.mjs` +
   `src/components/design/nativeIcons.ts`, live DOM-sampled 2026-07-03). Everything else — iMessage,
   Instagram DM bubbles, the Instagram feed-post template's own colors, and all 4 brand-new platforms
   — is approximation-tier or worse (unlabeled hex literals with no provenance comment at all).
2. **The two real Instagram asset files are dead code.** `instagram-colors.mjs` is still "not yet
   wired into templates.mjs" (its own header says so, still true). The 4 real action-icon paths in
   `nativeIcons.ts` are unused — `ig-feed-post` in `templates.mjs` hand-draws its own approximated
   polyline icons instead. Wiring these in is a free accuracy win, zero new research needed.
3. **Two confirmed factual bugs, unrelated to missing research:**
   - `templates.mjs`/`TEMPLATE_ALIASES` routes `sms` to the same blue `imessage` template — wrong,
     real SMS/RCS bubbles render **green**, not blue.
   - `elements.mjs:1308` comments `#ffb400` as the color "Trustpilot/Yotpo/Google" review widgets
     use — wrong for Trustpilot specifically (real Trustpilot fill is green, ~`#00b67a`, which the
     *same file* already uses correctly 30 lines later at `elements.mjs:1340` for a different
     component). The amber comment should be scoped to Yotpo/Google only.
4. **Local, unused, real asset**: the user already has the complete official **TikTok Sans** font
   family on disk (`~/Downloads/TikTok_Sans/` + `~/Downloads/fonts-for-windows/`, all weights +
   optical sizes + variable font), confirmed via TikTok's own GitHub release. Zero references to it
   anywhere in the repo yet.
5. **Web research consistently cannot reach "layout & spacing" (exact px measurements).** Every new-
   platform agent got confident-ish on colors/fonts/icon identity but hit a wall on padding, avatar
   diameters, bubble radii, row heights — those numbers only exist in a real screenshot or DOM
   sample, never in brand guideline pages or blog posts. Treat this category as 0% done for TikTok,
   Facebook, WhatsApp, Trustpilot until someone does a live trace pass.
6. **Status bars are the recurring never-traced gap.** Apple Notes' source screenshot actually
   contains a real status bar (visible in the vectorized SVG per `notes-icons.mjs`'s own header) that
   was never extracted; iMessage and the generic `elements.mjs` `phone-status-bar` are hand-drawn
   rects, not traced from anything, and are missing a wifi glyph entirely.

## Per-platform summary

### Apple Notes — mostly real, has real gaps
**Confirmed:** back chevron, share icon, more-circle (ring+hole+dots), checklist checked-circle +
checkmark — all traced SVG paths with real hex (`#E2AE0C` nav gold, `#FDB902` checklist gold),
wired into both `apple-notes` and `notes-checklist` templates.
**Missing entirely:** status bar (exists in the source screenshot, never extracted), "All iCloud"
folder label, edited-timestamp footer, divider lines, lock icon (locked notes), pin indicator,
attachment/table chrome, dark mode.
**Lower-rigor duplicate risk:** `nativeIcons.ts`'s `IOS_ICONS` (back/check/circleUnchecked) are
Bootstrap Icons (MIT generic library), not real Apple glyphs — don't let these get used in place of
the real traced assets.

### iMessage — nothing is CONFIRMED yet
Both implementations (`native-components/imessage.mjs` + the older `templates.mjs` scene-graph
version) self-disclose their colors as web-consensus, not traced ("Apple does not publish exact hex
values"). Sent-blue is ambiguous between `#0A84FF`/`#007AFF`; received-grey `#E9E9EB` is consensus
only. **Missing entirely:** Delivered/Read receipt text, typing indicator, video/audio call icons in
the nav bar, wifi glyph, a real anchored tapback badge (only the tapback *picker bar* exists). The
SMS-green bug (finding #3 above) lives here too.

### Instagram captions (feed post) — real assets exist but aren't used
The actual feed-post renderer is `ig-feed-post` in `templates.mjs:811-910` (reachable via
`ig-post`/`instagram-post`/`post` aliases) — note `elements.mjs`'s "IG-caption" pill (line 260) is a
**different, generic** text-pill treatment, not this. `ig-feed-post` hand-draws approximated icons
and a fake Unicode-checkmark verified badge instead of using the real traced assets sitting unused in
`nativeIcons.ts`. **Missing entirely:** timestamp (a `MUTED` constant is declared and never used —
looks like abandoned work), hashtag/mention link styling, "...more" truncation, the numeric
"1,204 likes" format variant. **Gap:** `instagram-colors.mjs` is dark-mode only; no light-mode IG
reference exists anywhere, and light-mode is common in real ad creative.

### Instagram DMs — hand-built template, values not DOM-verified
`templates.mjs`'s `ig-dm` (lines 438–587) is a fully worked-out template (bubble radius formula,
line-height 1.25, grouping gaps, "New Messages" divider, reply-quote chrome, story-reply thumbnail —
all real *logic*), but its color constants (`IG_RECEIVED='#262626'`, sent gradient
`#a033ff`→`#0aa6ff`) are independently declared, not imported from `instagram-colors.mjs`, and
labeled "well-documented" rather than DOM-sampled. **Missing entirely:** header chrome (avatar, name,
active-now text, call icons), "Seen" receipt, time-of-day divider variant, double-tap heart reaction,
message input bar.

### TikTok comments — brand-new, colors unverified, font already on disk
No official TikTok UI-chrome brand page found — comment-sheet background, text colors, and the
liked-heart red (`#FE2C55`, TikTok's documented *brand* red, plausible but not confirmed as the
literal in-app icon color) are all approximation. **Real find:** TikTok Sans is CONFIRMED as the
actual in-app UI font (TikTok's own blog/newsroom), and the font files are already downloaded
locally, unused. **Notable/current:** TikTok reportedly removed the pin-comment feature in 2025 in
favor of a pink "First Comment" badge — flag this before building a "pinned comment" asset, it may be
stale UI. Layout/spacing: no data found, needs a real screenshot trace entirely.

### Facebook comments — brand-new, one real anchor
**Confirmed:** the 7-reaction set (Like/Love/Care/Haha/Wow/Sad/Angry) and the brand blue `#1877F2`
(Meta's documented brand color). Everything else — comment-pill grey `#F0F2F5`, name/body near-black
`#050505`, per-reaction icon hexes, pill border-radius, reply indentation — is approximation, no
official Meta page publishes UI-chrome hex values. Facebook uses the OS system font stack (same
pattern as Instagram), not a branded webfont, per secondary sources.

### WhatsApp — brand-new, a real decision point
Classic look (`#DCF8C6` light-green sent bubble, beige doodle wallpaper) has high source-consensus
but zero official-hex confirmation. **Important:** WhatsApp changed iOS's sent-bubble from blue to
green in a 2024 rebrand, and shipped user-customizable Chat Themes in 2025 — there is no longer one
canonical "current" look. Recommendation from the research pass: default to **Classic** for
instant recognizability (most people's mental image of "a WhatsApp screenshot"); treat the
2024+ theme as a documented alternate, not the default, since its exact hex is unverified and now
user-customizable anyway. Read-receipt blue `#34B7F1` and the checkmark states (clock→sending,
1 gray check→sent, 2 gray→delivered, 2 blue→read) are consensus-level. Layout/spacing: not found,
needs a real screenshot trace.

### Trustpilot — brand-new, fixes a real bug in the repo
**Confirmed:** Trustpilot's logomark is a 5-pointed star (rebrand coverage); TrustScore tiers are
Bad/Poor/Average/Great/Excellent with Great starting ~4.0. Everything else is approximation,
including the green hex itself (`#00b67a`, high-consensus but not independently re-verified against
Trustpilot's own site this pass — official brand pages 403'd/timed out). **Highest-priority open
question:** whether Trustpilot's actual rating-row icon is a rounded-square-with-star-cutout (widely
believed, matches what's often described as its key visual differentiator from 5-pointed-star
competitors like Yotpo/Google) or a plain star — unverified, needs a real screenshot or the official
SVG asset pack. Confirms the `#ffb400` bug (finding #3 above).

## Recommended next steps, in order of effort

1. **Zero-research fixes** (just code changes): un-route `sms` from the blue iMessage template;
   rescope the `#ffb400` comment in `elements.mjs` to Yotpo/Google, not Trustpilot.
2. **Free wins** (wire up assets that already exist): import `instagram-colors.mjs` into
   `templates.mjs` for both `ig-feed-post` and `ig-dm` instead of redeclaring hex literals; swap
   `ig-feed-post`'s hand-drawn icons/badge for the real paths already sitting in `nativeIcons.ts`;
   add the local TikTok Sans files into `src/assets/fonts/` and `font-faces.mjs`.
3. **Real extraction pass** (needs you, not more web research): the studio's own rigor bar can only
   be met by tracing a real screenshot or live-sampling a real DOM/app, the way Notes and Instagram's
   dark-mode colors were done. This means either (a) driving a logged-in browser session for the web
   platforms (Instagram light mode, Facebook, Trustpilot, WhatsApp Web) via the Chrome extension, or
   (b) vectorizing real phone screenshots (TikTok app, iMessage, WhatsApp iOS, Notes status bar,
   Notes dark mode) the way `notes-icons.mjs` did from your own iPhone screenshots. I can drive either
   once you're ready — say which platform to start with.
