// lib/native-components/imessage.mjs — iMessage thread "native component": nav bar, message
// column, composer — authored as REAL browser-laid-out HTML/CSS (flexbox/grid), following the
// pattern established by lib/native-components/x-post.mjs (see that file + README.md).
//
// Why this exists: iMessage is deceptively hard to fake — bubble widths, tails, and spacing are
// all content-driven. A hand-positioned scene-graph has to guess bubble width from character
// count; here the browser's own inline-block/flex sizing measures the actual rendered text, so
// a 3-word bubble and a 3-line bubble both come out correct with zero estimation logic.
//
// ── Research notes (verified July 2026, cross-checked against current dev/community sources —
//    Apple does not publish exact hex values, so these are the consensus figures used across
//    iOS chat-bubble recreations, UIColor system-color references, and screenshot-color-picks) ──
//
// - Sent bubble: flat #0A84FF (iOS 13+ Dynamic Color "systemBlue" light-mode / #007AFF is the
//   legacy pre-iOS13 systemBlue still seen in some docs — both are used interchangeably in the
//   wild; we use #0A84FF as the fill and #007AFF as the tint for nav/composer chrome, matching
//   how Apple's own HIG examples split "message bubble blue" vs "control tint blue"). CONFIRMED:
//   no gradient — gradient sent bubbles were iOS 6/7-era skeuomorphic styling, removed since
//   iOS 7's flat redesign (2013). White text, confirmed via every current recreation reviewed
//   (samuelkraft.com/blog/ios-chat-bubbles-css, ui.heygaia.io message-bubble docs).
// - Received bubble (light mode): #E9E9EB fill (systemGray5-adjacent), black/label text.
//   CONFIRMED via cross-reference of chat-bubble CSS recreations; Apple doesn't publish the
//   literal hex but every current teardown converges on this value (or the visually identical
//   #E9E9EB/#EAEAEA neighborhood).
// - Radius: ~18px corner radius on a bubble whose single-line height is ~34-36px (line-height +
//   vertical padding) — effectively a pill for one-liners, tapering to a rounded rectangle for
//   multi-line text, with one corner (bottom-outer: bottom-right for sent, bottom-left for
//   received) pulled in tighter + a small triangular "tail" — confirmed against
//   samuelkraft.com's clip-path/pseudo-element tail technique and the general 16-20px consensus
//   radius range across recreations.
// - Nav bar: 44pt tall (UIKit's fixed navigation-bar height — sebvidal.com/blog, "UIKit limits
//   the height of the title view to the height of the navigation bar itself, 44 points"),
//   translucent systemBackground, back chevron tinted #007AFF, a compact center title-view
//   (small avatar + ~13pt semibold name) with a small trailing "›" disclosure chevron opening
//   Contact Info — pattern documented since iOS 10 rich-nav-bar content.
// - Timestamp divider: secondaryLabel grey (~#8E8E93), small (~11-12px), centered, e.g.
//   "Today 9:41 AM" with the time in a heavier weight than the day label — confirmed as the
//   standard iOS Messages divider style across current screenshots.
// - Composer: pill-shaped rounded-rect input (fully round ends), placeholder grey close to
//   #3C3C43 at reduced opacity (iOS's tertiaryLabel-on-white convention), solid circular send
//   button filled #0A84FF/#007AFF with a white upward chevron/arrow glyph — appears once the
//   field has content (we render it always-visible with a `data-role="send-button"` hook so a
//   caller can toggle an empty/disabled state via CSS if desired).
// - Font: -apple-system (SF Pro) first, 'Inter' as the declared cross-platform fallback per the
//   house pattern (a parallel effort embeds real fonts; we just declare the stack).
// - corner-shape: squircle is Chromium-only (no Safari/Firefox support as of this research) —
//   included as a documented progressive enhancement behind @supports, falling back to plain
//   border-radius everywhere else.
//
// Public API: renderIMessage(params) => { html, css }
//   - `html` is a single self-contained `<div class="imsg"> … </div>` fragment.
//   - `css` is a plain stylesheet body, scoped under `.imsg` (safe to concatenate with other
//     components' css as long as class names don't collide).
//
// Every meaningful element carries `data-role="…"`; text/attribute-bearing elements sourced
// directly from params also carry `data-param="…"` — same capture-step hook convention as
// x-post.mjs. No renderer/editor wiring consumes these yet.
//
// ── Composing with overlays (context menu / tapback bar / rich link card) ───────────────────
// A separate effort is building `lib/native-components/imessage-overlays.mjs` in parallel. This
// component leaves clean composition seams for that work rather than anticipating its API:
//   - Each bubble wrapper (`data-role="bubble-wrap"`) carries `data-message-index` and
//     `data-from` so an overlay renderer can target "the Nth bubble" or "the last sent bubble"
//     to position a tapback badge (typically absolutely-positioned, anchored top-outer-corner)
//     or a long-press context menu without this file needing to know about either.
//   - `.imsg__bubble` is `position: relative` for exactly this reason — an overlay can be
//     appended as an absolutely-positioned child/sibling anchored to a bubble's box.
//   - Rich link cards are expected to render as an alternate bubble body (replacing the plain
//     text content while keeping `.imsg__bubble` sizing/radius/tail rules), so the overlay file
//     only needs to build the inner card markup, not re-derive bubble chrome.
//   - `data-role="message-row"` (the flex row housing each bubble) is a stable attach point for
//     positioning a tapback reaction badge at the row level if anchoring to the row reads
//     better than anchoring to the bubble box.
// No hooks are required beyond these existing data-attributes — nothing else to wire up.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const t = (s) => esc(s);

