// nativeIcons.ts — curated REAL vector icon paths for native-UI chrome (X/Twitter, Instagram,
// iOS), for use with shapeKind 'path' layers (see sceneGraph.ts LayerStyle.path and Stage.tsx's
// path render case).
//
// SOURCE:
//  - X/Twitter icons (reply, repost, likeOutline, bookmarkOutline, share, verifiedBadge, more) are
//    the REAL paths X.com ships, extracted verbatim from a logged-in x.com/home session's live DOM
//    (getComputedStyle/querySelector on real tweet articles) — not approximations. Source viewBox
//    is "0 0 24 24" for all of those except verifiedBadge ("0 0 22 22"); verifiedBadge is ONE
//    combined path (rosette + check baked together), matching how X actually ships it.
//  - Instagram heartOutline (like), comment, repost, and share are likewise REAL paths Instagram
//    ships, extracted verbatim from a logged-in instagram.com session's live DOM (2026-07-03 pass,
//    alongside the DOM-verified color/gradient data in lib/instagram-colors.mjs) — not
//    approximations. Source viewBox is "0 0 24 24" for all four. `repost` is IG's current
//    reshare-arrows icon (not the older paper-plane). bookmarkOutline/bookmarkFilled/more/
//    verifiedBadge/heartFilled remain Bootstrap Icons approximations below — no verbatim source
//    was captured for those on this pass (bookmark/more rendered via a technique that returned
//    empty path data during DOM extraction).
//  - Every other icon (X likeFilled/bookmarkFilled/back, remaining Instagram icons, all iOS icons)
//    comes from Bootstrap Icons v1.13.1 (MIT licensed, https://github.com/twbs/bootstrap-icons) — a
//    well-known, freely-usable open icon set — rather than hand-drawn/invented shapes. Each of
//    those source glyphs ships as a 16x16 viewBox `<path d="...">`.
//
// NORMALIZATION: every d-string below has been rescaled by dividing all coordinate numbers by the
// source glyph's OWN viewBox dimension (24, 22, or 16 — see above), so paths live in a 0..1 box
// exactly like sceneGraph.ts documents: "style.path: an SVG path string ... coordinates normalized
// 0..1 within the layer's box". This is the SAME convention raster.ts (pathGeometry:
// translate(box.x,box.y)·scale(box.w,box.h)), designSvg.ts (pathGeomAttrs: transform="translate(x
// y) scale(w h)"), and designstore.mjs (renderDesignHtml inline-svg branch: transform="translate(0
// 0) scale(w h)") already assume — so a layer using any `d` below renders identically across the
// live Stage editor, the raster PNG export, the SVG export, and the server-rendered HTML export.
//
// Some glyphs (e.g. the Bootstrap heart shapes) legitimately overshoot the 0..1 box slightly —
// that's faithful to the source icon's own design (the glyph extends a hair past its own square
// viewBox) and is expected, not a bug.

/** A single normalized vector icon: `d` is an SVG path string with coordinates in 0..1 box
 *  space; `viewBox` records the source glyph's original [w, h] for reference/debugging only —
 *  renderers never need it since `d` is already normalized. */
export interface NativeIconPath {
  d: string;
  viewBox: [number, number];
}

const VB16: [number, number] = [16, 16];
const VB24: [number, number] = [24, 24];
const VB22: [number, number] = [22, 22];

// ── X / Twitter ─────────────────────────────────────────────────────────────────────────────
// reply/repost/likeOutline/bookmarkOutline/share/verifiedBadge/more below are the REAL paths
// X.com ships (extracted verbatim from x.com/home's live DOM — see file header). likeFilled and
// back have no simple verbatim source handy and remain Bootstrap Icons approximations.

