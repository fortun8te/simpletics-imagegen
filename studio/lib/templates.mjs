// lib/templates.mjs — ARCHETYPE templates: full-ad scaffolds the agent (and generate mode)
// can drop in one op. Elements are furniture; templates are whole rooms. Each build() returns
// a flat layer list (excluding the base) sized to the doc's canvas, modeled on real reference
// ads (2026-07: Simpletics story-native, X-post testimonial, Craft Cadence comparison,
// Cadence offer-hero, Wavy before/after).
//
// Zero-dep plain JS, shared Node + browser (like elements.mjs). Text goes through
// fitElementText so boxes are measurement output; every layer stays individually editable
// (setText routes through nothing special — these are plain layers, not element instances).

import { buildElement, fitElementText, layerId, FONT_SUGGEST } from './elements.mjs';
import { groupBounds } from './scene-tree.mjs';
import {
  NOTES_CHEVRON_BACK, NOTES_SHARE_ICON, NOTES_MORE_CIRCLE_RING, NOTES_MORE_CIRCLE_HOLE,
  NOTES_MORE_CIRCLE_HOLE_BOX, NOTES_MORE_DOTS,
  NOTES_CHECKLIST_DONE_CIRCLE, NOTES_CHECKLIST_DONE_CHECK, NOTES_CHECKLIST_DONE_CHECK_BOX,
  NOTES_REAL_COLORS,
} from './notes-icons.mjs';

const T = (over) => ({ id: layerId(over.role || 'text'), type: 'text', autoH: true, ...over });
const S = (over) => ({ id: layerId(over.role || 'shape'), type: 'shape', ...over });

/** Wrap children in a Figma-clean GroupNode: box = bounds of its (absolute-coord) children,
 *  fresh layerId. Children stay in ABSOLUTE coordinates (the tree convention). Nest by passing
 *  sub-groups as children. Skips null/undefined children so callers can inline `cond && node`.
 *  Text leaves keep their tpl/tplRef stamps — grouping never touches leaf provenance. */
const groupLayers = (name, children) => {
  const kids = (children || []).filter(Boolean);
  return {
    id: layerId('group'), type: 'group', name,
    box: groupBounds(kids) || { x: 0, y: 0, w: 0, h: 0 },
    children: kids,
  };
};

const sized = (doc) => {
  const { w, h } = doc.canvas;
  return { w, h, rx: (f) => Math.round(w * f), ry: (f) => Math.round(h * f), fs: (f) => Math.round(w * f) };
};

/** Gray labeled photo slot — swap for real imagery later (parity with extraction v2). */
const imageSlot = (name, box, radius) => S({
  role: 'product', name: `Image · ${name}`, box,
  style: { background: '#9aa0a6', opacity: 0.45, radius },
});

const pct = (s) => String(s || '');

/** Deterministic 0..1 pseudo-random from two ints — keeps the mosaic tiles stable across
 *  rebuilds (so IDEMPOTENT geometry tests stay green) while looking scattered. */
const cellNoise = (i, j) => {
  const n = Math.sin((i + 1) * 12.9898 + (j + 1) * 78.233) * 43758.5453;
  return n - Math.floor(n);
};

/** A blocky MOSAIC fill inside `box`: an n×n grid of solid muted-gray cells at varied lightness
 *  — the classic "pixelated / censored face" look. Pure scene-graph shapes, so it renders as a
 *  real mosaic in EVERY exporter (no renderer support needed, unlike style.blur). Cells outside
 *  the inscribed circle are dropped so the mosaic reads as a round avatar. `over` supplies
 *  role/name; `ellipse` (default true) clips to a circle, else a square block. */
const pixelBlocks = (over, box, n = 6, ellipse = true) => {
  const cw = box.w / n, ch = box.h / n;
  const cx = box.w / 2, cy = box.h / 2, r = Math.min(box.w, box.h) / 2;
  const cells = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const px = (i + 0.5) * cw, py = (j + 0.5) * ch;
      if (ellipse && ((px - cx) ** 2 + (py - cy) ** 2) > (r + Math.min(cw, ch) * 0.25) ** 2) continue;
      // muted gray-blue palette, lightness jittered per cell → a believable censored mosaic
      const g = Math.round(96 + cellNoise(i, j) * 96); // 96..192
      const b = Math.round(g + 10);
      const hex = `#${g.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${Math.min(255, b).toString(16).padStart(2, '0')}`;
      cells.push(S({ role: 'decor', name: `Mosaic ${j * n + i}`,
        box: { x: Math.round(box.x + i * cw), y: Math.round(box.y + j * ch), w: Math.ceil(cw) + 1, h: Math.ceil(ch) + 1 },
        style: { background: hex } }));
    }
  }
  return cells;
};

/** Circular avatar. `effect` selects the privacy treatment of anonymized-poster ads (bench 137):
 *    'none'     → clean gradient circle (the `over.gradient`).
 *    'blur'     → solid gray circle with a heavy style.blur (real FOREGROUND_BLUR in Figma/DOM,
 *                 blur hint in raster/SVG).
 *    'pixelate' → a blocky MOSAIC grid clipped to a circle (a distinct, renderer-independent
 *                 censored-face look, NOT a gaussian blur).
 *  Back-compat: a truthy 2nd arg still means 'blur'. Returns a single node ('none'/'blur') or a
 *  GROUP of mosaic cells ('pixelate') — callers push it like any layer. */
const avatarShape = (over, effect) => {
  const { gradient, ...rest } = over;
  const mode = effect === true ? 'blur' : (effect || 'none');
  if (mode === 'pixelate') {
    const box = over.box || { x: 0, y: 0, w: 40, h: 40 };
    const n = box.w >= 90 ? 7 : 5; // finer grid on bigger avatars
    return groupLayers(over.name || 'Avatar', pixelBlocks(over, box, n, true));
  }
  return S({
    ...rest,
    style: mode === 'blur'
      ? { shapeKind: 'ellipse', background: '#8a8f96', blur: Math.max(6, Math.round((over.box?.w || 40) * 0.18)) }
      : { shapeKind: 'ellipse', gradient },
  });
};

/** Resolve an avatar-effect param, honoring the older boolean `blurAvatar` for back-compat.
 *  Returns 'none' | 'blur' | 'pixelate'. */
const avatarEffectOf = (p) => {
  const e = String(p.avatarEffect || '').toLowerCase();
  if (e === 'blur' || e === 'pixelate' || e === 'none') return e;
  return p.blurAvatar ? 'blur' : 'none';
};

/** A real freeform-vector icon layer: `icon` is a { d, color } asset (see lib/notes-icons.mjs /
 *  nativeIcons.ts convention — `d` normalized 0..1 within its OWN box). Renders via the
 *  scene-graph's shapeKind:'path' + style.path convention, so it's a genuinely editable shape
 *  layer (recolorable/movable) — not a flattened raster. */
const iconShape = (over, icon) => S({
  ...over,
  style: { shapeKind: 'path', path: icon.d, background: icon.color, ...(over.style || {}) },
});