const DEFAULTS = {
  contactName: 'Sam',
  contactAvatarUrl: '',
  dividerLabel: 'Today',
  dividerTime: '9:41 AM',
  composerPlaceholder: 'Text Message',
  messages: [
    { from: 'them', text: "Hey! Are we still on for tomorrow?" },
    { from: 'me', text: "Yes! 10am works great 👍" },
    { from: 'them', text: "Perfect, see you then." },
    { from: 'me', text: "Can't wait — it's been way too long." },
  ],
};

const ICONS = {
  back: '<svg viewBox="0 0 12 21" width="12" height="21" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M10.5 1.5 1.5 10.5l9 9"/></svg>',
  disclosure: '<svg viewBox="0 0 8 14" width="7" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M1 1l6 6-6 6"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 4.5a1 1 0 0 1 1 1v10.6l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V5.5a1 1 0 0 1 1-1z" transform="rotate(180 12 12)"/></svg>',
  camera: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M9 3.5a1 1 0 0 0-.8.4L7.1 5.5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-10a2 2 0 0 0-2-2h-2.1l-1.1-1.6a1 1 0 0 0-.8-.4H9zm3 5.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z"/></svg>',
};

const avatarInitial = (name) => String(name || '?').trim().charAt(0).toUpperCase();

export function renderIMessage(params = {}) {
  const p = { ...DEFAULTS, ...params };
  const messages = Array.isArray(p.messages) && p.messages.length ? p.messages : DEFAULTS.messages;

  const avatar = p.contactAvatarUrl
    ? `<img class="imsg__nav-avatar-img" data-role="nav-avatar" data-param="contactAvatarUrl" src="${t(p.contactAvatarUrl)}" alt="" />`
    : `<div class="imsg__nav-avatar-img imsg__nav-avatar-img--placeholder" data-role="nav-avatar" data-param="contactAvatarUrl">${t(avatarInitial(p.contactName))}</div>`;

  const messageRows = messages
    .map((m, i) => {
      const isMe = m.from === 'me';
      const rowClass = isMe ? 'imsg__row imsg__row--me' : 'imsg__row imsg__row--them';
      const bubbleClass = isMe ? 'imsg__bubble imsg__bubble--sent' : 'imsg__bubble imsg__bubble--received';
      const tsHtml = m.timestamp
        ? `\n      <div class="imsg__msg-time" data-role="message-timestamp" data-param="messages">${t(m.timestamp)}</div>`
        : '';
      return `  <div class="${rowClass}" data-role="message-row" data-message-index="${i}" data-from="${isMe ? 'me' : 'them'}">
    <div class="${bubbleClass}" data-role="bubble-wrap">
      <div class="imsg__bubble-text" data-role="message-text" data-param="messages">${t(m.text)}</div>
    </div>${tsHtml}
  </div>`;
    })
    .join('\n');

  const html = `<div class="imsg" data-role="root">
  <div class="imsg__nav" data-role="nav">
    <button class="imsg__nav-back" data-role="nav-back" type="button" aria-label="Back">
      <span class="imsg__nav-back-icon" aria-hidden="true">${ICONS.back}</span>
      <span class="imsg__nav-back-count" data-role="nav-back-count">12</span>
    </button>
    <button class="imsg__nav-title" data-role="nav-title" type="button">
      ${avatar}
      <span class="imsg__nav-name" data-role="contact-name" data-param="contactName">${t(p.contactName)}</span>
      <span class="imsg__nav-disclosure" aria-hidden="true">${ICONS.disclosure}</span>
    </button>
    <span class="imsg__nav-spacer" data-role="nav-spacer"></span>
  </div>

  <div class="imsg__thread" data-role="thread">
    <div class="imsg__divider" data-role="timestamp-divider">
      <span data-role="divider-label" data-param="dividerLabel">${t(p.dividerLabel)}</span>
      <span class="imsg__divider-time" data-role="divider-time" data-param="dividerTime">${t(p.dividerTime)}</span>
    </div>
${messageRows}
  </div>

  <div class="imsg__composer" data-role="composer">
    <button class="imsg__composer-camera" data-role="composer-camera" type="button" aria-label="Camera">
      <span aria-hidden="true">${ICONS.camera}</span>
    </button>
    <div class="imsg__composer-field" data-role="composer-field">
      <span class="imsg__composer-placeholder" data-role="composer-placeholder" data-param="composerPlaceholder">${t(p.composerPlaceholder)}</span>
    </div>
    <button class="imsg__composer-send" data-role="send-button" type="button" aria-label="Send">
      <span aria-hidden="true">${ICONS.send}</span>
    </button>
  </div>
</div>`;

  const css = `
.imsg {
  --imsg-blue: #0A84FF;
  --imsg-tint: #007AFF;
  --imsg-received-bg: #E9E9EB;
  --imsg-received-text: #000000;
  --imsg-sent-text: #ffffff;
  --imsg-label-secondary: #8E8E93;
  --imsg-placeholder: rgba(60, 60, 67, 0.6); /* #3C3C43 @ 60% — iOS tertiaryLabel-on-white */
  --imsg-hairline: rgba(60, 60, 67, 0.29);
  --imsg-bg: #ffffff;
  --imsg-nav-bg: rgba(255, 255, 255, 0.88);

  box-sizing: border-box;
  width: 100%;
  max-width: 430px;
  background: var(--imsg-bg);
  color: #000000;
  font-family: -apple-system, 'Inter', 'Helvetica Neue', Arial, sans-serif;
  display: flex;
  flex-direction: column;
  border-radius: 0;
  overflow: hidden;
}
.imsg * { box-sizing: border-box; }

/* ── Nav bar: 44pt fixed height (UIKit's own nav-bar title-view constraint), translucent
   systemBackground, back chevron + count (tint #007AFF), centered compact title (avatar + name
   + disclosure chevron). Flex row, no manual centering math — the spacer + auto-margins on the
   title let the browser center it regardless of back-button width. ─────────────────────────── */
.imsg__nav {
  position: relative;
  display: flex;
  align-items: center;
  height: 44px;
  padding: 0 8px;
  background: var(--imsg-nav-bg);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 0.5px solid var(--imsg-hairline);
  flex: 0 0 auto;
}
.imsg__nav-back {
  display: flex;
  align-items: center;
  gap: 2px;
  border: none;
  background: transparent;
  color: var(--imsg-tint);
  font-family: inherit;
  font-size: 17px;
  padding: 6px 4px;
  cursor: pointer;
  flex: 0 0 auto;
  z-index: 1;
}
.imsg__nav-back-icon { display: inline-flex; color: inherit; }
.imsg__nav-back-count { line-height: 1; }
.imsg__nav-title {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 2px 4px;
  max-width: 60%;
}
.imsg__nav-avatar-img {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  object-fit: cover;
  background: linear-gradient(160deg, #c7c7cc, #9a9aa1);
}
.imsg__nav-avatar-img--placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  font-size: 13px;
  font-weight: 600;
}
.imsg__nav-name {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  font-weight: 600;
  color: #000000;
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.imsg__nav-disclosure {
  display: inline-flex;
  color: #c7c7cc;
  margin-left: 1px;
  transform: translateY(0.5px);
}
.imsg__nav-spacer { flex: 1 1 auto; }

/* ── Thread column: the browser stacks message rows in normal flex-column flow. Each bubble's
   width is intrinsic (max-content up to a cap) — NOT computed from char-count. ──────────────── */
.imsg__thread {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 12px 10px;
  background: var(--imsg-bg);
  overflow-y: auto;
}

.imsg__divider {
  align-self: center;
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 11px;
  color: var(--imsg-label-secondary);
  margin-bottom: 6px;
  padding: 0 8px;
}
.imsg__divider-time { font-weight: 600; }

/* ── Message row: a flex row that left- or right-aligns its single bubble child via
   justify-content — the browser handles the alignment axis, not a hand-set x offset. A bubble's
   max-width is capped as a percentage of the row so long messages wrap naturally (browser line
   breaking), while short messages hug their own content width (inline-flex / max-content). ──── */
.imsg__row {
  display: flex;
  width: 100%;
  margin: 1px 0;
}
.imsg__row--them { justify-content: flex-start; }
.imsg__row--me { justify-content: flex-end; }

/* ── Bubble: real border-radius pill/rounded-rect. Single-line bubbles read as a pill because
   line-height + vertical padding keeps the box short relative to its 18px radius; multi-line
   bubbles keep the same radius and simply grow taller via normal block flow — no separate
   "multi-line" size variant needed. The tail is a small pseudo-element rounded triangle on the
   outer-bottom corner (bottom-right for sent, bottom-left for received), clipped so it reads as
   part of the bubble silhouette rather than a bolted-on shape. ─────────────────────────────── */
.imsg__bubble {
  position: relative; /* seam for imessage-overlays.mjs: tapback badge / context menu anchor */
  display: inline-flex;
  max-width: 74%;
  padding: 8px 14px;
  border-radius: 18px;
  line-height: 1.28;
}
@supports (corner-shape: squircle) {
  .imsg__bubble { corner-shape: squircle; }
}
.imsg__bubble-text {
  font-size: 16.5px;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
}
.imsg__bubble--sent {
  background: var(--imsg-blue);
  color: var(--imsg-sent-text);
  border-bottom-right-radius: 4px;
}
.imsg__bubble--sent::after {
  content: '';
  position: absolute;
  right: -6px;
  bottom: 0;
  width: 14px;
  height: 16px;
  background: var(--imsg-blue);
  border-bottom-left-radius: 10px;
  clip-path: polygon(0 0, 100% 100%, 0 100%);
}
.imsg__bubble--received {
  background: var(--imsg-received-bg);
  color: var(--imsg-received-text);
  border-bottom-left-radius: 4px;
}
.imsg__bubble--received::after {
  content: '';
  position: absolute;
  left: -6px;
  bottom: 0;
  width: 14px;
  height: 16px;
  background: var(--imsg-received-bg);
  border-bottom-right-radius: 10px;
  clip-path: polygon(100% 0, 100% 100%, 0 100%);
}

.imsg__msg-time {
  align-self: center;
  font-size: 10.5px;
  color: var(--imsg-label-secondary);
  margin: 3px 0 1px;
}

/* ── Composer: pill input (fully round, radius = half its own height, so the browser computes
   the exact pill curvature from content-driven height rather than a fixed magic number), plus a
   solid circular send button. ─────────────────────────────────────────────────────────────── */
.imsg__composer {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 6px 8px;
  border-top: 0.5px solid var(--imsg-hairline);
  background: var(--imsg-nav-bg);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}
.imsg__composer-camera {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--imsg-label-secondary);
  cursor: pointer;
}
.imsg__composer-field {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--imsg-hairline);
  background: var(--imsg-bg);
}
.imsg__composer-placeholder {
  font-size: 16px;
  color: var(--imsg-placeholder);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.imsg__composer-send {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: none;
  background: var(--imsg-blue);
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
`;

  return { html, css };
}

export default renderIMessage;