export const TWITTER_ICONS = {
  /** Reply — speech bubble (real X.com path, viewBox 24). */
  reply: {
    d: 'M0.072958 0.416667c0 -0.184167 0.149333 -0.333333 0.333542 -0.333333h0.181917c0.187083 0 0.338708 0.151667 0.338708 0.33875 0 0.123333 -0.066958 0.236667 -0.174833 0.29625l-0.335583 0.185833v-0.15375h-0.002792c-0.187083 0.004167 -0.340958 -0.14625 -0.340958 -0.33375zm0.333542 -0.25c-0.138208 0 -0.250208 0.112083 -0.250208 0.25 0 0.140417 0.115417 0.253333 0.25575 0.250417l0.014625 -0.000417h0.073375v0.095833l0.211958 -0.117083c0.081292 -0.045 0.131792 -0.130417 0.131792 -0.223333 0 -0.14125 -0.114333 -0.255417 -0.255375 -0.255417H0.4065z',
    viewBox: VB24,
  },
  /** Repost — retweet loop arrows (real X.com path, viewBox 24). */
  repost: {
    d: 'M0.1875 0.161667l0.184667 0.1725 -0.056833 0.060833L0.229167 0.314583V0.666667c0 0.045833 0.037333 0.083333 0.083333 0.083333H0.541667v0.083333H0.3125c-0.092042 0 -0.166667 -0.074583 -0.166667 -0.166667V0.314583L0.059667 0.395 0.002833 0.334167 0.1875 0.161667zM0.6875 0.25H0.458333V0.166667h0.229167c0.092042 0 0.166667 0.074583 0.166667 0.166667v0.352083l0.086167 -0.080417 0.056833 0.060833 -0.184667 0.1725 -0.184667 -0.1725 0.056833 -0.060833 0.086167 0.080417V0.333333c0 -0.045833 -0.037333 -0.083333 -0.083333 -0.083333z',
    viewBox: VB24,
  },
  /** Like — heart outline (real X.com path, viewBox 24). */
  likeOutline: {
    d: 'M0.695708 0.229167c-0.050917 -0.0025 -0.111625 0.02125 -0.162083 0.09l-0.033542 0.045417 -0.033583 -0.045417C0.416 0.250417 0.35525 0.226667 0.304333 0.229167c-0.051792 0.002917 -0.097875 0.0325 -0.12125 0.079583 -0.023 0.046667 -0.026375 0.115833 0.019958 0.200833 0.04475 0.082083 0.135708 0.177917 0.297042 0.275417 0.16125 -0.0975 0.252167 -0.193333 0.296917 -0.275417 0.046292 -0.085 0.042917 -0.154167 0.019875 -0.200833 -0.023375 -0.047083 -0.069417 -0.076667 -0.121167 -0.079583zm0.174458 0.320417c-0.056292 0.103333 -0.166708 0.213333 -0.349125 0.319583l-0.020958 0.0125 -0.021 -0.0125c-0.182458 -0.10625 -0.292875 -0.21625 -0.34925 -0.319583 -0.056667 -0.104167 -0.05875 -0.2025 -0.021417 -0.277917 0.036958 -0.074583 0.110292 -0.12125 0.191708 -0.125417 0.068792 -0.00375 0.140333 0.023333 0.199917 0.08375 0.059542 -0.060417 0.131083 -0.0875 0.199833 -0.08375 0.081417 0.004167 0.15475 0.050833 0.191708 0.125417 0.037333 0.075417 0.03525 0.17375 -0.021417 0.277917z',
    viewBox: VB24,
  },
  /** Like — heart filled (bootstrap "heart-fill"; no simple verbatim X source). */
  likeFilled: {
    d: 'M0.5 0.082125C0.777375 -0.203 1.470875 0.295938 0.5 0.9375 -0.470875 0.296 0.222625 -0.203 0.5 0.082125',
    viewBox: VB16,
  },
  /** Bookmark — outline (real X.com path, viewBox 24). */
  bookmarkOutline: {
    d: 'M0.166667 0.1875C0.166667 0.13 0.213292 0.083333 0.270833 0.083333h0.458333C0.786708 0.083333 0.833333 0.13 0.833333 0.1875v0.768333l-0.333333 -0.237917 -0.333333 0.237917V0.1875zM0.270833 0.166667c-0.0115 0 -0.020833 0.009167 -0.020833 0.020833v0.606667l0.25 -0.17875 0.25 0.17875V0.1875c0 -0.011667 -0.009333 -0.020833 -0.020833 -0.020833h-0.458333z',
    viewBox: VB24,
  },
  /** Bookmark — filled (bootstrap "bookmark-fill"; no simple verbatim X source). */
  bookmarkFilled: {
    d: 'M0.125 0.125v0.84375a0.03125 0.03125 0 0 0 0.04625 0.027438L0.5 0.816813l0.32875 0.179375A0.03125 0.03125 0 0 0 0.875 0.96875V0.125a0.125 0.125 0 0 0 -0.125 -0.125H0.25a0.125 0.125 0 0 0 -0.125 0.125',
    viewBox: VB16,
  },
  /** Share — up-arrow-from-tray (real X.com path, viewBox 24). */
  share: {
    d: 'M0.5 0.107917l0.2375 0.2375 -0.05875 0.059167L0.541667 0.267083V0.666667h-0.083333V0.267083l-0.1375 0.1375 -0.05875 -0.059167L0.5 0.107917zM0.875 0.625l-0.000833 0.14625c0 0.0575 -0.046667 0.10375 -0.104167 0.10375H0.229167C0.17125 0.875 0.125 0.828333 0.125 0.770833V0.625h0.083333v0.145833c0 0.011667 0.009167 0.020833 0.020833 0.020833h0.540833c0.011667 0 0.020833 -0.009167 0.020833 -0.020833L0.791667 0.625h0.083333z',
    viewBox: VB24,
  },
  /** Verified — scalloped rosette badge WITH its check baked in as one combined path (real
   *  X.com path, viewBox 22 — X ships this as a single filled glyph, not two layers). */
  verifiedBadge: {
    d: 'M0.927091 0.5c-0.000818 -0.029364 -0.009773 -0.057955 -0.025909 -0.082545 -0.016091 -0.024545 -0.038727 -0.044182 -0.065364 -0.056636 0.010136 -0.027591 0.012273 -0.057455 0.006364 -0.086227 -0.005955 -0.028818 -0.019864 -0.055364 -0.040091 -0.076682 -0.021364 -0.020227 -0.047864 -0.034091 -0.076682 -0.040091 -0.028773 -0.005909 -0.058636 -0.003773 -0.086227 0.006364 -0.012409 -0.026682 -0.032 -0.049364 -0.056591 -0.065455S0.529409 0.073636 0.5 0.072909c-0.029364 0.000773 -0.057864 0.009682 -0.082409 0.025818s-0.044045 0.038818 -0.056364 0.065455c-0.027636 -0.010136 -0.057591 -0.012364 -0.086455 -0.006364 -0.028864 0.005909 -0.055455 0.019818 -0.076818 0.040091 -0.020227 0.021364 -0.034045 0.047955 -0.039909 0.076727 -0.005909 0.028773 -0.003636 0.058636 0.006545 0.086182 -0.026682 0.012455 -0.049409 0.032045 -0.065591 0.056591 -0.016182 0.024545 -0.025227 0.053182 -0.026091 0.082591 0.000909 0.029409 0.009909 0.058 0.026091 0.082591 0.016182 0.024545 0.038909 0.044182 0.065591 0.056591 -0.010182 0.027545 -0.012455 0.057409 -0.006545 0.086182 0.005909 0.028818 0.019682 0.055364 0.039864 0.076727 0.021364 0.020136 0.047909 0.033955 0.076682 0.039909 0.028773 0.006 0.058636 0.003818 0.086227 -0.006182 0.012455 0.026636 0.032045 0.049273 0.056636 0.065409 0.024545 0.016091 0.053182 0.025045 0.082545 0.025864 0.029409 -0.000727 0.058 -0.009682 0.082591 -0.025773s0.044182 -0.038818 0.056591 -0.065455c0.027455 0.010864 0.057545 0.013455 0.0865 0.007455 0.028909 -0.006 0.055455 -0.020318 0.076364 -0.041227 0.020909 -0.020909 0.035273 -0.047455 0.041273 -0.076409s0.003409 -0.059045 -0.0075 -0.0865c0.026636 -0.012455 0.049273 -0.032045 0.065409 -0.056636 0.016091 -0.024545 0.025045 -0.053182 0.025864 -0.082545zM0.439182 0.675l-0.155864 -0.155818 0.058773 -0.059182 0.094182 0.094182 0.2 -0.217909 0.061227 0.056636z',
    viewBox: VB22,
  },
  /** The "···" more-options icon (real X.com path, viewBox 24). */
  more: {
    d: 'M0.125 0.5c0 -0.045833 0.0375 -0.083333 0.083333 -0.083333s0.083333 0.0375 0.083333 0.083333 -0.0375 0.083333 -0.083333 0.083333 -0.083333 -0.0375 -0.083333 -0.083333zm0.375 0.083333c0.045833 0 0.083333 -0.0375 0.083333 -0.083333s-0.0375 -0.083333 -0.083333 -0.083333 -0.083333 0.0375 -0.083333 0.083333 0.0375 0.083333 0.083333 0.083333zm0.291667 0c0.045833 0 0.083333 -0.0375 0.083333 -0.083333s-0.0375 -0.083333 -0.083333 -0.083333 -0.083333 0.0375 -0.083333 0.083333 0.0375 0.083333 0.083333 0.083333z',
    viewBox: VB24,
  },
  /** Back chevron (bootstrap "chevron-left"; no simple verbatim X source). */
  back: {
    d: 'M0.709625 0.102875a0.03125 0.03125 0 0 1 0 0.04425L0.356688 0.5l0.352938 0.352875a0.03125 0.03125 0 0 1 -0.04425 0.04425l-0.375 -0.375a0.03125 0.03125 0 0 1 0 -0.04425l0.375 -0.375a0.03125 0.03125 0 0 1 0.04425 0',
    viewBox: VB16,
  },
} satisfies Record<string, NativeIconPath>;