/** @type {Array<{id:string,name:string,hint:string,params:object,build:(doc:object,p:object,kit?:object)=>object[]}>} */
export const TEMPLATES = [

  {
    id: 'story-native',
    name: 'Story native',
    hint: 'Vertical photo story: stacked hook pills top (Simpletics-style), photo fills the rest',
    params: { hook: 'Never Noticed How Full My Hair Looked', hook2: '…Until The Bottle Was Empty.', style: 'light' },
    build(doc, p) {
      const { ry } = sized(doc);
      // Two stacked ig-caption pill GROUPS, each pill hugging its line (per-line rounded bg),
      // centered on the canvas. Real IG story captions read as white pills with near-black text
      // (style:'light'), the hook a size bigger than the sub-hook. buildElement centers each line.
      const dark = String(p.style).toLowerCase() === 'dark';
      const mk = (text, y, size) => {
        const [inst] = buildElement('ig-caption', doc, { text, align: 'center', size, style: dark ? 'dark' : 'light' });
        const dx = Math.round((doc.canvas.w - inst.box.w) / 2) - inst.box.x;
        const dy = ry(y) - inst.box.y;
        const shift = (n) => { n.box.x += dx; n.box.y += dy; if (n.children) n.children.forEach(shift); };
        shift(inst);
        return inst;
      };
      const hook = mk(pct(p.hook), 0.065, 5.8); hook.name = 'Hook pill';
      const hook2 = mk(pct(p.hook2), 0.20, 4.8); hook2.name = 'Sub-hook pill';
      return [hook, hook2];
    },
  },

  {
    id: 'x-post-ad',
    name: 'X post ad',
    hint: 'X/Twitter Post detail: dark chrome, ← Post ⋯ nav, avatar + bold name + blue check + @handle + Following pill, multi-paragraph body, grey meta with bold viewcount, 5-icon action row',
    params: {
      name: 'UPFRONT', handle: '@UpfrontFood',
      body: 'LAATSTE SITE WIDE SALE VAN 2026 ⏳\n\nDe Vakantiegeldsale komt eraan, waarbij je 20% korting krijgt op het volledige assortiment.\n\nDaarbovenop krijgen de eerste 500 bestellingen hun geld terug tot €100.\n\nSchrijf je nu in en mis geen enkele update. We zien je woensdag 20 mei om 20:00 uur. 👀',
      followLabel: 'Volgend',
      timestamp: '05:00 PM · 12-05-2026', views: '121K',
      viewsLabel: 'views',
      replies: '257', reposts: '66', likes: '21K', bookmarks: '89',
      verified: true, blurAvatar: false, avatarEffect: 'none',
      // optional embedded media below the body: '' = none, 'photo' = a single photo card,
      // 'quote' = a quote-tweet card (avatar + name/handle + quoted text)
      media: '', photo: 'attached photo',
      quoteName: 'Simpletics', quoteHandle: '@simpletics',
      quoteText: 'the texture powder is genuinely the only thing that gave my flat hair volume',
    },
    build(doc, p) {
      const { w, h, rx, ry, fs } = sized(doc);
      // Near-1:1 with X's own Post detail screen (dark). Everything scales off the canvas so it
      // holds at both the square benchmark (1080²) and the 4:5 harness canvas:
      //   nav bar (← · Post · ⋯) → header (avatar + bold name + blue check + @handle + Following
      //   pill) → multi-paragraph body → grey meta line with a BOLD viewcount → 5-icon action row
      //   (reply 💬 · repost 🔁 · like ♥ · bookmark 🔖 · share ⬆). No photo — this is a text post.
      // X "Lights out" dark: pure-black bg #000, primary text #e7e9ea, muted #71767b, blue #1d9bf0.
      const WHITE = '#ffffff', NAME = '#e7e9ea', MUTED = '#71767b', BLUE = '#1d9bf0', BG = '#000000';
      const pad = rx(0.05);            // X's ~16px content gutter
      const chirp = FONT_SUGGEST.twitter;
      const bg = S({ role: 'card', name: 'Post bg', box: { x: 0, y: 0, w, h }, style: { background: BG } });

      // ── Nav bar: ← (left) · bold "Post" (centered) · ⋯ (right) ──────────────────────────────
      const navY = ry(0.028), navGlyph = fs(0.055), navH = Math.round(navGlyph * 1.2);
      const back = T({ role: 'caption', name: 'Back', text: '←', sizeLocked: true, autoH: false,
        box: { x: pad, y: navY, w: rx(0.1), h: navH },
        style: { fontSize: navGlyph, fontWeight: 700, color: WHITE, align: 'left', lineHeight: 1, fontFamily: chirp } });
      const navTitle = T({ role: 'caption', name: 'Nav title', text: 'Post', sizeLocked: true, autoH: false,
        box: { x: rx(0.2), y: navY, w: rx(0.6), h: navH },
        style: { fontSize: fs(0.05), fontWeight: 800, color: WHITE, align: 'center', lineHeight: 1.15, fontFamily: chirp } });
      const more = T({ role: 'caption', name: 'More', text: '⋯', sizeLocked: true, autoH: false,
        box: { x: w - pad - rx(0.1), y: navY - Math.round(navGlyph * 0.12), w: rx(0.1), h: navH },
        style: { fontSize: navGlyph, fontWeight: 800, color: WHITE, align: 'right', lineHeight: 1, fontFamily: chirp } });
      const nav = groupLayers('Nav', [back, navTitle, more]);

      // ── Header: avatar · bold name + blue check · @handle · Following pill ───────────────────
      const av = rx(0.13);             // circular avatar (logo)
      const gutter = rx(0.03);         // avatar → name gap
      const headY = navY + navH + ry(0.03);
      const nameFs = fs(0.042), handleFs = fs(0.036);
      const tx = pad + av + gutter;
      const nameBlockH = Math.round(nameFs * 1.2) + Math.round(handleFs * 1.25);
      const nameTop = headY + Math.max(0, Math.round((av - nameBlockH) / 2));
      const avatar = avatarShape({
        role: 'avatar', name: 'Avatar', box: { x: pad, y: headY, w: av, h: av },
        gradient: { type: 'linear', angle: 160, stops: [{ color: '#ffffff', pos: 0 }, { color: '#dcdcdc', pos: 1 }] },
      }, avatarEffectOf(p));
      // blue verified check placed right after the measured display name (bold → wider glyphs)
      const nameW = Math.ceil(String(pct(p.name)).length * nameFs * 0.72);
      const checkS = Math.round(nameFs * 1.0);
      const checkX = Math.min(tx + nameW + Math.round(nameFs * 0.22), w - pad - rx(0.3));
      // "Following" pill — white pill, dark text, far right
      const followFs = fs(0.036);
      const followLabel = pct(p.followLabel) || 'Following';
      const followW = Math.round(followLabel.length * followFs * 0.72 + followFs * 2.6);
      const followH = Math.round(followFs * 2.3);
      const followX = w - pad - followW;
      const headerKids = [
        avatar,
        T({ role: 'caption', name: 'Name', text: pct(p.name), sizeLocked: true, autoH: false,
          box: { x: tx, y: nameTop, w: Math.max(rx(0.1), nameW), h: Math.round(nameFs * 1.35) },
          style: { fontSize: nameFs, fontWeight: 800, color: NAME, align: 'left', lineHeight: 1.2, fontFamily: chirp } }),
        p.verified && T({ role: 'badge', name: 'Verified', text: '✔', sizeLocked: true, autoH: false,
          box: { x: checkX, y: nameTop + Math.round(nameFs * 0.06), w: checkS, h: checkS },
          style: { fontSize: Math.round(checkS * 0.6), fontWeight: 900, color: WHITE, background: BLUE, radius: checkS, align: 'center', lineHeight: 1, fontFamily: chirp } }),
        T({ role: 'caption', name: 'Handle', text: pct(p.handle), sizeLocked: true, autoH: false,
          box: { x: tx, y: nameTop + Math.round(nameFs * 1.25), w: rx(0.5), h: Math.round(handleFs * 1.35) },
          style: { fontSize: handleFs, fontWeight: 400, color: MUTED, align: 'left', lineHeight: 1.2, fontFamily: chirp } }),
        T({ role: 'cta', name: 'Following', text: followLabel, sizeLocked: true, autoH: false,
          box: { x: followX, y: headY + Math.round((av - followH) / 2), w: followW, h: followH },
          style: { fontSize: followFs, fontWeight: 700, color: '#0f1419', background: WHITE, radius: followH, align: 'center', lineHeight: 1, fontFamily: chirp } }),
      ];
      const header = groupLayers('Header', headerKids);

      // ── Meta line + action row are anchored to the BOTTOM so the post reads full at any body
      //    length; the body fills the gap between the header and the meta line ───────────────────
      const metaFs = fs(0.034), metaH = Math.round(metaFs * 1.4);
      const rowH = ry(0.06);
      const rowY = h - ry(0.05) - rowH;
      const metaY = rowY - ry(0.02) - metaH;

      // ── Body: ONE layer PER PARAGRAPH so the blank-line gaps read like the real X post (the
      //    HTML/canvas renderers collapse '\n' inside a single text box, losing the spacing) ──────
      const bodyY = headY + av + ry(0.035);
      const bodyW = w - pad * 2;
      // ── Optional embedded media card (photo or quote-tweet) sits between the body and the meta
      //    line, rounded + hairline-bordered like X's own media/quote embeds ──────────────────────
      const mediaMode = ['photo', 'quote'].includes(String(p.media)) ? String(p.media) : '';
      const mediaH = mediaMode === 'photo' ? ry(0.28) : mediaMode === 'quote' ? ry(0.15) : 0;
      const mediaGap = mediaMode ? ry(0.028) : 0;
      const bodyBottom = metaY - ry(0.02) - mediaH - mediaGap;
      const paras = String(pct(p.body)).split(/\n{2,}/).map((s) => s.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
      const bodyLineH = 1.42;
      const paraGap = (fsize) => Math.round(fsize * 0.95);       // blank-line gap between paragraphs
      const layoutParas = (fsize) => {
        const cpl = Math.max(1, Math.floor(bodyW / (fsize * 0.5))); // chars per line at this size
        let y = 0; const boxes = [];
        for (const para of paras) {
          const lines = Math.max(1, Math.ceil(para.length / cpl));
          const ph = Math.round(lines * fsize * bodyLineH);
          boxes.push({ y, h: ph });
          y += ph + paraGap(fsize);
        }
        return { total: paras.length ? y - paraGap(fsize) : 0, boxes };
      };
      // shrink the body font until every paragraph + its gaps fits above the meta line
      let bodyFs = fs(0.044);
      let bl = layoutParas(bodyFs);
      let bguard = 0;
      while (bl.total > (bodyBottom - bodyY) && bodyFs > fs(0.03) && bguard++ < 24) {
        bodyFs = Math.round(bodyFs * 0.94); bl = layoutParas(bodyFs);
      }
      const bodyNodes = paras.map((para, i) => T({
        role: i === 0 ? 'headline' : 'caption', name: `Body ¶${i + 1}`, text: para, autoH: false, sizeLocked: true,
        box: { x: pad, y: bodyY + bl.boxes[i].y, w: bodyW, h: bl.boxes[i].h },
        style: { fontSize: bodyFs, fontWeight: 400, color: WHITE, align: 'left', lineHeight: bodyLineH, fontFamily: chirp },
      }));
      const prefix = `${pct(p.timestamp)} · `;
      const prefixW = Math.round(prefix.length * metaFs * 0.5);
      const viewsW = Math.round(String(pct(p.views)).length * metaFs * 0.62);
      const metaPrefix = T({ role: 'caption', name: 'Meta time', text: prefix, sizeLocked: true, autoH: false,
        box: { x: pad, y: metaY, w: prefixW, h: metaH },
        style: { fontSize: metaFs, fontWeight: 400, color: MUTED, align: 'left', lineHeight: 1.2, fontFamily: chirp } });
      const metaViews = T({ role: 'caption', name: 'Viewcount', text: pct(p.views), sizeLocked: true, autoH: false,
        box: { x: pad + prefixW, y: metaY, w: viewsW, h: metaH },
        style: { fontSize: metaFs, fontWeight: 800, color: WHITE, align: 'left', lineHeight: 1.2, fontFamily: chirp } });
      const metaSuffix = T({ role: 'caption', name: 'Meta views label', text: ` ${pct(p.viewsLabel) || 'views'}`, sizeLocked: true, autoH: false,
        box: { x: pad + prefixW + viewsW + Math.round(metaFs * 0.3), y: metaY, w: rx(0.4), h: metaH },
        style: { fontSize: metaFs, fontWeight: 400, color: MUTED, align: 'left', lineHeight: 1.2, fontFamily: chirp } });
      const meta = groupLayers('Meta', [metaPrefix, metaViews, metaSuffix]);

      // ── Media card: a photo slot, or a quote-tweet (bordered card w/ avatar + name + quote) ─────
      let mediaGroup = null;
      if (mediaMode) {
        const mediaY = bodyBottom + mediaGap;
        const mediaRadius = rx(0.03);
        if (mediaMode === 'photo') {
          const frame = S({ role: 'card', name: 'Media frame', box: { x: pad, y: mediaY, w: bodyW, h: mediaH },
            style: { background: '#16181c', radius: mediaRadius, stroke: { color: '#2f3336', width: 2 } } });
          const photo = imageSlot(pct(p.photo), { x: pad, y: mediaY, w: bodyW, h: mediaH }, mediaRadius);
          mediaGroup = groupLayers('Media', [frame, photo]);
        } else {
          const qPad = rx(0.035);
          const qAv = rx(0.075);
          const qNameFs = fs(0.033), qHandleFs = fs(0.03), qTextFs = fs(0.032);
          const qtx = pad + qPad + qAv + rx(0.02);
          const qHeadY = mediaY + qPad;
          const qCard = S({ role: 'card', name: 'Quote card', box: { x: pad, y: mediaY, w: bodyW, h: mediaH },
            style: { background: BG, radius: mediaRadius, stroke: { color: '#2f3336', width: 2 } } });
          const qAvatar = avatarShape({
            role: 'avatar', name: 'Quote avatar', box: { x: pad + qPad, y: qHeadY, w: qAv, h: qAv },
            gradient: { type: 'linear', angle: 150, stops: [{ color: '#5b7cff', pos: 0 }, { color: '#8a3ffb', pos: 1 }] },
          }, 'none');
          const qName = T({ role: 'caption', name: 'Quote name', text: pct(p.quoteName), sizeLocked: true, autoH: false,
            box: { x: qtx, y: qHeadY, w: rx(0.4), h: Math.round(qNameFs * 1.3) },
            style: { fontSize: qNameFs, fontWeight: 800, color: NAME, align: 'left', lineHeight: 1.1, fontFamily: chirp } });
          const qHandle = T({ role: 'caption', name: 'Quote handle', text: pct(p.quoteHandle), sizeLocked: true, autoH: false,
            box: { x: qtx + Math.round(String(pct(p.quoteName)).length * qNameFs * 0.6) + rx(0.015), y: qHeadY + Math.round(qNameFs * 0.06), w: rx(0.4), h: Math.round(qHandleFs * 1.3) },
            style: { fontSize: qHandleFs, fontWeight: 400, color: MUTED, align: 'left', lineHeight: 1.1, fontFamily: chirp } });
          const qBody = T({ role: 'caption', name: 'Quote body', text: pct(p.quoteText), autoH: false, sizeLocked: true,
            box: { x: pad + qPad, y: qHeadY + qAv + ry(0.012), w: bodyW - qPad * 2, h: mediaH - qAv - qPad * 2 - ry(0.012) },
            style: { fontSize: qTextFs, fontWeight: 400, color: NAME, align: 'left', lineHeight: 1.32, fontFamily: chirp } });
          mediaGroup = groupLayers('Quote tweet', [qCard, qAvatar, qName, qHandle, qBody]);
        }
      }

      // ── Action row: reply · repost · like · bookmark (icon+count) + share ⬆ — all MONOCHROME
      //    grey like the real X chrome. Color-emoji (🔁/🔖) get replaced: repost → a "⇄" text
      //    glyph, bookmark → a drawn polyline ribbon outline (WebKit ignores the VS15 selector on
      //    those two). reply/like/share are text glyphs that already render monochrome. ────────────
      const actFs = fs(0.032);
      const slotDefs = [
        { key: 'reply', glyph: '💬︎', count: pct(p.replies) },
        { key: 'repost', glyph: '⇄', count: pct(p.reposts) },
        { key: 'like', glyph: '♥', count: pct(p.likes) },
        { key: 'bookmark', shape: true, count: pct(p.bookmarks) },
      ];
      const slotW = Math.round((w - pad * 2) / (slotDefs.length + 1)); // +1 slot for trailing share
      const actionNodes = [];
      slotDefs.forEach((s, i) => {
        const sx = pad + i * slotW;
        if (s.shape) {
          // bookmark ribbon outline (rounded rect with a bottom V-notch) as a monochrome polyline
          const iw = Math.round(actFs * 0.78), ih = Math.round(actFs * 1.02);
          const iy = rowY + Math.round((rowH - ih) / 2);
          actionNodes.push(S({ role: 'decor', name: 'Bookmark icon', box: { x: sx, y: iy, w: iw, h: ih },
            style: { shapeKind: 'polyline', background: MUTED,
              points: [0.06, 0.04, 0.94, 0.04, 0.94, 0.96, 0.5, 0.6, 0.06, 0.96, 0.06, 0.04],
              stroke: { color: MUTED, width: Math.max(2, Math.round(actFs * 0.09)) } } }));
          actionNodes.push(T({ role: 'caption', name: 'Bookmark count', text: s.count, sizeLocked: true, autoH: false,
            box: { x: sx + iw + Math.round(actFs * 0.45), y: rowY, w: slotW - iw, h: rowH },
            style: { fontSize: actFs, fontWeight: 400, color: MUTED, align: 'left', lineHeight: 1, fontFamily: chirp } }));
        } else {
          actionNodes.push(T({ role: 'caption', name: `${s.key} count`, text: `${s.glyph}  ${s.count}`, sizeLocked: true, autoH: false,
            box: { x: sx, y: rowY, w: slotW, h: rowH },
            style: { fontSize: actFs, fontWeight: 400, color: MUTED, align: 'left', lineHeight: 1, fontFamily: chirp } }));
        }
      });
      actionNodes.push(T({ role: 'caption', name: 'Share', text: '⬆', sizeLocked: true, autoH: false,
        box: { x: w - pad - Math.round(actFs * 1.6), y: rowY, w: Math.round(actFs * 1.6), h: rowH },
        style: { fontSize: actFs, fontWeight: 400, color: MUTED, align: 'right', lineHeight: 1, fontFamily: chirp } }));
      const actions = groupLayers('Actions', actionNodes);

      // clean Figma export: bg, Nav group, Header group, then a Body/Media/Meta/Actions content group
      return [bg, nav, header, groupLayers('Body', [...bodyNodes, mediaGroup, meta, actions])];
    },
  },

  {
    id: 'before-after',
    name: 'Before / After',
    hint: 'Serif headline, two labeled photo panels, product slot center, closing line (Wavy-style)',
    params: {
      headline: 'No need to ruin your hair to have perfect curls',
      leftLabel: 'Before', rightLabel: 'After',
      product: 'product tube', closing: 'This natural curl cream is all you need',
      bg: '#8fa88a',
    },
    build(doc, p, kit) {
      const { w, h, rx, ry, fs } = sized(doc);
      const frame = groupLayers('Frame', [
        S({ role: 'card', name: 'Background', box: { x: 0, y: 0, w, h }, style: { background: pct(p.bg) || '#8fa88a' } }),
        S({ role: 'card', name: 'Footer band', box: { x: 0, y: ry(0.84), w, h: ry(0.16) }, style: { background: '#f4f2ec' } }),
      ]);
      const headline = T({ role: 'headline', name: 'Headline', text: pct(p.headline), sizeLocked: true,
        box: { x: rx(0.07), y: ry(0.055), w: rx(0.86), h: ry(0.14) },
        style: { fontSize: fs(0.058), fontWeight: 500, color: '#ffffff', align: 'center', lineHeight: 1.18, fontFamily: FONT_SUGGEST.display } });
      const [ba] = buildElement('before-after', doc, { leftLabel: pct(p.leftLabel), rightLabel: pct(p.rightLabel) });
      const dy = ry(0.24) - ba.box.y;
      const shift = (n) => { n.box.y += dy; if (n.children) n.children.forEach(shift); };
      shift(ba);
      ba.name = 'Panels';
      const product = imageSlot(pct(p.product), { x: rx(0.41), y: ry(0.40), w: rx(0.18), h: ry(0.34) }, fs(0.012));
      const closing = T({ role: 'subhead', name: 'Closing', text: pct(p.closing), sizeLocked: true,
        box: { x: rx(0.10), y: ry(0.87), w: rx(0.80), h: ry(0.09) },
        style: { fontSize: fs(0.042), fontWeight: 500, color: '#5c7a56', align: 'center', lineHeight: 1.25, fontFamily: FONT_SUGGEST.display } });
      return [frame, headline, ba, product, closing];
    },
  },

  {
    id: 'comparison',
    name: 'Us vs Them',
    hint: 'Split background, bold headline, two product slots, ✓ rows vs ✗ rows (Craft-Cadence-style)',
    params: {
      headline: 'NOT ALL TPU TUBES ARE BUILT THE SAME!',
      leftTitle: 'OURS', rightTitle: 'THEIRS',
      leftItems: ['50% thicker for durability', 'Aluminium valve built to last', 'Works with electric pumps'],
      rightItems: ['Ultra-thin walls puncture', 'Weak resin valves melt', 'Fixed core. No repairs!'],
      leftBg: '#ffffff', rightBg: '#19a5b8', badge: 'BUY 3, GET 1 FREE!',
    },
    build(doc, p, kit) {
      const { w, h, rx, ry, fs } = sized(doc);
      const half = Math.round(w / 2);
      const frame = groupLayers('Frame', [
        S({ role: 'card', name: 'Left half', box: { x: 0, y: 0, w: half, h }, style: { background: pct(p.leftBg) || '#ffffff' } }),
        S({ role: 'card', name: 'Right half', box: { x: half, y: 0, w: w - half, h }, style: { background: pct(p.rightBg) || '#19a5b8' } }),
      ]);
      const headline = T({ role: 'headline', name: 'Headline', text: pct(p.headline), sizeLocked: true,
        box: { x: rx(0.06), y: ry(0.04), w: rx(0.88), h: ry(0.13) },
        style: { fontSize: fs(0.052), fontWeight: 800, color: '#111111', align: 'center', uppercase: true, lineHeight: 1.15 } });
      const products = groupLayers('Products', [
        imageSlot('our product', { x: rx(0.10), y: ry(0.20), w: rx(0.30), h: ry(0.30) }, fs(0.012)),
        imageSlot('their product', { x: rx(0.60), y: ry(0.20), w: rx(0.30), h: ry(0.30) }, fs(0.012)),
      ]);
      const [badge] = buildElement('badge', doc, { text: pct(p.badge) }, kit);
      badge.box.x = rx(0.30); badge.box.y = ry(0.40);
      const [table] = buildElement('comparison-table', doc, {
        leftTitle: pct(p.leftTitle), rightTitle: pct(p.rightTitle),
        leftItems: (p.leftItems || []).map(pct), rightItems: (p.rightItems || []).map(pct),
      }, kit);
      const dy = ry(0.55) - table.box.y;
      const shift = (n) => { n.box.y += dy; if (n.children) n.children.forEach(shift); };
      shift(table);
      table.name = 'Table';
      return [frame, headline, products, badge, table];
    },
  },

  {
    id: 'ig-dm',
    name: 'IG DM screenshot',
    hint: 'Instagram DM thread ad: white frame + caption, dark card, story-reply thumb, gray received bubbles, purple→blue gradient sent bubbles, New Messages divider, Replied-to quote',
    params: {
      caption: 'mfs are just always ready to hate 💀',
      storyImage: 'story selfie',
      blurAvatar: false, avatarEffect: 'none',
      // message model: from 'them' (gray, avatar) | 'me' (gradient, right) | 'divider' |
      // {reply: quoted text} attaches a Replied-to-you block above the NEXT them-bubble
      messages: [
        { from: 'them', text: 'buddy really got a perm 😭' },
        { from: 'me', text: 'swiping up on another man’s story to hate is diabolical lol' },
        { from: 'me', text: 'and it’s not a perm 🖕' },
        { divider: 'New Messages' },
        { from: 'them', text: 'you’re not fooling anyone bro 💀' },
        { from: 'them', text: 'then what is it? gods work?', reply: 'and it’s not a perm 🖕' },
        { from: 'me', text: 'just search based texture powder in amazon' },
        { from: 'me', text: 'get out my dm’s your worst than my girl' },
      ],
    },
    build(doc, p) {
      const { w, h, rx, ry, fs } = sized(doc);
      const frame = S({ role: 'card', name: 'Frame', box: { x: 0, y: 0, w, h }, style: { background: '#ffffff' } });
      const caption = T({ role: 'headline', name: 'Caption', text: pct(p.caption), sizeLocked: true,
        box: { x: rx(0.16), y: ry(0.175), w: rx(0.68), h: ry(0.035) },
        style: { fontSize: fs(0.039), fontWeight: 500, color: '#111318', align: 'left', lineHeight: 1.25, fontFamily: FONT_SUGGEST.instagram } });
      const thread = []; // DM card + every message/divider/quote/avatar — grouped as "Thread"
      // the DM card — sized from the message stack, capped to the frame
      const cardX = rx(0.165);
      const cardW = rx(0.67);
      const cardY = ry(0.225);
      const pad = Math.round(cardW * 0.05);
      const bubbleFs = fs(0.0295);
      const padX = Math.round(bubbleFs * 0.62); // style.padding is uniform — budget it on BOTH axes
      const lineH = Math.round(bubbleFs * 1.25); // Instagram DM sets a tight ~1.25 line-height
      const radius = Math.round(bubbleFs * 0.78);
      // Instagram DM bubbles: single-line bubbles are full pills; multi-line ones cap at ~18–22px.
      const bubbleRadiusCap = Math.round(bubbleFs * 0.9);
      const av = Math.round(cardW * 0.064);
      const maxBubbleW = Math.round(cardW * 0.80);
      const maxTextW = maxBubbleW - padX * 2;
      const gapInGroup = Math.round(bubbleFs * 0.28);
      const gapGroup = Math.round(bubbleFs * 0.85);

      const items = [];
      let cy = 0; // relative Y inside the card content area
      // story-reply thumbnail (portrait, rounded) at the top, them-side
      const thumbW = Math.round(cardW * 0.235);
      const thumbH = Math.round(thumbW * 1.5);
      items.push({ kind: 'thumb', x: pad + av + Math.round(bubbleFs * 0.5), y: cy, w: thumbW, h: thumbH });
      cy += thumbH + gapGroup;

      const msgs = Array.isArray(p.messages) ? p.messages : [];
      let prevFrom = null;
      for (let mi = 0; mi < msgs.length; mi++) {
        const m = msgs[mi];
        if (m && m.divider) {
          items.push({ kind: 'divider', y: cy, label: String(m.divider), mi });
          cy += Math.round(bubbleFs * 1.1) + gapGroup;
          prevFrom = null;
          continue;
        }
        if (!m || !m.text) continue;
        cy += prevFrom && prevFrom !== m.from ? gapGroup - gapInGroup : 0;
        if (m.reply) {
          // "Replied to you" label + quoted mini-bubble with its left bar
          items.push({ kind: 'label', y: cy, x: pad + av + Math.round(bubbleFs * 1.6), text: 'Replied to you' });
          cy += Math.round(bubbleFs * 1.15) + Math.round(gapInGroup / 2);
          const q = bubbleLines(m.reply, bubbleFs * 0.92, maxTextW * 0.8);
          const qw = Math.round(Math.min(maxBubbleW * 0.8, q.widest + padX * 2));
          const qh = Math.round(q.lines * lineH * 0.92 + padX * 2);
          items.push({ kind: 'quote', y: cy, x: pad + av + Math.round(bubbleFs * 1.6), w: qw, h: qh, text: String(m.reply), mi });
          cy += qh + gapInGroup;
        }
        const bl = bubbleLines(m.text, bubbleFs, maxTextW);
        const bw = Math.round(Math.min(maxBubbleW, bl.widest + padX * 2));
        const bh = Math.round(bl.lines * lineH + padX * 2);
        // a reply-quote visually breaks the group — the reference re-draws the avatar
        items.push({ kind: 'bubble', from: m.from, y: cy, w: bw, h: bh, text: String(m.text), mi, firstOfGroup: prevFrom !== m.from || !!m.reply });
        cy += bh + gapInGroup;
        prevFrom = m.from;
      }
      const contentH = cy - gapInGroup;
      const cardH = Math.min(h - cardY - ry(0.05), contentH + pad * 2);
      const contentY = cardY + pad;

      thread.push(S({ role: 'card', name: 'Card background', box: { x: cardX, y: cardY, w: cardW, h: cardH },
        style: { background: IG_CARD, radius: Math.round(cardW * 0.045) } }));

      for (const it of items) {
        const y = contentY + it.y;
        if (y + (it.h || lineH) > cardY + cardH - pad) break; // never overflow the card
        if (it.kind === 'thumb') {
          thread.push(imageSlot(pct(p.storyImage), { x: cardX + it.x, y, w: it.w, h: it.h }, Math.round(bubbleFs * 0.5)));
        } else if (it.kind === 'divider') {
          const midY = y + Math.round(bubbleFs * 0.5);
          const label = it.label;
          const lw = Math.round(label.length * bubbleFs * 0.8 * 0.52) + padX;
          const lineW = Math.round((cardW - pad * 2 - lw) / 2) - padX;
          thread.push(groupLayers('Divider', [
            S({ role: 'caption', name: 'Divider L', box: { x: cardX + pad, y: midY, w: lineW, h: 2 }, style: { background: '#3a3b3f' } }),
            T({ role: 'caption', name: 'Divider label', text: label, sizeLocked: true, autoH: false, tplRef: { key: 'messages', index: it.mi, field: 'divider' },
              box: { x: cardX + pad + lineW + padX, y: y, w: lw, h: Math.round(bubbleFs * 1.2) },
              style: { fontSize: Math.round(bubbleFs * 0.8), fontWeight: 400, color: IG_MUTED, align: 'center', lineHeight: 1.2, fontFamily: FONT_SUGGEST.instagram } }),
            S({ role: 'caption', name: 'Divider R', box: { x: cardX + pad + lineW + padX * 2 + lw, y: midY, w: lineW, h: 2 }, style: { background: '#3a3b3f' } }),
          ]));
        } else if (it.kind === 'label') {
          thread.push(T({ role: 'caption', name: 'Replied label', text: it.text, sizeLocked: true, autoH: false,
            box: { x: cardX + it.x, y, w: Math.round(cardW * 0.4), h: Math.round(bubbleFs * 1.1) },
            style: { fontSize: Math.round(bubbleFs * 0.75), fontWeight: 400, color: IG_MUTED, align: 'left', lineHeight: 1.2, fontFamily: FONT_SUGGEST.instagram } }));
        } else if (it.kind === 'quote') {
          const t = (it.y + it.h / 2) / Math.max(1, contentH);
          thread.push(groupLayers('Reply quote', [
            S({ role: 'caption', name: 'Quote bar', box: { x: cardX + it.x - Math.round(bubbleFs * 0.55), y, w: 3, h: it.h }, style: { background: '#55565c', radius: 2 } }),
            T({ role: 'caption', name: 'Quoted bubble', text: it.text, sizeLocked: true, autoH: false, tplRef: { key: 'messages', index: it.mi, field: 'reply' },
              box: { x: cardX + it.x, y, w: it.w, h: it.h },
              style: { fontSize: Math.round(bubbleFs * 0.92), fontWeight: 400, color: '#e6e6ec',
                background: lerpHex(lerpHex(IG_SENT_TOP, IG_SENT_BOTTOM, t), IG_CARD, 0.45),
                radius, padding: Math.round(padX * 0.85), align: 'left', lineHeight: 1.25, fontFamily: FONT_SUGGEST.instagram } }),
          ]));
        } else if (it.kind === 'bubble' && it.from === 'them') {
          const msg = T({ role: 'caption', name: 'Their message', text: it.text, sizeLocked: true, autoH: false, tplRef: { key: 'messages', index: it.mi, field: 'text' },
            box: { x: cardX + pad + av + Math.round(bubbleFs * 0.5), y, w: it.w, h: it.h },
            style: { fontSize: bubbleFs, fontWeight: 400, color: '#e9e9ee', background: IG_RECEIVED,
              radius: Math.min(Math.round(it.h / 2), bubbleRadiusCap), padding: padX, align: 'left', lineHeight: 1.25, fontFamily: FONT_SUGGEST.instagram } });
          if (it.firstOfGroup) {
            const avatar = avatarShape({
              role: 'avatar', name: 'Avatar', box: { x: cardX + pad, y: y + it.h - av, w: av, h: av },
              gradient: { type: 'linear', angle: 135, stops: [{ color: '#8a9bb8', pos: 0 }, { color: '#3e4a61', pos: 1 }] },
            }, avatarEffectOf(p));
            thread.push(groupLayers('Them message', [avatar, msg]));
          } else {
            thread.push(msg);
          }
        } else if (it.kind === 'bubble') {
          // sent: sample Instagram's vertical purple→blue by position in the thread
          const t = (it.y + it.h / 2) / Math.max(1, contentH);
          thread.push(T({ role: 'caption', name: 'My message', text: it.text, sizeLocked: true, autoH: false, tplRef: { key: 'messages', index: it.mi, field: 'text' },
            box: { x: cardX + cardW - pad - it.w, y, w: it.w, h: it.h },
            style: { fontSize: bubbleFs, fontWeight: 400, color: '#ffffff',
              background: lerpHex(IG_SENT_TOP, IG_SENT_BOTTOM, t),
              radius: Math.min(Math.round(it.h / 2), bubbleRadiusCap), padding: padX, align: 'left', lineHeight: 1.25, fontFamily: FONT_SUGGEST.instagram } }));
        }
      }
      // Top-level: Frame, Caption, and the thread wrapped as one 'DM card' group (its box spans
      // the card since the card background is its outermost child) — a tidy Figma export.
      return [frame, caption, groupLayers('DM card', thread)];
    },
  },

  {
    id: 'offer-hero',
    name: 'Offer hero',
    hint: 'Over-photo offer: serif save-headline, was/now price line, benefit chips row (Cadence-style)',
    params: {
      logo: 'Cadence', headline: 'Save £48 on Your First Bundle',
      priceLine: 'Normally £104.97 · Now Just £56.92',
      chips: ['+ 3 Flavours', '0 Sugar', 'Complete Electrolytes'],
    },
    build(doc, p) {
      const { w, rx, ry, fs } = sized(doc);
      // A taller top scrim guarantees the whole offer block reads white-on-dark, and a real
      // vertical rhythm (logo → headline → price → chips) with generous, non-overlapping gaps.
      const scrim = S({ role: 'scrim', name: 'Top scrim', box: { x: 0, y: 0, w, h: ry(0.40) },
        style: { background: '#000000', gradient: 'to-bottom', opacity: 0.55 } });
      const logo = T({ role: 'badge', name: 'Logo', text: pct(p.logo), sizeLocked: true,
        box: { x: rx(0.20), y: ry(0.045), w: rx(0.60), h: ry(0.045) },
        style: { fontSize: fs(0.044), fontWeight: 800, color: '#ffffff', align: 'center', letterSpacing: 2, lineHeight: 1.1, fontFamily: FONT_SUGGEST.display } });
      const headline = T({ role: 'headline', name: 'Offer headline', text: pct(p.headline), sizeLocked: true,
        box: { x: rx(0.06), y: ry(0.11), w: rx(0.88), h: ry(0.13) },
        style: { fontSize: fs(0.064), fontWeight: 600, color: '#ffffff', align: 'center', lineHeight: 1.12, fontFamily: FONT_SUGGEST.display } });
      const priceLine = T({ role: 'subhead', name: 'Price line', text: pct(p.priceLine), sizeLocked: true,
        box: { x: rx(0.08), y: ry(0.225), w: rx(0.84), h: ry(0.045) },
        style: { fontSize: fs(0.036), fontWeight: 700, color: '#ffe8b0', align: 'center', lineHeight: 1.2 } });
      // benefit chips row — solid white pills, measured to hug their label + even gaps, centered.
      const chips = (p.chips || []).map(pct).slice(0, 4);
      const chipFs = fs(0.028);
      const chipH = Math.round(chipFs * 2.4);
      const gap = rx(0.02);
      const widths = chips.map((c) => Math.round(c.length * chipFs * 0.56 + chipFs * 2.0));
      const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, chips.length - 1);
      let cx = Math.round((w - total) / 2);
      const chipY = ry(0.29);
      const chipNodes = chips.map((c, i) => {
        const node = T({
          role: 'badge', name: `Chip ${i + 1}`, text: c, sizeLocked: true, autoH: false,
          box: { x: cx, y: chipY, w: widths[i], h: chipH },
          style: { fontSize: chipFs, fontWeight: 700, color: '#15243a', background: '#ffffff', radius: chipH, align: 'center', lineHeight: 1 },
        });
        cx += widths[i] + gap;
        return node;
      });
      const parts = [scrim, logo, headline, priceLine];
      if (chipNodes.length) parts.push(groupLayers('Chips', chipNodes));
      return parts;
    },
  },

  {
    id: 'apple-notes',
    name: 'Apple Notes',
    hint: 'iOS Notes screen: yellow ‹ Notes / Done nav, bold SF headline, • bullet list, product slot, footnote (bench 011)',
    params: {
      title: 'Why I finally switched my whole routine',
      items: [
        'Holds all day — no midday flop',
        'Zero grease, zero crunch',
        'Restyles with just your fingers',
        'One pump lasts the whole week',
      ],
      footnote: 'Not sponsored. Just what actually worked for my hair.',
      product: 'product tube',
    },
    build(doc, p) {
      const { w, h, rx, ry, fs } = sized(doc);
      const sf = FONT_SUGGEST.sf;
      // iOS Notes (light): nav/back/share/more accent is the REAL Apple gold #E2AE0C (not the
      // researched-approximation #ffcc00 used before — ground truth from Michael's own traced
      // screenshot, lib/notes-icons.mjs NOTES_REAL_COLORS.navGold), note bg #FFFFFF, title black
      // bold ~22pt, body black regular ~17pt. 'Done' stays text (no real asset for it), bold.
      const GOLD = NOTES_REAL_COLORS.navGold, INK = '#1c1c1e', MUTED = '#8a8a8e';
      const pad = rx(0.06);
      // ── Nav row: ‹ Notes (left, REAL chevron path + text) — ↑ share + ⋯ more (REAL paths) +
      //    Done (right, text) — sized/spaced off the real source SVG's own proportions ──────────
      const navY = ry(0.05), navH = ry(0.035);
      const chevS = Math.round(navH * 0.72); // real chevron's own aspect is ~30.4w:52.3h (tall)
      const chevW = Math.round(chevS * (30.44 / 52.27));
      const chevron = iconShape({ role: 'decor', name: 'Back chevron', box: { x: pad, y: navY + Math.round((navH - chevS) / 2), w: chevW, h: chevS } }, NOTES_CHEVRON_BACK);
      const back = T({ role: 'caption', name: 'Back label', text: 'Notes', sizeLocked: true, autoH: false,
        box: { x: pad + chevW + rx(0.012), y: navY, w: rx(0.26), h: navH },
        style: { fontSize: fs(0.036), fontWeight: 500, color: GOLD, align: 'left', lineHeight: 1, fontFamily: sf } });
      const doneW = rx(0.16);
      const done = T({ role: 'caption', name: 'Done', text: 'Done', sizeLocked: true, autoH: false,
        box: { x: w - pad - doneW, y: navY, w: doneW, h: navH },
        style: { fontSize: fs(0.036), fontWeight: 700, color: GOLD, align: 'right', lineHeight: 1, fontFamily: sf } });
      // "More" badge: REAL ring path + REAL 3-dot path, composed as two separate editable layers
      // (matches the source: a donut ring + a compound 3-dot glyph centered inside it).
      const moreS = Math.round(navH * 0.92);
      const moreX = w - pad - doneW - rx(0.10) - moreS;
      const moreY = navY - Math.round((moreS - navH) / 2);
      const moreRing = iconShape({ role: 'decor', name: 'More ring', box: { x: moreX, y: moreY, w: moreS, h: moreS } }, NOTES_MORE_CIRCLE_RING);
      const hb = NOTES_MORE_CIRCLE_HOLE_BOX;
      const moreHole = iconShape({ role: 'decor', name: 'More ring hole', box: { x: moreX + Math.round(hb.x * moreS), y: moreY + Math.round(hb.y * moreS), w: Math.round(hb.w * moreS), h: Math.round(hb.h * moreS) } }, NOTES_MORE_CIRCLE_HOLE);
      const dotsW = Math.round(moreS * 0.6), dotsH = Math.round(moreS * 0.14);
      const moreDots = iconShape({ role: 'decor', name: 'More dots', box: { x: moreX + Math.round((moreS - dotsW) / 2), y: moreY + Math.round((moreS - dotsH) / 2), w: dotsW, h: dotsH } }, NOTES_MORE_DOTS);
      // Share icon: REAL bracket+arrow compound path, own aspect ~52w:66.6h.
      const shareH = Math.round(navH * 1.02);
      const shareW = Math.round(shareH * (51.99 / 66.61));
      const shareX = moreX - rx(0.05) - shareW;
      const share = iconShape({ role: 'decor', name: 'Share icon', box: { x: shareX, y: navY - Math.round((shareH - navH) / 2), w: shareW, h: shareH } }, NOTES_SHARE_ICON);
      const nav = groupLayers('Nav', [chevron, back, share, moreRing, moreHole, moreDots, done]);
      // ── Headline: bold near-black SF, heavy ──
      const headline = T({ role: 'headline', name: 'Headline', text: pct(p.title), sizeLocked: true,
        box: { x: pad, y: ry(0.13), w: w - pad * 2, h: ry(0.12) },
        style: { fontSize: fs(0.066), fontWeight: 800, color: INK, align: 'left', lineHeight: 1.12, fontFamily: sf } });
      // ── Bulleted list: • mark + item text per row ──
      const items = (Array.isArray(p.items) ? p.items : []).map(pct).filter(Boolean).slice(0, 10);
      const rowH = ry(0.064);
      const bulletFs = fs(0.042);
      const listY = ry(0.28);
      const bulletNodes = [];
      items.forEach((it, i) => {
        const y = listY + i * rowH;
        // Both cells are autoH:false and share the SAME rowH box, so the flex vertical-centering
        // (.text align-items:center) lands the • and its item on one baseline — the old autoH item
        // re-measured to a shorter box and drifted a few px above its bullet.
        bulletNodes.push(
          T({ role: 'caption', name: `Bullet ${i + 1}`, text: '•', sizeLocked: true, autoH: false,
            box: { x: pad, y, w: rx(0.05), h: rowH },
            style: { fontSize: bulletFs, fontWeight: 700, color: INK, align: 'center', lineHeight: 1.3, fontFamily: sf } }),
          T({ role: 'caption', name: `Item ${i + 1}`, text: it, sizeLocked: true, autoH: false,
            tplRef: { key: 'items', index: i },
            box: { x: pad + rx(0.06), y, w: w - pad * 2 - rx(0.06), h: rowH },
            style: { fontSize: bulletFs, fontWeight: 400, color: INK, align: 'left', lineHeight: 1.3, fontFamily: sf } }),
        );
      });
      const bullets = groupLayers('Bullets', bulletNodes);
      // ── Product image slot bottom-right (optional) ──
      const prodW = rx(0.32), prodH = rx(0.32);
      const product = imageSlot(pct(p.product), { x: w - pad - prodW, y: h - ry(0.06) - prodH, w: prodW, h: prodH }, fs(0.02));
      // ── Footnote/disclaimer bottom-left, small bold ──
      const footnote = T({ role: 'caption', name: 'Footnote', text: pct(p.footnote), sizeLocked: true,
        box: { x: pad, y: h - ry(0.10), w: rx(0.55), h: ry(0.08) },
        style: { fontSize: fs(0.026), fontWeight: 600, color: MUTED, align: 'left', lineHeight: 1.3, fontFamily: sf } });
      const bg = S({ role: 'card', name: 'Note bg', box: { x: 0, y: 0, w, h }, style: { background: '#ffffff' } });
      return [bg, nav, headline, bullets, product, footnote];
    },
  },

  {
    id: 'stat-chart',
    name: 'Stat chart',
    hint: 'Data ad: giant stat + ↓ ring, subhead, citation, filled area line-chart w/ WEEK labels, product on chart, pill, caption (bench 107)',
    params: {
      stat: '58%',
      subhead: 'more volume after 4 weeks of daily use',
      citation: 'Based on a 5-week self-reported user panel (n=214).',
      weeks: ['WEEK 1', 'WEEK 2', 'WEEK 3', 'WEEK 4', 'WEEK 5'],
      pillLabel: 'DAILY HYDRATION',
      caption: 'Consistency compounds. The bottle empties, the results stack.',
      product: 'product bottle',
    },
    build(doc, p) {
      const { w, h, rx, ry, fs } = sized(doc);
      const INK = '#15243a', SUB = '#5a6b82', ACCENT = '#2c5cff';
      const bg = S({ role: 'card', name: 'Chart bg', box: { x: 0, y: 0, w, h }, style: { background: '#eef3f8' } });
      // ── Giant stat headline + circled ↓ arrow to its left ──
      const statY = ry(0.07);
      const ringS = rx(0.12);
      const arrowRing = S({ role: 'badge', name: 'Trend ring', box: { x: rx(0.06), y: statY + rx(0.02), w: ringS, h: ringS },
        style: { shapeKind: 'ellipse', background: '#ffffff', stroke: { color: ACCENT, width: Math.max(3, Math.round(w * 0.006)) } } });
      const arrow = T({ role: 'badge', name: 'Trend arrow', text: '↓', sizeLocked: true, autoH: false,
        box: { x: rx(0.06), y: statY + rx(0.02), w: ringS, h: ringS },
        style: { fontSize: Math.round(ringS * 0.6), fontWeight: 800, color: ACCENT, align: 'center', lineHeight: 1, fontFamily: FONT_SUGGEST.sf } });
      const stat = T({ role: 'headline', name: 'Stat', text: pct(p.stat), sizeLocked: true,
        box: { x: rx(0.20), y: statY, w: rx(0.74), h: ry(0.14) },
        style: { fontSize: fs(0.17), fontWeight: 800, color: INK, align: 'left', lineHeight: 1, letterSpacing: -2, fontFamily: FONT_SUGGEST.sf } });
      const subhead = T({ role: 'subhead', name: 'Subhead', text: pct(p.subhead), sizeLocked: true,
        box: { x: rx(0.06), y: ry(0.24), w: rx(0.88), h: ry(0.08) },
        style: { fontSize: fs(0.044), fontWeight: 600, color: INK, align: 'left', lineHeight: 1.2, fontFamily: FONT_SUGGEST.sf } });
      const citation = T({ role: 'caption', name: 'Citation', text: pct(p.citation), sizeLocked: true,
        box: { x: rx(0.06), y: ry(0.325), w: rx(0.88), h: ry(0.03) },
        style: { fontSize: fs(0.024), fontWeight: 400, color: SUB, align: 'left', lineHeight: 1.25, fontFamily: FONT_SUGGEST.sf } });
      const statGroup = groupLayers('Stat', [arrowRing, arrow, stat, subhead, citation]);
      // ── Filled area line-chart: rising polyline + area fill + week labels ──
      const cx = rx(0.06), cy = ry(0.40), cw = rx(0.88), chH = ry(0.34);
      const pts = [0.12, 0.30, 0.44, 0.68, 0.92]; // rising curve (0..1 of chart height)
      const poly = []; // x,y pairs 0..1 for a polyline over the chart box
      pts.forEach((v, i) => poly.push(i / (pts.length - 1), 1 - v));
      const area = S({ role: 'chart', name: 'Area fill', box: { x: cx, y: cy, w: cw, h: chH },
        style: { shapeKind: 'polyline', points: [...poly, 1, 1, 0, 1], background: ACCENT, opacity: 0.16 } });
      const line = S({ role: 'chart', name: 'Trend line', box: { x: cx, y: cy, w: cw, h: chH },
        style: { shapeKind: 'polyline', points: poly, background: ACCENT, stroke: { color: ACCENT, width: Math.max(4, Math.round(w * 0.008)) } } });
      const baseline = S({ role: 'chart', name: 'Baseline', box: { x: cx, y: cy + chH, w: cw, h: 2 }, style: { background: '#c7d2e0' } });
      const weeks = (Array.isArray(p.weeks) ? p.weeks : []).map(pct).filter(Boolean).slice(0, 8);
      const nl = Math.max(1, weeks.length);
      const labelW = rx(0.16);
      const weekNodes = weeks.map((lb, i) => {
        const center = cx + Math.round((nl === 1 ? 0.5 : i / (nl - 1)) * cw);
        // clamp so the first/last labels don't spill past the canvas edges
        const lx = Math.max(0, Math.min(w - labelW, center - Math.round(labelW / 2)));
        return T({
          role: 'caption', name: `Week ${i + 1}`, text: lb, sizeLocked: true, autoH: false,
          tplRef: { key: 'weeks', index: i },
          box: { x: lx, y: cy + chH + ry(0.012), w: labelW, h: ry(0.025) },
          style: { fontSize: fs(0.02), fontWeight: 700, color: SUB, align: 'center', lineHeight: 1, letterSpacing: 0.5, fontFamily: FONT_SUGGEST.sf },
        });
      });
      const chart = groupLayers('Chart', [area, line, baseline, groupLayers('Week labels', weekNodes)]);
      // ── Product image slot ON the chart near the end of the curve ──
      // Anchor its bottom to the curve's last point; clamp the top INSIDE the chart band so it
      // never floats up over the citation/subhead (the old formula pushed it ~120px above cy).
      const prodW = rx(0.26), prodH = rx(0.26);
      const curveY = cy + Math.round(chH * (1 - pts[pts.length - 1]));
      const prodY = Math.max(cy + ry(0.01), curveY - Math.round(prodH * 0.72));
      const product = imageSlot(pct(p.product), { x: cx + cw - prodW - rx(0.02), y: prodY, w: prodW, h: prodH }, fs(0.02));
      // ── Colored pill label ──
      const pillTxt = pct(p.pillLabel);
      const pillFs = fs(0.03);
      const pillW = Math.round(pillTxt.length * pillFs * 0.62 + pillFs * 2.2);
      const pillH = Math.round(pillFs * 2.2);
      const pill = T({ role: 'badge', name: 'Pill label', text: pillTxt, sizeLocked: true, autoH: false,
        box: { x: cx, y: cy + chH + ry(0.05), w: pillW, h: pillH },
        style: { fontSize: pillFs, fontWeight: 700, color: '#ffffff', background: ACCENT, radius: pillH, align: 'center', uppercase: true, letterSpacing: 0.5, lineHeight: 1, fontFamily: FONT_SUGGEST.sf } });
      // ── Bottom caption paragraph ──
      const caption = T({ role: 'caption', name: 'Caption', text: pct(p.caption), sizeLocked: true,
        box: { x: cx, y: h - ry(0.10), w: rx(0.88), h: ry(0.08) },
        style: { fontSize: fs(0.03), fontWeight: 400, color: SUB, align: 'left', lineHeight: 1.35, fontFamily: FONT_SUGGEST.sf } });
      return [bg, statGroup, chart, product, pill, caption];
    },
  },

  {
    id: 'ig-feed-post',
    name: 'IG feed post',
    hint: 'Instagram feed post: avatar+username+⋯ top bar, square photo, like/comment/share + save row, "liked by" + bold-username caption (bench IG-feed)',
    params: {
      username: 'simpletics', verified: true,
      photo: 'lifestyle photo',
      likedBy: 'jordan_h', likes: '2,418',
      caption: 'flat hair had me insecure for years — this texture powder actually gave it volume that lasts all day',
      likesLabel: 'others',
      avatarEffect: 'none', blurAvatar: false,
    },
    build(doc, p) {
      const { w, h, rx, ry, fs } = sized(doc);
      const ig = FONT_SUGGEST.instagram;
      // Instagram feed (light): near-black icons/text #262626, verified blue #0095F6,
      // hairline #DBDBDB, muted grey #737373.
      const INK = '#262626', MUTED = '#737373', LINE = '#dbdbdb', BLUE = '#0095f6';
      const pad = rx(0.035);
      const bg = S({ role: 'card', name: 'Feed bg', box: { x: 0, y: 0, w, h }, style: { background: '#ffffff' } });

      // ── Top bar: avatar · username (+ blue check) · ⋯ ──────────────────────────────────────────
      const barH = ry(0.062);
      const av = Math.round(barH * 0.66);
      const barY = ry(0.02);
      const avCy = barY + Math.round((barH - av) / 2);
      const avatar = avatarShape({
        role: 'avatar', name: 'Avatar', box: { x: pad, y: avCy, w: av, h: av },
        gradient: { type: 'linear', angle: 135, stops: [{ color: '#feda75', pos: 0 }, { color: '#d62976', pos: 0.5 }, { color: '#962fbf', pos: 1 }] },
      }, avatarEffectOf(p));
      const nameFs = fs(0.032);
      const utx = pad + av + rx(0.025);
      const unameW = Math.ceil(String(pct(p.username)).length * nameFs * 0.58);
      const uname = T({ role: 'caption', name: 'Username', text: pct(p.username), sizeLocked: true, autoH: false,
        box: { x: utx, y: barY + Math.round((barH - nameFs * 1.3) / 2), w: unameW, h: Math.round(nameFs * 1.3) },
        style: { fontSize: nameFs, fontWeight: 700, color: INK, align: 'left', lineHeight: 1.2, fontFamily: ig } });
      const checkS = Math.round(nameFs * 0.95);
      const uCheck = p.verified && T({ role: 'badge', name: 'Verified', text: '✔', sizeLocked: true, autoH: false,
        box: { x: utx + unameW + rx(0.012), y: barY + Math.round((barH - checkS) / 2), w: checkS, h: checkS },
        style: { fontSize: Math.round(checkS * 0.62), fontWeight: 900, color: '#ffffff', background: BLUE, radius: checkS, align: 'center', lineHeight: 1, fontFamily: ig } });
      const more = T({ role: 'caption', name: 'More', text: '⋯', sizeLocked: true, autoH: false,
        box: { x: w - pad - rx(0.08), y: barY, w: rx(0.08), h: barH },
        style: { fontSize: fs(0.05), fontWeight: 700, color: INK, align: 'right', lineHeight: 1, fontFamily: ig } });
      const topBar = groupLayers('Top bar', [avatar, uname, uCheck, more]);

      // ── Square photo area (1:1, full-bleed width) ──────────────────────────────────────────────
      const photoY = barY + barH + ry(0.008);
      const photoSide = Math.min(w, ry(0.5));
      const photo = imageSlot(pct(p.photo), { x: 0, y: photoY, w, h: photoSide }, 0);

      // ── Action row: ♡ heart · ⬭ speech bubble · ➤ paper-plane (left) · ⌵ save ribbon (right) ──────
      //    All drawn as MONOCHROME polylines (like the x-post-ad bookmark) so no color-emoji leaks
      //    through — matching Instagram's thin outline icon set exactly. ─────────────────────────────
      const rowY = photoY + photoSide + ry(0.012);
      const iconFs = fs(0.055);
      const iconRowH = Math.round(iconFs * 1.2);
      const iconStroke = Math.max(2, Math.round(iconFs * 0.055));
      const iconY = rowY + Math.round((iconRowH - iconFs) / 2);
      const gapI = rx(0.125);
      const polyIcon = (name, gx, w0, h0, points) => S({ role: 'decor', name,
        box: { x: gx, y: iconY + Math.round((iconFs - h0) / 2), w: w0, h: h0 },
        style: { shapeKind: 'polyline', background: '#ffffff', points, stroke: { color: INK, width: iconStroke } } });
      // heart outline (two lobes meeting at a bottom point), speech-bubble (rounded rect + tail),
      // paper-plane (triangle), bookmark ribbon (rect w/ bottom V-notch) — all normalized 0..1.
      const heartW = Math.round(iconFs * 1.02);
      const bubbleW = Math.round(iconFs * 0.98);
      const planeW = Math.round(iconFs * 1.0);
      const saveW = Math.round(iconFs * 0.66), saveH = Math.round(iconFs * 0.9);
      const actions = groupLayers('Actions', [
        polyIcon('Like', pad, heartW, iconFs,
          [0.5, 0.95, 0.06, 0.5, 0.06, 0.28, 0.25, 0.1, 0.5, 0.24, 0.75, 0.1, 0.94, 0.28, 0.94, 0.5, 0.5, 0.95]),
        polyIcon('Comment', pad + gapI, bubbleW, iconFs,
          [0.1, 0.08, 0.9, 0.08, 0.9, 0.72, 0.5, 0.72, 0.28, 0.92, 0.3, 0.72, 0.1, 0.72, 0.1, 0.08]),
        polyIcon('Share', pad + gapI * 2, planeW, iconFs,
          [0.94, 0.08, 0.06, 0.42, 0.44, 0.56, 0.5, 0.92, 0.94, 0.08, 0.44, 0.56]),
        // bookmark/save ribbon far-right
        polyIcon('Save', w - pad - saveW, saveW, saveH,
          [0.08, 0.04, 0.92, 0.04, 0.92, 0.96, 0.5, 0.62, 0.08, 0.96, 0.08, 0.04]),
      ]);

      // ── Meta: "liked by X and N others" + caption (bold username · caption) ─────────────────────
      const metaY = rowY + iconRowH + ry(0.014);
      const likedFs = fs(0.03);
      const likedBy = T({ role: 'caption', name: 'Liked by', text: `Liked by ${pct(p.likedBy)} and ${pct(p.likes)} ${pct(p.likesLabel) || 'others'}`, sizeLocked: true, autoH: false,
        box: { x: pad, y: metaY, w: w - pad * 2, h: Math.round(likedFs * 1.4) },
        style: { fontSize: likedFs, fontWeight: 400, color: INK, align: 'left', lineHeight: 1.3, fontFamily: ig } });
      const capFs = fs(0.03);
      const capY = metaY + Math.round(likedFs * 1.7);
      const capNameW = Math.round(String(pct(p.username)).length * capFs * 0.62) + rx(0.02);
      const capName = T({ role: 'caption', name: 'Caption username', text: pct(p.username), sizeLocked: true, autoH: false,
        box: { x: pad, y: capY, w: capNameW, h: Math.round(capFs * 1.4) },
        style: { fontSize: capFs, fontWeight: 700, color: INK, align: 'left', lineHeight: 1.35, fontFamily: ig } });
      const capText = T({ role: 'caption', name: 'Caption', text: pct(p.caption), autoH: false, sizeLocked: true,
        box: { x: pad + capNameW, y: capY, w: w - pad * 2 - capNameW, h: h - capY - ry(0.03) },
        style: { fontSize: capFs, fontWeight: 400, color: INK, align: 'left', lineHeight: 1.35, fontFamily: ig } });
      const meta = groupLayers('Meta', [likedBy, capName, capText]);

      return [bg, topBar, photo, actions, meta];
    },
  },

  {
    id: 'notes-checklist',
    name: 'Apple Notes checklist',
    hint: 'iOS Notes checklist: yellow ‹ Notes / Done nav, bold title, rounded ☑/☐ checkbox rows (done items greyed + struck), footnote (bench Notes-check)',
    params: {
      title: 'My switch-everything checklist',
      items: [
        'Swap to the texture powder ✓',
        'Stop over-washing (every other day)',
        'Blow-dry up and back, not down',
        'Finish with sea-salt spray',
        'Never touch gel again',
      ],
      done: [true, true, false, false, false],
      footnote: 'Saved to my Notes so I actually stick to it.',
    },
    build(doc, p) {
      const { w, h, rx, ry, fs } = sized(doc);
      const sf = FONT_SUGGEST.sf;
      // iOS Notes (light): nav/back/share/more accent is the REAL Apple gold #E2AE0C; checklist
      // done = the REAL checked-badge (filled #FDB902 circle + white checkmark, both traced from
      // Michael's own screenshot — lib/notes-icons.mjs) replacing the old researched #FFD60A
      // ellipse + text-glyph. NO strikethrough — iOS Notes leaves completed text upright, only
      // greyed slightly.
      const GOLD = NOTES_REAL_COLORS.navGold, INK = '#1c1c1e', MUTED = '#8a8a8e';
      const pad = rx(0.06);
      const bg = S({ role: 'card', name: 'Note bg', box: { x: 0, y: 0, w, h }, style: { background: '#ffffff' } });
      // ── Nav row: ‹ Notes (left, REAL chevron path + text) — ↑ share + ⋯ more (REAL paths) +
      //    Done (right, text) — same real-asset composition as the apple-notes template ────────
      const navY = ry(0.05), navH = ry(0.035);
      const chevS = Math.round(navH * 0.72);
      const chevW = Math.round(chevS * (30.44 / 52.27));
      const chevron = iconShape({ role: 'decor', name: 'Back chevron', box: { x: pad, y: navY + Math.round((navH - chevS) / 2), w: chevW, h: chevS } }, NOTES_CHEVRON_BACK);
      const back = T({ role: 'caption', name: 'Back label', text: 'Notes', sizeLocked: true, autoH: false,
        box: { x: pad + chevW + rx(0.012), y: navY, w: rx(0.26), h: navH },
        style: { fontSize: fs(0.036), fontWeight: 500, color: GOLD, align: 'left', lineHeight: 1, fontFamily: sf } });
      const doneW = rx(0.16);
      const done = T({ role: 'caption', name: 'Done', text: 'Done', sizeLocked: true, autoH: false,
        box: { x: w - pad - doneW, y: navY, w: doneW, h: navH },
        style: { fontSize: fs(0.036), fontWeight: 700, color: GOLD, align: 'right', lineHeight: 1, fontFamily: sf } });
      const moreS = Math.round(navH * 0.92);
      const moreX = w - pad - doneW - rx(0.10) - moreS;
      const moreY = navY - Math.round((moreS - navH) / 2);
      const moreRing = iconShape({ role: 'decor', name: 'More ring', box: { x: moreX, y: moreY, w: moreS, h: moreS } }, NOTES_MORE_CIRCLE_RING);
      const hb = NOTES_MORE_CIRCLE_HOLE_BOX;
      const moreHole = iconShape({ role: 'decor', name: 'More ring hole', box: { x: moreX + Math.round(hb.x * moreS), y: moreY + Math.round(hb.y * moreS), w: Math.round(hb.w * moreS), h: Math.round(hb.h * moreS) } }, NOTES_MORE_CIRCLE_HOLE);
      const dotsW = Math.round(moreS * 0.6), dotsH = Math.round(moreS * 0.14);
      const moreDots = iconShape({ role: 'decor', name: 'More dots', box: { x: moreX + Math.round((moreS - dotsW) / 2), y: moreY + Math.round((moreS - dotsH) / 2), w: dotsW, h: dotsH } }, NOTES_MORE_DOTS);
      const shareH = Math.round(navH * 1.02);
      const shareW = Math.round(shareH * (51.99 / 66.61));
      const shareX = moreX - rx(0.05) - shareW;
      const share = iconShape({ role: 'decor', name: 'Share icon', box: { x: shareX, y: navY - Math.round((shareH - navH) / 2), w: shareW, h: shareH } }, NOTES_SHARE_ICON);
      const nav = groupLayers('Nav', [chevron, back, share, moreRing, moreHole, moreDots, done]);
      // ── Headline ──
      const headline = T({ role: 'headline', name: 'Headline', text: pct(p.title), sizeLocked: true,
        box: { x: pad, y: ry(0.13), w: w - pad * 2, h: ry(0.12) },
        style: { fontSize: fs(0.06), fontWeight: 800, color: INK, align: 'left', lineHeight: 1.12, fontFamily: sf } });
      // ── Checklist: rounded checkbox (REAL done badge when checked) + item text ──
      const items = (Array.isArray(p.items) ? p.items : []).map(pct).filter(Boolean).slice(0, 10);
      const doneFlags = Array.isArray(p.done) ? p.done : [];
      const rowH = ry(0.066);
      const listY = ry(0.27);
      const boxS = Math.round(rowH * 0.42);
      const itemFs = fs(0.04);
      const checkNodes = [];
      items.forEach((it, i) => {
        const y = listY + i * rowH;
        const isDone = !!doneFlags[i];
        const cbY = y + Math.round((rowH - boxS) / 2);
        if (isDone) {
          // REAL done badge: gold circle (own path) + white checkmark, positioned as a nested
          // sub-box measured directly from the two source paths' own bboxes (notes-icons.mjs
          // NOTES_CHECKLIST_DONE_CHECK_BOX) — two separate editable layers, not one flat image.
          checkNodes.push(iconShape({ role: 'decor', name: `Checkbox ${i + 1}`, box: { x: pad, y: cbY, w: boxS, h: boxS } }, NOTES_CHECKLIST_DONE_CIRCLE));
          const cb = NOTES_CHECKLIST_DONE_CHECK_BOX;
          checkNodes.push(iconShape({ role: 'decor', name: `Check ${i + 1}`,
            box: { x: pad + Math.round(cb.x * boxS), y: cbY + Math.round(cb.y * boxS), w: Math.round(cb.w * boxS), h: Math.round(cb.h * boxS) } }, NOTES_CHECKLIST_DONE_CHECK));
        } else {
          // Not-done: hollow grey ring (no real asset needed — iOS just shows an empty circle).
          checkNodes.push(S({ role: 'decor', name: `Checkbox ${i + 1}`, box: { x: pad, y: cbY, w: boxS, h: boxS },
            style: { shapeKind: 'ellipse', background: '#ffffff', stroke: { color: '#c7c7cc', width: Math.max(2, Math.round(boxS * 0.09)) } } }));
        }
        // iOS keeps completed text upright and full-color (no strike, no strong dimming).
        checkNodes.push(T({ role: 'caption', name: `Item ${i + 1}`, text: it, sizeLocked: true, autoH: false,
          tplRef: { key: 'items', index: i },
          box: { x: pad + boxS + rx(0.035), y, w: w - pad * 2 - boxS - rx(0.035), h: rowH },
          style: { fontSize: itemFs, fontWeight: 400, color: INK, align: 'left', lineHeight: 1.3, fontFamily: sf } }));
      });
      const checklist = groupLayers('Checklist', checkNodes);
      // ── Footnote ──
      const footnote = T({ role: 'caption', name: 'Footnote', text: pct(p.footnote), sizeLocked: true,
        box: { x: pad, y: h - ry(0.10), w: w - pad * 2, h: ry(0.08) },
        style: { fontSize: fs(0.026), fontWeight: 600, color: MUTED, align: 'left', lineHeight: 1.3, fontFamily: sf } });
      return [bg, nav, headline, checklist, footnote];
    },
  },

  {
    id: 'imessage',
    name: 'iMessage thread',
    hint: 'iOS Messages thread: grey nav (avatar + contact name + ›), grey received bubbles left + blue sent bubbles right w/ tails, timestamp divider, iOS type field (bench iMessage)',
    params: {
      contact: 'Mom',
      messages: [
        { from: 'them', text: 'did you order more of that hair stuff?' },
        { from: 'me', text: 'yeah the texture powder, it just shipped' },
        { from: 'them', text: 'your hair looked so full at dinner 🥹' },
        { from: 'me', text: 'right?? one pinch at the roots is all it takes' },
        { from: 'them', text: 'send me the link i want it for your dad lol' },
      ],
      timestamp: 'Today 7:42 PM',
      avatarEffect: 'none', blurAvatar: false,
    },
    build(doc, p) {
      const { w, h, rx, ry, fs } = sized(doc);
      const sf = FONT_SUGGEST.sf;
      // iOS Messages (light): nav/back tint #007AFF, sent bubble flat #0A84FF + white text,
      // received #E9E9EB + black text, ~18px radius, timestamp grey #8E8E93, composer hairline
      // #C6C6C8, send button #0A84FF circle + white ↑. Everything scales off the canvas.
      const INK = '#000000', MUTED = '#8e8e93', TINT = '#007aff', BLUE = '#0a84ff', GREY = '#e9e9eb', GREYINK = '#000000';
      const bg = S({ role: 'card', name: 'Thread bg', box: { x: 0, y: 0, w, h }, style: { background: '#ffffff' } });
      // ── Nav: ‹ back chevron (tint, left) · centered avatar + contact name + ›, hairline under ──
      const navH = ry(0.13);
      const navAv = Math.round(navH * 0.42);
      const backChevron = T({ role: 'caption', name: 'Back', text: '‹', sizeLocked: true, autoH: false,
        box: { x: rx(0.045), y: ry(0.022), w: rx(0.08), h: navAv },
        style: { fontSize: fs(0.062), fontWeight: 400, color: TINT, align: 'left', lineHeight: 1, fontFamily: sf } });
      const avatar = avatarShape({
        role: 'avatar', name: 'Contact avatar', box: { x: Math.round((w - navAv) / 2), y: ry(0.022), w: navAv, h: navAv },
        gradient: { type: 'linear', angle: 135, stops: [{ color: '#b0b6c0', pos: 0 }, { color: '#7c8494', pos: 1 }] },
      }, avatarEffectOf(p));
      const nameFs = fs(0.026);
      const contactName = T({ role: 'caption', name: 'Contact name', text: `${pct(p.contact)} ›`, sizeLocked: true, autoH: false,
        box: { x: rx(0.1), y: ry(0.022) + navAv + ry(0.006), w: rx(0.8), h: Math.round(nameFs * 1.5) },
        style: { fontSize: nameFs, fontWeight: 600, color: INK, align: 'center', lineHeight: 1.2, fontFamily: sf } });
      const hairline = S({ role: 'decor', name: 'Nav hairline', box: { x: 0, y: navH, w, h: 1 }, style: { background: '#c6c6c8' } });
      const nav = groupLayers('Nav', [backChevron, avatar, contactName, hairline]);
      // ── Timestamp divider ──
      const items = [];
      const tsFs = fs(0.024);
      items.push({ kind: 'ts', text: pct(p.timestamp) });
      // ── Bubbles ──
      const bubbleFs = fs(0.036);
      const pad = rx(0.05);
      const maxBubbleW = Math.round(w * 0.72);
      const padX = Math.round(bubbleFs * 0.7);
      const lineH = Math.round(bubbleFs * 1.28);
      // ~18px continuous-corner radius on ~34px bubbles ≈ 0.55×height; cap so tall bubbles keep
      // iOS's rounded-rect look rather than becoming full stadiums.
      const bubbleRadiusCap = Math.round(bubbleFs * 1.15);
      const maxTextW = maxBubbleW - padX * 2;
      const msgs = Array.isArray(p.messages) ? p.messages : [];
      msgs.forEach((m, mi) => { if (m && m.text) items.push({ kind: 'bubble', from: m.from, text: String(m.text), mi }); });
      // layout top→bottom from below the nav
      let cy = navH + ry(0.03);
      const gap = Math.round(bubbleFs * 0.6);
      const nodes = [];
      for (const it of items) {
        if (it.kind === 'ts') {
          // iOS renders the day word in bold grey, the time in regular grey — split into two
          // measured spans on one centered baseline (bold day + regular time).
          const m = /^(\S+)\s+(.*)$/.exec(it.text);
          const dayWord = m ? m[1] : it.text;
          const timeWord = m ? ` ${m[2]}` : '';
          const dayW = Math.round(dayWord.length * tsFs * 0.62);
          const timeW = Math.round(timeWord.length * tsFs * 0.56);
          const tsX = Math.round((w - dayW - timeW) / 2);
          nodes.push(groupLayers('Timestamp', [
            T({ role: 'caption', name: 'Timestamp day', text: dayWord, sizeLocked: true, autoH: false,
              box: { x: tsX, y: cy, w: dayW, h: Math.round(tsFs * 1.5) },
              style: { fontSize: tsFs, fontWeight: 700, color: MUTED, align: 'left', lineHeight: 1.2, fontFamily: sf } }),
            timeWord && T({ role: 'caption', name: 'Timestamp time', text: timeWord, sizeLocked: true, autoH: false,
              box: { x: tsX + dayW, y: cy, w: timeW, h: Math.round(tsFs * 1.5) },
              style: { fontSize: tsFs, fontWeight: 400, color: MUTED, align: 'left', lineHeight: 1.2, fontFamily: sf } }),
          ]));
          cy += Math.round(tsFs * 1.5) + gap;
          continue;
        }
        const bl = bubbleLines(it.text, bubbleFs, maxTextW);
        const bw = Math.round(Math.min(maxBubbleW, bl.widest + padX * 2));
        const bh = Math.round(bl.lines * lineH + padX * 1.4);
        const mine = it.from === 'me';
        const bx = mine ? w - pad - bw : pad;
        nodes.push(T({ role: 'caption', name: mine ? 'Sent bubble' : 'Received bubble', text: it.text, sizeLocked: true, autoH: false,
          tplRef: { key: 'messages', index: it.mi, field: 'text' },
          box: { x: bx, y: cy, w: bw, h: bh },
          style: { fontSize: bubbleFs, fontWeight: 400, color: mine ? '#ffffff' : GREYINK, background: mine ? BLUE : GREY,
            radius: Math.min(Math.round(bh / 2), bubbleRadiusCap), padding: padX, align: 'left', lineHeight: 1.28, fontFamily: sf } }));
        cy += bh + gap;
      }
      const thread = groupLayers('Thread', nodes);
      // ── iOS type field: rounded input pill w/ placeholder + circular send arrow ──
      const fieldH = ry(0.05);
      const fieldY = h - ry(0.03) - fieldH;
      const fieldW = w - pad * 2 - fieldH - rx(0.02);
      const field = S({ role: 'card', name: 'Type field', box: { x: pad, y: fieldY, w: fieldW, h: fieldH },
        style: { background: '#ffffff', radius: fieldH, stroke: { color: '#c7c7cc', width: 2 } } });
      const placeholder = T({ role: 'caption', name: 'Placeholder', text: 'iMessage', sizeLocked: true, autoH: false,
        box: { x: pad + rx(0.03), y: fieldY, w: rx(0.4), h: fieldH },
        style: { fontSize: fs(0.03), fontWeight: 400, color: '#b0b0b5', align: 'left', lineHeight: 1, fontFamily: sf } });
      const sendS = fieldH;
      const sendBtn = S({ role: 'decor', name: 'Send button', box: { x: w - pad - sendS, y: fieldY, w: sendS, h: sendS },
        style: { shapeKind: 'ellipse', background: BLUE } });
      const sendArrow = T({ role: 'caption', name: 'Send arrow', text: '↑', sizeLocked: true, autoH: false,
        box: { x: w - pad - sendS, y: fieldY, w: sendS, h: sendS },
        style: { fontSize: Math.round(sendS * 0.55), fontWeight: 800, color: '#ffffff', align: 'center', lineHeight: 1, fontFamily: sf } });
      const composer = groupLayers('Composer', [field, placeholder, sendBtn, sendArrow]);
      return [bg, nav, thread, composer];
    },
  },
];

