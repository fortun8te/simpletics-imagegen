// lib/native-components/x-post.mjs — FIRST "native component": the X/Twitter Post detail
// chrome, authored as REAL browser-laid-out HTML/CSS (flexbox + natural block flow) instead of
// the hand-positioned scene-graph layers lib/templates.mjs's `x-post-ad` template builds.
//
// Why this exists: `x-post-ad` (lib/templates.mjs) hand-computes every box — it measures
// character counts to guess paragraph line-wraps, divides the action row into equal slots by
// hand, and sizes the "Following" pill from `text.length * fontSize * 0.72`. That's real work
// duplicating what a browser does for free. This component instead emits markup that leans on
// the browser's own layout engine:
//   - the header is a flex row (avatar · name/handle column · spacer · Following pill) — the
//     pill's width comes from its own text content (padding + intrinsic width), not a guess
//   - the action row is `justify-content: space-between` — five icon+count groups space
//     themselves evenly across the row width; no per-slot pixel math
//   - paragraphs are normal flow-content <p> tags with `white-space: pre-wrap` + margin/gap —
//     the browser wraps and stacks them; no chars-per-line estimate
//
// See lib/native-components/README.md for the pattern this and future components follow.
//
// Public API: renderXPost(params) => { html, css }
//   - `html` is a single self-contained `<div class="x-post"> … </div>` fragment — embeddable
//     inside any larger document (no <html>/<body>/<head>).
//   - `css` is a plain `<style>`-body string (unscoped by class .x-post — caller wraps in
//     <style>…</style> or inlines into a bundle; safe to concatenate with other components'
//     css as long as class names don't collide, which is why every selector is prefixed
//     `.x-post`).
//
// Every meaningful element carries `data-role="…"` (stable hook name) and text-bearing elements
// additionally carry `data-param="…"` (the params key that produced the text) — this is the
// hook a FUTURE "capture" step reads to pull back computed geometry/styles per element and to
// map visual edits back onto params. No renderer/editor wiring consumes these yet.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Defaults mirror the `x-post-ad` template's own defaults (lib/templates.mjs) — the ad-9
 *  benchmark copy — so the two are directly comparable side by side. */
const DEFAULTS = {
  name: 'UPFRONT',
  handle: '@UpfrontFood',
  verified: true,
  body:
    'LAATSTE SITE WIDE SALE VAN 2026 ⏳\n\n' +
    'De Vakantiegeldsale komt eraan, waarbij je 20% korting krijgt op het volledige assortiment.\n\n' +
    'Daarbovenop krijgen de eerste 500 bestellingen hun geld terug tot €100.\n\n' +
    'Schrijf je nu in en mis geen enkele update. We zien je woensdag 20 mei om 20:00 uur. 👀',
  timestamp: '05:00 PM · 12-05-2026',
  views: '121K',
  viewsLabel: 'views',
  followLabel: 'Following',
  replies: '257',
  reposts: '66',
  likes: '21K',
  bookmarks: '89',
  avatarUrl: '',
  // active-state flags (icon fills X-blue/pink/green when true) — off by default so the
  // rendered defaults match the plain benchmark screenshot.
  liked: false,
  reposted: false,
  bookmarked: false,
};

// ── simple inline icon set (placeholder — a curated set lands later in
//    src/components/design/nativeIcons.ts; swap-in is a follow-up, not blocking this) ──────────
const ICONS = {
  reply: '<svg viewBox="0 0 24 24" width="18.75" height="18.75" aria-hidden="true"><path fill="currentColor" d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01Zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756Z"/></svg>',
  repost: '<svg viewBox="0 0 24 24" width="18.75" height="18.75" aria-hidden="true"><path fill="currentColor" d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM19.5 20.12l-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2H11V4h5.5c2.209 0 4 1.79 4 4v8.47l2.068-1.93 1.364 1.46-4.432 4.14z"/></svg>',
  like: '<svg viewBox="0 0 24 24" width="18.75" height="18.75" aria-hidden="true"><path fill="currentColor" d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" width="18.75" height="18.75" aria-hidden="true"><path fill="currentColor" d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5zM6.5 4c-.276 0-.5.22-.5.5v14.56l6-4.29 6 4.29V4.5c0-.28-.224-.5-.5-.5h-11z"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="18.75" height="18.75" aria-hidden="true"><path fill="currentColor" d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.29 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z"/></svg>',
  verified: '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path fill="currentColor" d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.239-.65-1.31-1.972-2.21-3.496-2.21s-2.846.9-3.496 2.21c-.416-.155-.866-.239-1.336-.239-2.11 0-3.818 1.79-3.818 4 0 .494.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.582.875 2.95 2.147 3.6-.154.436-.237.905-.237 1.4 0 2.21 1.709 4 3.818 4 .47 0 .92-.086 1.335-.24.652 1.31 1.973 2.21 3.497 2.21s2.845-.9 3.496-2.21c.415.154.865.24 1.336.24 2.108 0 3.818-1.79 3.818-4 0-.495-.084-.964-.238-1.4 1.273-.65 2.148-2.018 2.148-3.6zm-11.61 4.86l-3.7-3.7 1.415-1.414 2.285 2.286 4.985-4.986 1.415 1.414-6.4 6.4z"/></svg>',
};

