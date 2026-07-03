// lib/native-components/imessage-overlays.mjs — iMessage OVERLAY pieces: long-press context
// menu, tapback/reaction bar, and rich link-preview card. These are composable, standalone
// fragments meant to be placed over/within a base iMessage thread built separately
// (lib/native-components/imessage.mjs, owned by another agent — NOT touched here).
//
// Follows the established pattern (see lib/native-components/x-post.mjs + README.md):
// each render fn is a pure `params -> {html, css}` mapping, real flexbox layout (no manual
// x/y math), data-role/data-param on meaningful nodes, real font stacks declared.
//
// ── Research notes (WebSearch, July 2026) ──────────────────────────────────────────────────
// Apple does not publish exact pixel specs for these private Messages.app surfaces (no public
// HIG page covers "context menu blur radius" or "tapback pill height" — confirmed via search;
// Kyle Bashour's context-menu guide and Apple's own UIMenu/UIContextMenu API docs only cover the
// *public* UIKit context-menu API, which mirrors this chrome closely enough to use as ground
// truth for the vibrancy-blur + rounded-rect + SF Symbols pattern). Facts used below:
//   - Long-press/haptic touch triggers a dark, blurred, vibrancy-style menu (UIContextMenu
//     uses UIBlurEffect(style: .systemMaterialDark) under the hood) — dark translucent
//     background is correct per Michael's screenshots; modeled here as blur+rgba(28,28,30,.78).
//   - Menu rows in this API are SF Symbol (monochrome, ~20-22pt) + label (~17pt, white/near-
//     white), icon trailing/right-aligned, label leading — matches the reference screenshots.
//   - Destructive items render red (not used here — no destructive item in this menu — noted
//     per the brief for future use via the `destructive` item flag).
//   - Tapbacks: per Apple Support ("React with Tapbacks in Messages on iPhone") the CLASSIC six
//     are heart / thumbs-up / thumbs-down / haha / exclamation / question. iOS 18 (MacRumors,
//     "Use Emoji as Tapback Reactions") added full custom-emoji/sticker tapbacks on top of the
//     classic six, and "Tapback size is fixed" for the standard six even in iOS 18 — confirming
//     the brief's "large emoji in a dark pill" look for the classic set is still accurate;
//     no evidence of a 7th "cut off" reaction beyond the classic six + the emoji-picker "+"
//     entry point, so the 7th slot here is a "more" (+) affordance, not a real 7th tapback —
//     correction to the brief's "one more cut off" guess.
//   - Rich link previews (Apple TN3156 "Create rich previews for Messages" + RenderForm write-
//     up): card pulls og:title/og:image/domain, rendered as a big rounded card that becomes
//     part of the bubble's shape once sent — white rounded-rect, subtle border, metadata block
//     (title + domain) below the image/content area. No published exact radius; ~16px matches
//     Messages' own bubble-family rounding and is used consistently across the codebase's other
//     native components.
//
// Public API: renderContextMenu(params), renderTapbackBar(params), renderLinkCard(params)
// Each returns { html, css } — unwrapped fragments, embeddable/composable over a thread.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const t = (s) => esc(s);