// ── Instagram ───────────────────────────────────────────────────────────────────────────────

export const INSTAGRAM_ICONS = {
  /** Like — heart outline (real Instagram path, viewBox 24, extracted verbatim from a logged-in
   *  instagram.com session's live DOM — see file header). */
  heartOutline: {
    d: 'M0.699667 0.162667A0.207875 0.207875 0 0 1 0.895833 0.380083c0 0.128 -0.1105 0.206625 -0.216542 0.300917 -0.104667 0.093458 -0.161042 0.144542 -0.179292 0.156333 -0.019875 -0.012875 -0.089292 -0.075958 -0.179292 -0.156333C0.214208 0.586333 0.104167 0.506958 0.104167 0.380083a0.207875 0.207875 0 0 1 0.196167 -0.217417a0.175417 0.175417 0 0 1 0.153125 0.080875c0.035 0.048958 0.040833 0.073458 0.046667 0.073458s0.011583 -0.0245 0.04625 -0.073583a0.17375 0.17375 0 0 1 0.153292 -0.08075m0 -0.083333a0.251667 0.251667 0 0 0 -0.199875 0.088625a0.252167 0.252167 0 0 0 -0.199458 -0.088625A0.291042 0.291042 0 0 0 0.020833 0.380083c0 0.150417 0.10625 0.242792 0.208958 0.332083c0.011792 0.01025 0.023708 0.020583 0.035542 0.031125l0.042792 0.03825a1.874917 1.874917 0 0 0 0.146583 0.12575a0.083333 0.083333 0 0 0 0.090583 0a1.885958 1.885958 0 0 0 0.151083 -0.129792l0.038417 -0.034333c0.012208 -0.010833 0.024583 -0.021625 0.036875 -0.03225c0.09725 -0.084375 0.2075 -0.18 0.2075 -0.330833a0.291042 0.291042 0 0 0 -0.2795 -0.30075Z',
    viewBox: VB24,
  },
  /** Like — heart filled (bootstrap "heart-fill"; no verbatim IG source captured this pass). */
  heartFilled: {
    d: 'M0.5 0.082125C0.777375 -0.203 1.470875 0.295938 0.5 0.9375 -0.470875 0.296 0.222625 -0.203 0.5 0.082125',
    viewBox: VB16,
  },
  /** Comment — speech bubble (real Instagram path, viewBox 24, extracted verbatim — see file
   *  header). */
  comment: {
    d: 'M0.860667 0.708667a0.416375 0.416375 0 1 0 -0.149583 0.150625L0.916667 0.916667Z',
    viewBox: VB24,
  },
  /** Repost/reshare — the newer IG reshare-arrows icon, not the old paper-plane (real Instagram
   *  path, viewBox 24, extracted verbatim — see file header). */
  repost: {
    d: 'M0.83325 0.395708a0.041667 0.041667 0 0 0 -0.041667 0.041667v0.176167a0.136417 0.136417 0 0 1 -0.13625 0.13625h-0.221375l0.074625 -0.074458a0.041667 0.041667 0 0 0 -0.058833 -0.059L0.30375 0.761958a0.041833 0.041833 0 0 0 -0.01225 0.029458v0.000042c0 0.000958 0.0005 0.00175 0.000542 0.002708a0.038458 0.038458 0 0 0 0.011708 0.026792l0.145917 0.146a0.041667 0.041667 0 0 0 0.058917 -0.058917l-0.074875 -0.074917h0.221583a0.219833 0.219833 0 0 0 0.219583 -0.219583v-0.176167a0.041667 0.041667 0 0 0 -0.041667 -0.041667Zm-0.267083 -0.145667l-0.074792 0.074792a0.041667 0.041667 0 1 0 0.058917 0.058917l0.145833 -0.145833a0.041792 0.041792 0 0 0 0 -0.059042l-0.145833 -0.145833a0.041667 0.041667 0 0 0 -0.058917 0.058917l0.07475 0.07475H0.344583A0.219875 0.219875 0 0 0 0.125 0.386292V0.5625a0.041667 0.041667 0 0 0 0.083333 0V0.386292a0.136458 0.136458 0 0 1 0.136292 -0.13625Z',
    viewBox: VB24,
  },
  /** Share — paper-airplane/DM-share (real Instagram path, viewBox 24, extracted verbatim — see
   *  file header). */
  share: {
    d: 'M0.582208 0.83525L0.907083 0.288667C0.95 0.216458 0.897917 0.125 0.813958 0.125H0.186083C0.089083 0.125 0.041 0.242708 0.11025 0.310667l0.20175 0.198l0.071792 0.296708c0.022833 0.094417 0.148792 0.113375 0.198417 0.029875Z',
    viewBox: VB24,
  },
  /** Save/bookmark ribbon — outline (bootstrap "bookmark"; no verbatim IG source captured this
   *  pass — bookmark rendered via a different technique on the live page and returned empty path
   *  data during DOM extraction). */
  bookmarkOutline: {
    d: 'M0.125 0.125a0.125 0.125 0 0 1 0.125 -0.125h0.5a0.125 0.125 0 0 1 0.125 0.125v0.84375a0.03125 0.03125 0 0 1 -0.048562 0.026L0.5 0.818813l-0.326437 0.175938A0.03125 0.03125 0 0 1 0.125 0.96875zm0.125 -0.0625a0.0625 0.0625 0 0 0 -0.0625 0.0625v0.785375l0.295188 -0.155125a0.03125 0.03125 0 0 1 0.034625 0L0.8125 0.910375V0.125a0.0625 0.0625 0 0 0 -0.0625 -0.0625z',
    viewBox: VB16,
  },
  /** Save/bookmark ribbon — filled (bootstrap "bookmark-fill"). */
  bookmarkFilled: {
    d: 'M0.125 0.125v0.84375a0.03125 0.03125 0 0 0 0.04625 0.027438L0.5 0.816813l0.32875 0.179375A0.03125 0.03125 0 0 0 0.875 0.96875V0.125a0.125 0.125 0 0 0 -0.125 -0.125H0.25a0.125 0.125 0 0 0 -0.125 0.125',
    viewBox: VB16,
  },
  /** The "···" more-options icon (bootstrap "three-dots"). */
  more: {
    d: 'M0.1875 0.59375a0.09375 0.09375 0 1 1 0 -0.1875 0.09375 0.09375 0 0 1 0 0.1875m0.3125 0a0.09375 0.09375 0 1 1 0 -0.1875 0.09375 0.09375 0 0 1 0 0.1875m0.3125 0a0.09375 0.09375 0 1 1 0 -0.1875 0.09375 0.09375 0 0 1 0 0.1875',
    viewBox: VB16,
  },
  /** Verified — simple circle + check, ONE combined path (bootstrap "check-circle-fill"); unlike
   *  the X badge, IG's verified mark is a plain filled circle so this needs no second layer. */
  verifiedBadge: {
    d: 'M1 0.5A0.5 0.5 0 1 1 0 0.5a0.5 0.5 0 0 1 1 0m-0.248125 -0.189375a0.046875 0.046875 0 0 0 -0.0675 0.001375L0.467313 0.588563 0.3365 0.457688a0.046875 0.046875 0 0 0 -0.06625 0.06625L0.435625 0.689375a0.046875 0.046875 0 0 0 0.067438 -0.00125l0.2495 -0.311875a0.046875 0.046875 0 0 0 -0.000625 -0.065625z',
    viewBox: VB16,
  },
} satisfies Record<string, NativeIconPath>;