// ── ig-dm helpers ────────────────────────────────────────────────────────────────────────────────

/** Interpolate two hex colors (t 0..1) — Instagram's DM signature: sent bubbles sample a
 *  vertical purple→blue gradient by their position in the thread. */
function lerpHex(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.max(0, Math.min(1, t))));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
// Instagram's signature DM gradient runs vivid purple → magenta-blue → cyan-blue top-to-bottom.
// lerpHex is 2-stop, so span the real range: a bright #A033FF purple at the top to a #0AA6FF
// blue at the bottom (the mid magenta emerges naturally from the interpolation).
const IG_SENT_TOP = '#a033ff';    // vivid purple at the top of the thread (IG's DM gradient top)
const IG_SENT_BOTTOM = '#0aa6ff'; // cyan-blue at the bottom
const IG_RECEIVED = '#262626';    // received bubble — Instagram's dark-mode received grey; #262626
                                   // is the well-documented value (#303030 reads slightly too light)
const IG_CARD = '#0C1014';        // DM thread background — LIVE-confirmed from a real logged-in
                                   // instagram.com session (getComputedStyle bg), not pure black
const IG_MUTED = '#a8a8a8';       // labels: New Messages / Replied to you — matches live extraction

/** Wrapped-line estimate for bubble sizing: greedy wrap, then the widest RESULTING line
 *  (the first version returned the longest word — bubbles came out one-word wide). */