// ── monochrome SF-Symbols-style inline icons for the context menu rows ─────────────────────
const MENU_ICONS = {
  reply: '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><path fill="currentColor" d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01Zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756Z"/></svg>',
  sticker: '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><path fill="currentColor" d="M4 5.5C4 4.67 4.67 4 5.5 4h9.63c.4 0 .78.16 1.06.44l3.37 3.37c.28.28.44.66.44 1.06V18.5c0 .83-.67 1.5-1.5 1.5H9.13c-.4 0-.78-.16-1.06-.44l-3.63-3.63A1.5 1.5 0 0 1 4 14.87V5.5Zm2 .5v8.5l3.5 3.5H18V9.5h-3A1.5 1.5 0 0 1 13.5 8V6H6Zm9.5.62V8h1.38l-1.38-1.38ZM11 11h2v2h2v2h-2v2h-2v-2H9v-2h2v-2Z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M16.87 3.13a2.5 2.5 0 0 1 3.54 3.54l-1.06 1.06-3.54-3.54 1.06-1.06Zm-2.48 2.48 3.54 3.54L8.5 18.58l-4.72 1.18 1.18-4.72L14.39 5.61Z"/></svg>',
  undo: '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><path fill="currentColor" d="M12 5V2L6 7l6 5V9c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M8 3.5A1.5 1.5 0 0 1 9.5 2h8A1.5 1.5 0 0 1 19 3.5v11a1.5 1.5 0 0 1-1.5 1.5H16v-2h1V4h-7v1H8v-1.5Zm-3 4A1.5 1.5 0 0 1 6.5 6h8A1.5 1.5 0 0 1 16 7.5v13a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 5 20.5v-13ZM7 8v12h7V8H7Z"/></svg>',
  translate: '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><path fill="currentColor" d="M9 3a1 1 0 0 1 1 1v1h4.5a1 1 0 1 1 0 2h-.62c-.4 1.68-1.16 3.19-2.2 4.46.5.44 1.04.84 1.63 1.18a1 1 0 1 1-1 1.73 10.9 10.9 0 0 1-2-1.5 10.9 10.9 0 0 1-3.86 2.2 1 1 0 0 1-.6-1.9 8.9 8.9 0 0 0 3.05-1.76A9.4 9.4 0 0 1 6.7 8H9a1 1 0 1 1 0-2h-1V4a1 1 0 0 1 1-1Zm-.5 3a7.4 7.4 0 0 0 1.5 2.8A7.4 7.4 0 0 0 11.4 6H8.5ZM17 11a1 1 0 0 1 .92.61l3.5 8.25a1 1 0 1 1-1.84.78L19 19h-4l-.58 1.64a1 1 0 1 1-1.84-.78l3.5-8.25A1 1 0 0 1 17 11Zm-1.25 6h2.5L17 14.4 15.75 17Z"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm-3 6.75a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm3 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm3 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z"/></svg>',
};

const MENU_DEFAULTS_ITEMS = [
  { key: 'reply', label: 'Reply', icon: 'reply' },
  { key: 'sticker', label: 'Add Sticker', icon: 'sticker' },
  { key: 'edit', label: 'Edit', icon: 'edit' },
  { key: 'undo', label: 'Undo Send', icon: 'undo' },
  { key: 'copy', label: 'Copy', icon: 'copy' },
  { key: 'translate', label: 'Translate', icon: 'translate' },
  { key: 'more', label: 'More…', icon: 'more' },
];

/** Renders the long-press message context menu: dark vibrancy-blur rounded-rect, icon+label
 *  rows with a thin separator before the trailing "More…" group.
 *  params: { items: [{label, icon, destructive?}] } — icon is a key into MENU_ICONS, or a raw
 *  inline <svg> string if callers want a custom glyph. Defaults to the 7 real iOS rows. */
export function renderContextMenu(params = {}) {
  const items = Array.isArray(params.items) && params.items.length ? params.items : MENU_DEFAULTS_ITEMS;

  const rows = items
    .map((item, i) => {
      const iconMarkup = item.icon && MENU_ICONS[item.icon] ? MENU_ICONS[item.icon] : (item.icon || '');
      const isLast = i === items.length - 1;
      const destructiveClass = item.destructive ? ' imsg-menu__row--destructive' : '';
      return `<button class="imsg-menu__row${destructiveClass}" data-role="menu-row" data-param="items[${i}].label" type="button">
      <span class="imsg-menu__label" data-role="menu-row-label">${t(item.label)}</span>
      <span class="imsg-menu__icon" data-role="menu-row-icon" aria-hidden="true">${iconMarkup}</span>
    </button>${!isLast ? `\n    <span class="imsg-menu__sep" data-role="menu-sep" aria-hidden="true"></span>` : ''}`;
    })
    .join('\n    ');

  const html = `<div class="imsg-menu" data-role="context-menu-root">
  <div class="imsg-menu__panel" data-role="context-menu-panel">
    ${rows}
  </div>
</div>`;

  const css = `
.imsg-menu {
  --imsg-menu-bg: rgba(28, 28, 30, 0.78);
  --imsg-menu-text: rgba(255, 255, 255, 0.96);
  --imsg-menu-sep: rgba(255, 255, 255, 0.16);
  --imsg-menu-destructive: #ff453a;
  font-family: -apple-system, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif;
  display: inline-flex;
}
.imsg-menu * { box-sizing: border-box; }
.imsg-menu__panel {
  display: flex;
  flex-direction: column;
  width: 250px;
  border-radius: 14px;
  overflow: hidden;
  background: var(--imsg-menu-bg);
  -webkit-backdrop-filter: blur(28px) saturate(1.6);
  backdrop-filter: blur(28px) saturate(1.6);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
}
.imsg-menu__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  border: none;
  background: transparent;
  padding: 11px 16px;
  cursor: pointer;
  font-family: inherit;
}
.imsg-menu__label {
  font-size: 17px;
  font-weight: 400;
  line-height: 1.2;
  color: var(--imsg-menu-text);
  text-align: left;
}
.imsg-menu__icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  color: var(--imsg-menu-text);
}
.imsg-menu__row--destructive .imsg-menu__label,
.imsg-menu__row--destructive .imsg-menu__icon {
  color: var(--imsg-menu-destructive);
}
.imsg-menu__sep {
  height: 1px;
  width: 100%;
  background: var(--imsg-menu-sep);
}
`;

  return { html, css };
}