/** Escapes text for use inside an attribute or text node (icons/svg are trusted literals above). */
const t = (s) => esc(s);

/** Renders the X/Twitter "Post detail" chrome. Pure function: params in, {html,css} out.
 *  No DOM globals used — safe in Node (SSR/export) and the browser alike. */
export function renderXPost(params = {}) {
  const p = { ...DEFAULTS, ...params };
  const paragraphs = String(p.body || '')
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);

  const activeClass = (flag, colorClass) => (flag ? ` x-post__icon-btn--${colorClass}` : '');

  const avatar = p.avatarUrl
    ? `<img class="x-post__avatar" data-role="avatar" data-param="avatarUrl" src="${t(p.avatarUrl)}" alt="" />`
    : `<div class="x-post__avatar x-post__avatar--placeholder" data-role="avatar" data-param="avatarUrl"></div>`;

  const html = `<div class="x-post" data-role="root">
  <div class="x-post__nav" data-role="nav">
    <span class="x-post__nav-icon" data-role="nav-back" aria-hidden="true">&#8592;</span>
    <span class="x-post__nav-title" data-role="nav-title">Post</span>
    <span class="x-post__nav-icon" data-role="nav-more" aria-hidden="true">&#8943;</span>
  </div>

  <div class="x-post__header" data-role="header">
    ${avatar}
    <div class="x-post__id-col" data-role="id-col">
      <div class="x-post__name-row" data-role="name-row">
        <span class="x-post__name" data-role="name" data-param="name">${t(p.name)}</span>
        ${p.verified ? `<span class="x-post__verified" data-role="verified" data-param="verified">${ICONS.verified}</span>` : ''}
      </div>
      <span class="x-post__handle" data-role="handle" data-param="handle">${t(p.handle)}</span>
    </div>
    <span class="x-post__spacer" data-role="header-spacer"></span>
    <button class="x-post__follow-pill" data-role="following-pill" data-param="followLabel" type="button">${t(p.followLabel)}</button>
  </div>

  <div class="x-post__body" data-role="body">
    ${paragraphs.map((para, i) => `<p class="x-post__paragraph" data-role="body-paragraph" data-param="body" data-para-index="${i}">${t(para)}</p>`).join('\n    ')}
  </div>

  <div class="x-post__meta" data-role="meta">
    <span class="x-post__meta-time" data-role="meta-time" data-param="timestamp">${t(p.timestamp)}</span>
    <span class="x-post__meta-dot" aria-hidden="true">&middot;</span>
    <span class="x-post__meta-views" data-role="meta-views" data-param="views">${t(p.views)}</span>
    <span class="x-post__meta-views-label" data-role="meta-views-label" data-param="viewsLabel">${t(p.viewsLabel)}</span>
  </div>

  <div class="x-post__actions" data-role="actions">
    <button class="x-post__icon-btn" data-role="action-reply" type="button">
      <span class="x-post__icon" aria-hidden="true">${ICONS.reply}</span>
      <span class="x-post__icon-count" data-param="replies">${t(p.replies)}</span>
    </button>
    <button class="x-post__icon-btn${activeClass(p.reposted, 'repost')}" data-role="action-repost" type="button">
      <span class="x-post__icon" aria-hidden="true">${ICONS.repost}</span>
      <span class="x-post__icon-count" data-param="reposts">${t(p.reposts)}</span>
    </button>
    <button class="x-post__icon-btn${activeClass(p.liked, 'like')}" data-role="action-like" type="button">
      <span class="x-post__icon" aria-hidden="true">${ICONS.like}</span>
      <span class="x-post__icon-count" data-param="likes">${t(p.likes)}</span>
    </button>
    <button class="x-post__icon-btn${activeClass(p.bookmarked, 'bookmark')}" data-role="action-bookmark" type="button">
      <span class="x-post__icon" aria-hidden="true">${ICONS.bookmark}</span>
      <span class="x-post__icon-count" data-param="bookmarks">${t(p.bookmarks)}</span>
    </button>
    <button class="x-post__icon-btn x-post__icon-btn--share" data-role="action-share" type="button">
      <span class="x-post__icon" aria-hidden="true">${ICONS.share}</span>
    </button>
  </div>
</div>`;

  const css = `
.x-post {
  --x-bg: #000000;
  --x-text: #e7e9ea;
  --x-muted: #71767b;
  --x-blue: #1d9bf0;
  --x-hairline: #2f3336;
  --x-like: #f91880;
  --x-repost: #00ba7c;
  --x-bookmark: #1d9bf0;

  box-sizing: border-box;
  width: 100%;
  max-width: 600px;
  background: var(--x-bg);
  color: var(--x-text);
  font-family: 'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.x-post * { box-sizing: border-box; }

/* ── nav row: back arrow / centered title / more — plain flex row, no manual widths ───────── */
.x-post__nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.x-post__nav-icon { font-size: 20px; font-weight: 700; color: var(--x-text); line-height: 1; }
.x-post__nav-title { font-size: 17px; font-weight: 800; color: var(--x-text); }

/* ── header: avatar · name/handle column · SPACER · Following pill ───────────────────────────
   The spacer (flex: 1 1 auto) is what pushes the pill to the far right — no hand-computed
   followX = w - pad - followW like the scene-graph template. The pill's own width comes
   from its text + padding (intrinsic sizing), not a text.length * fontSize * 0.72 guess. */
.x-post__header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.x-post__avatar {
  flex: 0 0 auto;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
  background: linear-gradient(160deg, #ffffff, #dcdcdc);
}
.x-post__avatar--placeholder { background: linear-gradient(160deg, #ffffff, #dcdcdc); }
.x-post__id-col {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0; /* allow the handle/name to truncate instead of forcing row overflow */
}
.x-post__name-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.x-post__name {
  font-size: 15px;
  font-weight: 800;
  color: var(--x-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.x-post__verified {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  color: var(--x-blue);
  display: inline-flex;
}
.x-post__handle {
  font-size: 14px;
  font-weight: 400;
  color: var(--x-muted);
}
.x-post__spacer { flex: 1 1 auto; }
.x-post__follow-pill {
  flex: 0 0 auto;
  align-self: center;
  border: none;
  background: #ffffff;
  color: #0f1419;
  font-family: inherit;
  font-size: 14px;
  font-weight: 700;
  line-height: 1;
  padding: 8px 16px;      /* width HUGS the label text — the browser sizes this, not us */
  border-radius: 9999px;
  cursor: pointer;
  white-space: nowrap;
}

/* ── body: natural block flow — each paragraph is its own <p>, spaced by margin/gap, wrapped
   by the browser at the container width. No chars-per-line estimate, no per-paragraph height
   math like layoutParas() in lib/templates.mjs. ─────────────────────────────────────────────── */
.x-post__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.x-post__paragraph {
  margin: 0;
  font-size: 17px;
  font-weight: 400;
  line-height: 1.42;
  color: var(--x-text);
  white-space: pre-wrap;   /* preserve intentional single \n inside a paragraph, if any */
  overflow-wrap: break-word;
}

/* ── meta line: timestamp · dot · bold viewcount · label — plain inline flex row ─────────────── */
.x-post__meta {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 15px;
  color: var(--x-muted);
  padding-bottom: 12px;
  border-bottom: 1px solid var(--x-hairline);
}
.x-post__meta-views { font-weight: 800; color: var(--x-text); }
.x-post__meta-dot { color: var(--x-muted); }

/* ── action row: reply / repost / like / bookmark / share — justify-content: space-between
   spaces the five buttons evenly across the row. The scene-graph template instead divides
   (w - pad*2) / (slotDefs.length + 1) into fixed pixel slots by hand; here the browser does
   that division for us, and each button's own width still hugs its icon+count content. ────────── */
.x-post__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.x-post__icon-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  color: var(--x-muted);
  font-family: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 1;
  padding: 0;
  cursor: pointer;
}
.x-post__icon { display: inline-flex; width: 18.75px; height: 18.75px; color: inherit; }
.x-post__icon-count { color: inherit; }
.x-post__icon-btn--share { margin-left: 0; }

/* active states — not used by default params, opt in via liked/reposted/bookmarked flags */
.x-post__icon-btn--like { color: var(--x-like); }
.x-post__icon-btn--repost { color: var(--x-repost); }
.x-post__icon-btn--bookmark { color: var(--x-bookmark); }
`;

  return { html, css };
}

export default renderXPost;