function bubbleLines(text, fs, maxTextW) {
  const cw = fs * 0.52;
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (cur && cand.length * cw > maxTextW) { lines.push(cur); cur = w; }
    else cur = cand;
  }
  if (cur) lines.push(cur);
  const widest = Math.max(1, ...lines.map((l) => l.length * cw));
  return { lines: Math.max(1, lines.length), widest: Math.min(maxTextW, Math.ceil(widest) + Math.round(fs * 0.2)) };
}

/** Aliases the model/users reach for. */
export const TEMPLATE_ALIASES = {
  'x-post': 'x-post-ad', tweet: 'x-post-ad', twitter: 'x-post-ad',
  story: 'story-native', 'ig-story': 'story-native',
  'us-vs-them': 'comparison', versus: 'comparison', 'vs': 'comparison',
  offer: 'offer-hero', bundle: 'offer-hero',
  dm: 'ig-dm', 'instagram-dm': 'ig-dm', 'dm-thread': 'ig-dm',
  'apple-note': 'apple-notes', notes: 'apple-notes', note: 'apple-notes', 'notes-app': 'apple-notes',
  stat: 'stat-chart', 'stat-card-ad': 'stat-chart', chart: 'stat-chart', 'data-ad': 'stat-chart',
  'ig-post': 'ig-feed-post', 'instagram-post': 'ig-feed-post', 'feed-post': 'ig-feed-post', 'ig-feed': 'ig-feed-post', post: 'ig-feed-post',
  checklist: 'notes-checklist', 'notes-check': 'notes-checklist', 'todo': 'notes-checklist', 'to-do': 'notes-checklist', 'checklist-note': 'notes-checklist',
  imessage: 'imessage', 'i-message': 'imessage', messages: 'imessage', text: 'imessage', 'text-thread': 'imessage', sms: 'imessage',
};