// ── tapback bar ──────────────────────────────────────────────────────────────────────────
const TAPBACK_DEFAULTS = {
  reactions: [
    { key: 'heart', emoji: '❤️' },
    { key: 'thumbsup', emoji: '👍' },
    { key: 'thumbsdown', emoji: '👎' },
    { key: 'haha', emoji: '😂' },
    { key: 'exclaim', emoji: '‼️' },
    { key: 'question', emoji: '❓' },
  ],
};

/** Renders the tapback/reaction bar: a dark rounded pill sitting above the reacted-to bubble,
 *  holding the classic six iOS tapbacks (heart/thumbs-up/thumbs-down/haha/‼/❓) rendered large,
 *  plus a trailing "+" affordance for the iOS 18 full-emoji picker (NOT a real 7th tapback —
 *  see research note at top of file).
 *  params: { reactions: [{key, emoji}], showMore?: boolean (default true) } */
export function renderTapbackBar(params = {}) {
  const reactions = Array.isArray(params.reactions) && params.reactions.length ? params.reactions : TAPBACK_DEFAULTS.reactions;
  const showMore = params.showMore !== false;

  const bubbles = reactions
    .map(
      (r, i) =>
        `<button class="imsg-tapback__item" data-role="tapback-emoji" data-param="reactions[${i}].emoji" type="button">${t(r.emoji)}</button>`
    )
    .join('\n    ');

  const moreBtn = showMore
    ? `\n    <button class="imsg-tapback__item imsg-tapback__item--more" data-role="tapback-more" type="button" aria-label="More reactions">+</button>`
    : '';

  const html = `<div class="imsg-tapback" data-role="tapback-bar-root">
  <div class="imsg-tapback__pill" data-role="tapback-bar-pill">
    ${bubbles}${moreBtn}
  </div>
</div>`;

  const css = `
.imsg-tapback {
  --imsg-tapback-bg: rgba(38, 38, 40, 0.9);
  font-family: -apple-system, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif;
  display: inline-flex;
}
.imsg-tapback * { box-sizing: border-box; }
.imsg-tapback__pill {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: 9999px;
  background: var(--imsg-tapback-bg);
  -webkit-backdrop-filter: blur(20px) saturate(1.5);
  backdrop-filter: blur(20px) saturate(1.5);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
  overflow-x: auto;
}
.imsg-tapback__item {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  font-size: 30px;
  line-height: 1;
  padding: 4px;
  cursor: pointer;
}
.imsg-tapback__item--more {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.9);
  font-size: 18px;
  font-weight: 600;
}
`;

  return { html, css };
}

// ── rich link-preview card ──────────────────────────────────────────────────────────────────
const LINK_CARD_DEFAULTS = {
  brandName: 'Veyumi+',
  headline: 'Feel sharper, sleep deeper.',
  bullets: [
    { icon: '⚡', text: '92% report more energy in 2 weeks' },
    { icon: '😴', text: 'Deeper sleep, fewer wake-ups' },
    { icon: '✅', text: 'Third-party lab tested' },
  ],
  price: '$39.00',
  domain: 'veyumi.com',
};

