// lib/instagram-colors.mjs — DOM-verified real Instagram color/gradient reference values.
//
// PROVENANCE: every value below was extracted LIVE from a logged-in instagram.com session's DOM
// (dark mode) on 2026-07-03, via getComputedStyle on real feed elements and canvas pixel sampling
// on a real story-ring avatar (74x74 canvas) — these are NOT researched/guessed approximations.
// Companion to the verbatim Instagram icon paths added the same pass in
// ../src/components/design/nativeIcons.ts (heartOutline/comment/repost/share).
//
// STATUS: not yet wired into lib/templates.mjs. This module is a standalone reference, ready to be
// imported from templates.mjs in a later integration pass once that file's current in-progress
// edits (Notes-template work) land.

/** Page background — a dark blue-charcoal, NOT pure black. getComputedStyle sample:
 *  rgb(12, 16, 20). */
export const IG_BG = '#0C1014';

/** Primary text (username, caption) — NOT pure white. getComputedStyle sample: rgb(245, 245, 245),
 *  font-weight 600, font-size 14px. */
export const IG_TEXT = '#F5F5F5';

/** Secondary/muted text (timestamp). getComputedStyle sample: rgb(168, 168, 168). */
export const IG_MUTED = '#A8A8A8';

/** Confirmed real font-family from live DOM — Instagram renders text in the OS system font stack,
 *  NOT a branded "Instagram Sans" webfont. Matches the studio's existing `-apple-system` choice
 *  for Instagram text — no change needed there; documented here for reference. */
export const IG_FONT_FAMILY = '-apple-system, "system-ui", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/**
 * Story-ring gradient — 2 CONFIRMED real anchor points, canvas-sampled from a live avatar ring
 * (74x74 canvas, real pixel reads):
 *   - top-of-ring sample:  rgb(221, 0, 177) = #DD00B1 (magenta/pink)
 *   - left-of-ring sample: rgb(255, 166, 0) = #FFA600 (orange)
 * The full ring is a conic/radial multi-stop sweep (purple -> pink -> orange -> yellow); these are
 * the 2 REAL sampled anchors. Use this 2-stop version when only confirmed data should drive the
 * approximation.
 */
export const IG_STORY_RING_GRADIENT = [
  { color: '#DD00B1', pos: 0 },
  { color: '#FFA600', pos: 1 },
];

/**
 * Story-ring gradient — 3-stop version for a closer visual sweep. Stops 0 and 2 are the same
 * CONFIRMED real samples as IG_STORY_RING_GRADIENT above. The middle purple stop (#8134AF) is an
 * INFERENCE (not DOM/canvas-sampled this pass) added to better approximate the known purple ->
 * pink -> orange sweep — clearly marked so it isn't mistaken for verified data.
 */
export const IG_STORY_RING_GRADIENT_3STOP = [
  { color: '#8134AF', pos: 0 }, // inferred, not sampled
  { color: '#DD00B1', pos: 0.5 }, // confirmed real sample
  { color: '#FFA600', pos: 1 }, // confirmed real sample
];