/** Build a template's full layer list for the doc. Returns [] for unknown ids. */
export function buildTemplate(id, doc, rawParams = {}, kit = undefined) {
  const canonical = TEMPLATE_ALIASES[id] || id;
  const def = TEMPLATES.find((t) => t.id === canonical);
  if (!def) return { def: null, layers: [] };
  const params = { ...def.params };
  for (const [k, v] of Object.entries(rawParams || {})) if (v !== undefined && k in params) params[k] = v;
  const layers = def.build(doc, params, kit) || [];
  // measurement-first: plain text leaves get hugged; sizeLocked template text keeps its
  // deliberate artifact geometry but still re-measures height where autoH applies
  fitElementText(layers);
  // Provenance (v2 single-edit-path, template edition): every layer carries tpl=<id>; the
  // first layer carries the full {id, params} stamp; text leaves whose content came from a
  // FLAT string param get a generic tplRef (builders may stamp richer refs, e.g. ig-dm's
  // per-message paths) — so setText rebuilds the WHOLE template with re-measured geometry.
  const walkT = (ns, fn) => ns.forEach((n) => { fn(n); if (n.children) walkT(n.children, fn); });
  walkT(layers, (n) => {
    n.tpl = def.id;
    if (n.text != null && !n.tplRef) {
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === 'string' && v && v === n.text) { n.tplRef = { key: k }; break; }
      }
    }
  });
  if (layers[0]) layers[0].template = { id: def.id, params: JSON.parse(JSON.stringify(params)) };
  return { def, layers };
}

