// lib/wordmarks.mjs — identify brand lettering before it reaches OCR/font matching.
//
// A wordmark is artwork, even when OCR can read its letters. Re-setting it in a nearby font
// changes the brand, and OCR commonly turns an adjacent heart/star/device into a bullet. This
// intentionally conservative detector only claims short, header-positioned brand candidates;
// everything else remains ordinary editable text.

const GENERIC_SHORT_COPY = /^(buy now|shop now|learn more|swipe up|tap here|new|sale|save|free shipping|limited time|order now|subscribe)$/i;

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** Return true when an OCR line should be preserved as a wordmark crop, never font-matched. */
export function isWordmarkCandidate(line, canvas, opts = {}) {
  const text = clean(line?.text);
  const box = line?.box || {};
  const W = Number(canvas?.w) || 1;
  const H = Number(canvas?.h) || 1;
  if (!text || !Number.isFinite(box.x) || !Number.isFinite(box.y) || !(box.w > 3) || !(box.h > 3)) return false;
  if (opts.forceTextIds?.has?.(line.id)) return false;
  if (opts.forceWordmarkIds?.has?.(line.id)) return true;
  if (text.length > (opts.maxChars || 28) || /[\n.!?]/.test(text) || /\d/.test(text) || GENERIC_SHORT_COPY.test(text)) return false;

  // Logos overwhelmingly live in a compact header/footer lockup. Centre header is included for
  // UPFRONT-style brands; an unusually wide short lockup may also sit just below the header.
  const centerX = box.x + box.w / 2;
  const header = box.y + box.h <= H * 0.24;
  const footer = box.y >= H * 0.88 && text.length <= 16;
  const centered = Math.abs(centerX - W / 2) <= W * 0.22;
  const leftBrandSlot = box.x <= W * 0.30;
  if (!(header || footer) || !(centered || leftBrandSlot)) return false;

  const words = text.split(' ').filter(Boolean);
  const letters = [...text].filter((c) => /\p{L}/u.test(c)).length;
  // OCR often degrades a logo heart to a bullet. Treat that substituted leading mark as part of
  // the lockup so the crop still preserves the real heart pixels instead of re-setting a dot.
  const pictogram = /[♡♥❤★☆✦✧]/u.test(text) || /^[•●◦·]\s*/u.test(text);
  const compact = box.w / Math.max(1, box.h) >= 1.15;
  const nameLike = words.length <= 3 && letters >= 3;
  const allCapsShort = /^[A-ZÀ-ÖØ-Þ& ]+$/.test(text) && letters <= 12;
  // A heart is strong evidence only when it travels with a short name, never when it is a lone
  // icon. This keeps "Hears ♡ Earplugs" together as one crop.
  // Without a pictogram, require a single lexical token. Two-word header copy is too easily a
  // headline ("SLEEP DEEPER"), while the common brand cases here remain covered by the
  // pictogram lockup or single-token names such as grüns / UPFRONT.
  return compact && nameLike && (pictogram || words.length === 1 || (allCapsShort && words.length === 1));
}

/** Split OCR lines into regular text and logo artwork candidates. */
export function partitionWordmarks(lines, canvas, opts = {}) {
  const wordmarks = [], text = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    if (isWordmarkCandidate(line, canvas, opts)) wordmarks.push(line);
    else text.push(line);
  }
  return { wordmarks, text };
}