// ── iOS ─────────────────────────────────────────────────────────────────────────────────────

export const IOS_ICONS = {
  /** Back chevron (bootstrap "chevron-left"). */
  back: {
    d: 'M0.709625 0.102875a0.03125 0.03125 0 0 1 0 0.04425L0.356688 0.5l0.352938 0.352875a0.03125 0.03125 0 0 1 -0.04425 0.04425l-0.375 -0.375a0.03125 0.03125 0 0 1 0 -0.04425l0.375 -0.375a0.03125 0.03125 0 0 1 0.04425 0',
    viewBox: VB16,
  },
  /** Checkmark — Notes checklist DONE state (bootstrap "check2"). */
  check: {
    d: 'M0.865875 0.227875a0.03125 0.03125 0 0 1 0 0.04425l-0.4375 0.4375a0.03125 0.03125 0 0 1 -0.04425 0l-0.21875 -0.21875a0.03125 0.03125 0 1 1 0.04425 -0.04425L0.40625 0.643313l0.415375 -0.415437a0.03125 0.03125 0 0 1 0.04425 0',
    viewBox: VB16,
  },
  /** Circle ring — Notes checklist UNCHECKED state (bootstrap "circle"). */
  circleUnchecked: {
    d: 'M0.5 0.9375A0.4375 0.4375 0 1 1 0.5 0.0625a0.4375 0.4375 0 0 1 0 0.875m0 0.0625A0.5 0.5 0 1 0 0.5 0a0.5 0.5 0 0 0 0 1',
    viewBox: VB16,
  },
} satisfies Record<string, NativeIconPath>;