/**
 * v2 single-edit-path for templates: route a text edit on a template layer back through its
 * param and REBUILD the whole template (bubbles re-measure, the stack re-flows — a DM thread
 * stays a coherent thread after every edit). Node ids are PRESERVED across the rebuild by
 * tplRef path, so selections/aliases stay stable. Returns a summary string or null when the
 * layer isn't template-built.
 */
export function applyTemplateTextEdit(doc, layerId, text, kit = undefined) {
  let target = null;
  const walkT = (ns, fn) => ns.forEach((n) => { fn(n); if (n.children) walkT(n.children, fn); });
  walkT(doc.layers, (n) => { if (n.id === layerId) target = n; });
  if (!target || !target.tpl || !target.tplRef) return null;
  const stampIdx = doc.layers.findIndex((n) => n.template && n.template.id === target.tpl);
  if (stampIdx === -1) return null;
  const params = JSON.parse(JSON.stringify(doc.layers[stampIdx].template.params));
  const { key, index, field } = target.tplRef;
  if (index != null && Array.isArray(params[key])) {
    const entry = params[key][index];
    if (entry && typeof entry === 'object') entry[field || 'text'] = String(text);
    else params[key][index] = String(text);
  } else if (key in params) {
    params[key] = String(text);
  } else return null;
  // id preservation: map old tplRef paths → ids before the swap
  const refKey = (n) => n.tplRef ? `${n.tplRef.key}|${n.tplRef.index ?? ''}|${n.tplRef.field ?? ''}` : null;
  const oldIds = new Map();
  walkT(doc.layers, (n) => { if (n.tpl === target.tpl) { const k = refKey(n); if (k) oldIds.set(k, n.id); } });
  const firstIdx = doc.layers.findIndex((n) => n.tpl === target.tpl);
  const kept = doc.layers.filter((n) => n.tpl !== target.tpl);
  const { def, layers } = buildTemplate(target.tpl, doc, params, kit);
  if (!def) return null;
  walkT(layers, (n) => { const k = refKey(n); if (k && oldIds.has(k)) n.id = oldIds.get(k); });
  kept.splice(Math.max(0, firstIdx), 0, ...layers);
  doc.layers = kept;
  return `text ${def.id}.${key}${index != null ? `[${index}]` : ''} → “${String(text).slice(0, 40)}” (thread re-flowed)`;
}