/** Renders a rich iMessage link-preview card: white rounded-rect, subtle border/shadow, brand
 *  header, headline, icon+text bullet rows (flex, natural wrap), price, domain footer — meant
 *  to sit inline as its own message bubble (wider/taller than a text bubble).
 *  params: { logo, brandName, headline, bullets: [{icon, text}], price, domain } */
export function renderLinkCard(params = {}) {
  const p = { ...LINK_CARD_DEFAULTS, ...params };
  const bullets = Array.isArray(p.bullets) && p.bullets.length ? p.bullets : LINK_CARD_DEFAULTS.bullets;

  const logoBlock = p.logo
    ? `<img class="imsg-link-card__logo" data-role="link-logo" data-param="logo" src="${t(p.logo)}" alt="" />`
    : `<span class="imsg-link-card__logo imsg-link-card__logo--text" data-role="link-logo" data-param="brandName">${t(p.brandName)}</span>`;

  const html = `<div class="imsg-link-card" data-role="link-card-root">
  <div class="imsg-link-card__body" data-role="link-card-body">
    <div class="imsg-link-card__brand-row" data-role="link-brand-row">
      ${logoBlock}
    </div>
    <div class="imsg-link-card__headline" data-role="link-headline" data-param="headline">${t(p.headline)}</div>
    <div class="imsg-link-card__bullets" data-role="link-bullets">
      ${bullets
        .map(
          (b, i) => `<div class="imsg-link-card__bullet-row" data-role="link-bullet-row" data-param="bullets[${i}]">
        <span class="imsg-link-card__bullet-icon" aria-hidden="true">${t(b.icon)}</span>
        <span class="imsg-link-card__bullet-text">${t(b.text)}</span>
      </div>`
        )
        .join('\n      ')}
    </div>
    <div class="imsg-link-card__price-row" data-role="link-price-row">
      <span class="imsg-link-card__price" data-role="link-price" data-param="price">${t(p.price)}</span>
    </div>
  </div>
  <div class="imsg-link-card__footer" data-role="link-footer">
    <span class="imsg-link-card__domain" data-role="link-domain" data-param="domain">${t(p.domain)}</span>
  </div>
</div>`;

  const css = `
.imsg-link-card {
  --imsg-card-bg: #ffffff;
  --imsg-card-border: rgba(60, 60, 67, 0.16);
  --imsg-card-text: #0b0b0d;
  --imsg-card-muted: #8a8a8e;
  font-family: -apple-system, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 320px;
  background: var(--imsg-card-bg);
  border: 1px solid var(--imsg-card-border);
  border-radius: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  overflow: hidden;
}
.imsg-link-card * { box-sizing: border-box; }
.imsg-link-card__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 16px 14px;
}
.imsg-link-card__brand-row {
  display: flex;
  align-items: center;
}
.imsg-link-card__logo {
  height: 22px;
  max-width: 140px;
  object-fit: contain;
}
.imsg-link-card__logo--text {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.2px;
  color: var(--imsg-card-text);
}
.imsg-link-card__headline {
  font-size: 17px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--imsg-card-text);
}
.imsg-link-card__bullets {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.imsg-link-card__bullet-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.imsg-link-card__bullet-icon {
  flex: 0 0 auto;
  font-size: 14px;
  line-height: 1;
  width: 18px;
  text-align: center;
}
.imsg-link-card__bullet-text {
  font-size: 13.5px;
  font-weight: 400;
  line-height: 1.35;
  color: var(--imsg-card-text);
}
.imsg-link-card__price-row {
  display: flex;
  align-items: center;
  margin-top: 4px;
}
.imsg-link-card__price {
  font-size: 18px;
  font-weight: 700;
  color: var(--imsg-card-text);
}
.imsg-link-card__footer {
  padding: 8px 16px;
  border-top: 1px solid var(--imsg-card-border);
  background: rgba(118, 118, 128, 0.06);
}
.imsg-link-card__domain {
  font-size: 12px;
  font-weight: 400;
  color: var(--imsg-card-muted);
  text-transform: lowercase;
}
`;

  return { html, css };
}

export default { renderContextMenu, renderTapbackBar, renderLinkCard };