// ── flat lookup ─────────────────────────────────────────────────────────────────────────────

/** Stable string keys for every icon above, addressable independent of platform grouping —
 *  e.g. `NATIVE_ICONS['x-like-filled']`, `NATIVE_ICONS['ig-heart-outline']`,
 *  `NATIVE_ICONS['ios-check']`. */
export const NATIVE_ICONS: Record<string, NativeIconPath> = {
  'x-reply': TWITTER_ICONS.reply,
  'x-repost': TWITTER_ICONS.repost,
  'x-like-outline': TWITTER_ICONS.likeOutline,
  'x-like-filled': TWITTER_ICONS.likeFilled,
  'x-bookmark-outline': TWITTER_ICONS.bookmarkOutline,
  'x-bookmark-filled': TWITTER_ICONS.bookmarkFilled,
  'x-share': TWITTER_ICONS.share,
  'x-verified-badge': TWITTER_ICONS.verifiedBadge,
  'x-more': TWITTER_ICONS.more,
  'x-back': TWITTER_ICONS.back,

  'ig-heart-outline': INSTAGRAM_ICONS.heartOutline,
  'ig-heart-filled': INSTAGRAM_ICONS.heartFilled,
  'ig-comment': INSTAGRAM_ICONS.comment,
  'ig-repost': INSTAGRAM_ICONS.repost,
  'ig-share': INSTAGRAM_ICONS.share,
  'ig-bookmark-outline': INSTAGRAM_ICONS.bookmarkOutline,
  'ig-bookmark-filled': INSTAGRAM_ICONS.bookmarkFilled,
  'ig-more': INSTAGRAM_ICONS.more,
  'ig-verified-badge': INSTAGRAM_ICONS.verifiedBadge,

  'ios-back': IOS_ICONS.back,
  'ios-check': IOS_ICONS.check,
  'ios-circle-unchecked': IOS_ICONS.circleUnchecked,
};