/** One-line-per-template catalog for the agent prompt. */
export function templateCatalog() {
  return TEMPLATES.map((t) => `${t.id}(${Object.keys(t.params).join(',')}) — ${t.hint}`).join('\n');
}

/** Detect the archetype implied by a brief/instruction (priority order matters). */
export function detectTemplate(text) {
  const s = String(text || '').toLowerCase();
  if (/\b(imessage|i-?message|sms|text thread|text message)\b/.test(s)) return 'imessage';
  if (/\b(dm|dms|direct message|message thread)\b/.test(s)) return 'ig-dm';
  if (/\b(x[- ]?post|tweet|twitter)\b/.test(s)) return 'x-post-ad';
  if (/\b(checklist|to-?do list|todo list)\b/.test(s)) return 'notes-checklist';
  if (/\bapple ?notes?\b|\bnotes app\b|\bnote screenshot\b/.test(s)) return 'apple-notes';
  if (/\b(ig|instagram|feed) ?(feed )?post\b/.test(s)) return 'ig-feed-post';
  if (/before[\s-]*(and|&|\/)?[\s-]*after/.test(s)) return 'before-after';
  if (/\b(us[\s-]?vs[\s-]?them|versus|comparison|compare|vs\.?)\b/.test(s)) return 'comparison';
  // data ad: a percentage next to a stat/chart/study/graph cue (not the offer-hero '% off')
  if (/%/.test(s) && /\b(stat|chart|study|studies|graph|data|clinical|results?)\b/.test(s)) return 'stat-chart';
  if (/\b(story|9:16)\b/.test(s)) return 'story-native';
  if (/\b(bundle|save [£$€]|% ?off|first order|offer)\b/.test(s)) return 'offer-hero';
  return null;
}
