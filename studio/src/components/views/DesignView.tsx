// Design view — router + gallery for the reference-first design system.
//
//   gallery : visual comp cards (thumbnails) + copied layouts (skeletons) + New comp entry.
//             "New comp"        → opens the Editor directly on a fresh blank comp; design mode
//                                 greets with attach-a-reference-to-copy OR start-blank (size).
//             Drop / paste a PNG → create a comp sized to the image, open the Editor, and kick a
//                                 "copy this reference" AGENT run in-editor (no standalone screen).
//             Paste FROM Figma  → decoded into a comp directly (figmaImport).
//   editor  : Editor — the canvas editor (Stage) with layers/inspector/underlay/export/agent.
//
// The old standalone "Copy from Reference" flow (pick reference → copy → pick base) is gone: copy
// is now an in-editor agent run (Editor.runCopyReference → /api/design/agent opts.reference).
//
// Workspace scoping: everything fetched with the active brand — comps/skeletons created in
// another workspace don't show here (legacy unstamped docs show everywhere).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { api } from '../../api';
import { useStore } from '../../store';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import Editor from '../design/Editor';
import { rasterizeDesign } from '../design/raster';
import { parseFigmaClipboard, sniffFigmaClipboard, uploadFigmaImages, applyFigmaImageUrls } from '../design/figmaImport';
import {
  applySkeleton, buildBlankDoc, CANVAS_PRESETS, designId, layerId,
  type CanvasPresetId, type DesignDoc,
} from '../../lib/sceneGraph';
import {
  makeVariants, pushToVariants, setIdOf, stampVariant, variantSetId, visibleTags,
  type PushFields, type VariantDoc,
} from '../../lib/variants';
import type { DesignSummary, SkeletonSummary, Slot } from '../../types';
import styles from './DesignView.module.css';

// A comp thumb doc may not carry tags in its DesignDoc type yet (the scene-graph type is owned by
// the editor side); treat them as an additive optional field when round-tripping getDesign→save.
type TaggableDoc = DesignDoc & { tags?: string[] };

// ── Download helpers ───────────────────────────────────────────────────────────────────────────
// Filesystem-safe file/folder name: strip characters that break on Windows/macOS/zip readers,
// collapse whitespace, trim dots/spaces, cap length. Empty → 'untitled'.
function sanitizeName(raw: string, fallback = 'untitled'): string {
  const cleaned = String(raw ?? '')
    .replace(/[\x00-\x1f]/g, ' ')
    .replace(/[/\\?%*:|"<>]/g, '-') // path-illegal chars → dash
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '') // no leading/trailing dot or space (Windows)
    .slice(0, 120)
    .trim();
  return cleaned || fallback;
}

// Ensure a name is unique within a folder by appending " (2)", " (3)", … before the extension.
function uniqueInFolder(used: Set<string>, base: string, ext: string): string {
  let candidate = `${base}${ext}`;
  let n = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base} (${n++})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

// ── Minimal STORE-method ZIP builder (zero-dep, no compression) ──────────────────────────────────
// Produces a valid .zip with an internal folder structure ("A/B/file.png"). STORE means bytes are
// copied verbatim — fine here since PNGs are already compressed.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function buildZip(entries: { path: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { path, data } of entries) {
    const nameBytes = enc.encode(path.replace(/\\/g, '/'));
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header sig
    lv.setUint16(4, 20, true);         // version needed
    lv.setUint16(6, 0x0800, true);     // flags: UTF-8 filenames
    lv.setUint16(8, 0, true);          // method 0 = STORE
    lv.setUint16(10, 0, true);         // mod time
    lv.setUint16(12, 0, true);         // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           // extra length
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); // central dir header sig
    cv.setUint16(4, 20, true);         // version made by
    cv.setUint16(6, 20, true);         // version needed
    cv.setUint16(8, 0x0800, true);     // flags: UTF-8
    cv.setUint16(10, 0, true);         // method STORE
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);    // relative offset of local header
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);       // end of central dir sig
  ev.setUint16(8, entries.length, true);   // entries on this disk
  ev.setUint16(10, entries.length, true);  // total entries
  ev.setUint32(12, centralSize, true);     // central dir size
  ev.setUint32(16, offset, true);          // central dir offset
  // Concatenate every part into one contiguous buffer, then hand the ArrayBuffer to Blob
  // (a plain Uint8Array is not a valid BlobPart under this TS lib config).
  const parts = [...chunks, ...central, end];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return new Blob([out.buffer as ArrayBuffer], { type: 'application/zip' });
}

// dataURL → raw bytes (for the PNG rasterizeDesign returns).
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Trigger a browser download of a Blob under a chosen filename.
function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function relTime(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** Aspect-ratio label from an image's natural dimensions: snap to the ratios ads actually ship
 *  in (1:1 / 4:5 / 9:16 / …) within a small tolerance, else a "1.35:1"-style decimal fallback. */
const KNOWN_RATIOS: [string, number][] = [
  ['1:1', 1], ['4:5', 4 / 5], ['9:16', 9 / 16], ['16:9', 16 / 9],
  ['3:4', 3 / 4], ['4:3', 4 / 3], ['2:3', 2 / 3], ['3:2', 3 / 2],
];
function ratioLabel(w: number, h: number): string | null {
  if (!(w > 0) || !(h > 0)) return null;
  const r = w / h;
  let best: string | null = null;
  let bestErr = 0.03; // 3% tolerance — thumbs are downscaled, exact ints are not guaranteed
  for (const [label, v] of KNOWN_RATIOS) {
    const err = Math.abs(r - v) / v;
    if (err < bestErr) { best = label; bestErr = err; }
  }
  return best ?? `${Math.round(r * 100) / 100}:1`;
}

/** Comp card thumbnail: cache-busted PNG with graceful fallbacks.
 *  - no thumb yet → name-initial tile (comp exists but hasn't been saved with a preview)
 *  - thumb 404s / breaks → palette icon tile (never the browser broken-image glyph)
 *  - ?v={updatedAt} busts the browser cache so stale thumbs refresh after saves.
 *  The image renders at its NATURAL aspect (contained + centered) inside the uniform-height
 *  thumb area; `withRatio` adds a small 1:1 / 4:5 / 9:16 badge from the natural dimensions. */
function CompThumbImg({ d, withRatio }: { d: DesignSummary; withRatio?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState<string | null>(null);
  const src = d.thumb
    ? `${d.thumb}${d.thumb.includes('?') ? '&' : '?'}v=${d.updatedAt || 0}`
    : null;
  // A new thumb / new version deserves a fresh attempt (and a fresh measurement).
  useEffect(() => { setFailed(false); setRatio(null); }, [src]);

  if (failed) {
    return <span className={styles.thumbEmpty}><Icon name="palette" size={18} /></span>;
  }
  if (!src) {
    const initial = (d.name || '').trim().charAt(0).toUpperCase();
    return <span className={styles.thumbInitial} aria-hidden>{initial || '?'}</span>;
  }
  return (
    <>
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        className={styles.thumbImg}
        onLoad={(e) => {
          const el = e.currentTarget;
          setRatio(ratioLabel(el.naturalWidth, el.naturalHeight));
        }}
        onError={() => setFailed(true)}
      />
      {withRatio && ratio ? <span className={styles.ratioBadge}>{ratio}</span> : null}
    </>
  );
}

/** The single quiet "⋯" card menu — reduced to the essentials the floating selection bar can't do
 *  (open / duplicate / variants / push / apply / add tag). Delete, Rename and Export live on the
 *  bar. Figma-quiet: icon column + labels, one radius. */
function CardMenu({ onOpen, onDuplicate, onVariants, onPush, onApply, onAddTag }: {
  onOpen: () => void;
  onDuplicate: () => void;
  onVariants: () => void;
  /** Only offered when the comp is part of a variant set. */
  onPush?: () => void;
  onApply: () => void;
  /** Only offered on cards that show a tag row. */
  onAddTag?: () => void;
}) {
  const item = (icon: string, label: string, fn: () => void, danger?: boolean) => (
    <DropdownMenu.Item
      className={styles.menuItem}
      data-danger={danger || undefined}
      onSelect={fn}
    >
      <span className={styles.menuIcon}><Icon name={icon} size={13} /></span>
      {label}
    </DropdownMenu.Item>
  );
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={styles.menuBtn} aria-label="Comp actions">⋯</button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={styles.menu} align="end" sideOffset={4} collisionPadding={8}>
          {item('design', 'Open', onOpen)}
          {item('copy', 'Duplicate', onDuplicate)}
          {item('layout-list', 'Make variants…', onVariants)}
          {onPush ? item('refresh', 'Push to siblings…', onPush) : null}
          {item('layout-grid', 'Apply to batch…', onApply)}
          {onAddTag ? item('plus', 'Add tag', onAddTag) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Done render images of the current batch — the apply-to-batch targets. */
function useBatchImages() {
  const state = useStore((s) => s.state);
  return useMemo(() => {
    const out: { src: string; label: string; source: { kind: 'render'; ref: string } }[] = [];
    for (const ad of state?.ads || []) {
      for (const v of ad.variations) {
        for (const p of v.prompts) {
          for (const slot of p.slots as Slot[]) {
            if (slot.status === 'done' && slot.relPath) {
              out.push({
                src: api.imgUrl(slot.relPath),
                label: `${ad.id}/${v.id} r${slot.run}`,
                source: { kind: 'render', ref: slot.relPath },
              });
            }
          }
        }
      }
    }
    return out;
  }, [state]);
}

export default function DesignView() {
  const brand = useStore((s) => s.brand);
  const docTick = useStore((s) => s.ui.docTick);
  // The open comp + how the Editor should behave on entry: `greet` shows the attach-a-reference /
  // start-blank onboarding (fresh "New comp"); `autoRun` kicks a copy-reference agent run at once
  // (drop / paste a reference). Both are one-shot flags consumed by the Editor on mount.
  const [doc, setDoc] = useState<DesignDoc | null>(null);
  const [editorGreet, setEditorGreet] = useState(false);
  const [editorAutoRun, setEditorAutoRun] = useState<{ reference: { ref: string; label?: string } } | null>(null);
  const [comps, setComps] = useState<DesignSummary[]>([]);
  const [skeletons, setSkeletons] = useState<SkeletonSummary[]>([]);
  const [applyFor, setApplyFor] = useState<DesignSummary | null>(null);
  const [applyPicked, setApplyPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  // gallery filtering: free-text (name + tags) and an active tag filter
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // inline "+ tag" editor: which comp id has the input open, and its draft text
  const [tagEditFor, setTagEditFor] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  // "Agent: <model>" READ-ONLY header indicator, from GET /api/llm/usage. Ornith is the single
  // default for everything now — there is no model-switching UI, just this label.
  const [agentLabel, setAgentLabel] = useState('Ornith');
  const [llmCfg, setLlmCfg] = useState<{ baseUrl?: string; model?: string; label?: string } | null>(null);
  // "Copied layouts" (skeletons) live under a collapsed disclosure — comps are the main grid
  const [skelOpen, setSkelOpen] = useState(false);
  // variant sets: "Make variants…" count popover target + "Push to siblings…" popover target
  const [variantsFor, setVariantsFor] = useState<DesignSummary | null>(null);
  const [pushFor, setPushFor] = useState<{ d: DesignSummary; setId: string } | null>(null);
  const [pushFields, setPushFields] = useState<PushFields>({ layout: true, styles: true, text: false, images: false });

  const batchImages = useBatchImages();

  // gallery scope + bulk selection (v4): see comps across every workspace. Multi-select is ALWAYS
  // on — no mode to enter. Plain click opens; ⌘/Ctrl/Shift-click toggles into the selection; a
  // drag on empty space rubber-bands a marquee that selects every intersecting card (Finder-style).
  const [allWorkspaces, setAllWorkspaces] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [barBusy, setBarBusy] = useState(false);
  // Marquee (rubber-band) drag state. `marquee` is the live rect in CLIENT (viewport) coords
  // (null = idle); the container ref anchors getBoundingClientRect() reads and card intersection
  // tests. The rect is stored in TRUE viewport coords so hit-testing against each card's
  // getBoundingClientRect() (also viewport coords) always matches what the cursor covers.
  const galleryRef = useRef<HTMLDivElement | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // The marquee is DRAWN inside this fixed overlay. `position:fixed` resolves against the nearest
  // ancestor that establishes a containing block (a `transform`, `filter`, `backdrop-filter`,
  // `perspective`, etc.) — and the app shell's <main> carries a backdrop-filter, so a plain
  // `position:fixed; left:clientX` box lands offset by <main>'s top-left, i.e. NOT under the
  // cursor. Rendering the rect inside this same-containing-block overlay and subtracting the
  // overlay's own viewport offset (marqueeStyle) puts it back exactly under the pointer, at any
  // scroll position, independent of which ancestor owns the containing block.
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const marqueeStyle = useCallback((r: { x: number; y: number; w: number; h: number }) => {
    const o = overlayRef.current?.getBoundingClientRect();
    const ox = o?.left ?? 0;
    const oy = o?.top ?? 0;
    return { left: r.x - ox, top: r.y - oy, width: r.w, height: r.h };
  }, []);

  // "Copied layouts" (skeletons) get the SAME marquee + checkbox + floating-bar interaction as
  // comps, but skeletons are a different data type (different delete API) — a separate Set keeps
  // the two selections from ever being confused with each other.
  const skelGridRef = useRef<HTMLDivElement | null>(null);
  const [selectedSkels, setSelectedSkels] = useState<Set<string>>(new Set());
  const [skelMarquee, setSkelMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [skelBarBusy, setSkelBarBusy] = useState(false);

  const flash = (m: string) => { setNote(m); window.setTimeout(() => setNote(null), 3500); };

  // STATE-5: switching workspace (brand) while a comp is open would leave the Editor autosaving the
  // OLD brand's doc into the new workspace's context. The gallery↔editor `if (doc)` split is
  // deliberate per-doc fresh state (STATE-4), so we don't try to keep the editor across brands —
  // we close it. Autosave persists on every change, so closing loses nothing. `doc.brand` may be
  // null on legacy/unstamped docs (they belong to every workspace) — only close when it's set and
  // actually mismatches the newly-selected brand.
  useEffect(() => {
    if (!doc) return;
    const docBrand = (doc as DesignDoc & { brand?: string | null }).brand ?? null;
    if (docBrand != null && docBrand !== brand) {
      const closedName = doc.name || 'comp';
      try { localStorage.removeItem(lastCompKey); } catch { /* ignore */ }
      setEditorGreet(false);
      setEditorAutoRun(null);
      setDoc(null);
      flash(`Closed “${closedName}” — workspace changed`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand]);

  const refresh = useCallback(() => {
    api.listDesigns(allWorkspaces ? null : brand).then((r) => setComps(r.designs || []));
    api.listSkeletons(brand).then((r) => setSkeletons(r.skeletons || []));
  }, [brand, allWorkspaces]);
  useEffect(() => { refresh(); }, [refresh]);
  // Live refresh: the server pushes a `doc` SSE tick whenever a design/skeleton/etc. is saved
  // (agent runs, other tabs). Debounced 300ms so a burst of saves coalesces into one refetch.
  useEffect(() => {
    if (!docTick) return;
    const t = window.setTimeout(() => refresh(), 300);
    return () => window.clearTimeout(t);
  }, [docTick, refresh]);

  // Agent/model info for the header chip. Defensive: the endpoint (and its provider shape) is
  // being added server-side; any miss keeps the "codex" fallback.
  useEffect(() => {
    let alive = true;
    fetch('/api/llm/usage', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { provider?: { name?: string; provider?: string; model?: string } | null; hasLlm?: boolean } | null) => {
        if (!alive || !j || !j.provider) return;
        const raw = j.provider.name || j.provider.provider || null;
        // Display names for bare lowercase provider ids; anything else passes through as-is.
        const KNOWN: Record<string, string> = { deepseek: 'DeepSeek', openai: 'OpenAI', anthropic: 'Anthropic', codex: 'Codex' };
        const name = raw ? (KNOWN[raw.toLowerCase()] || raw) : null;
        const model = j.provider.model || null;
        const label = [name, model].filter(Boolean).join(' · ');
        if (label) setAgentLabel(label);
      })
      .catch(() => { /* keep fallback */ });
    api.getLlmConfig().then((r) => {
      if (!alive || !r.ok) return; // route missing → read-only chip
      setLlmCfg(r.config || {});
    });
    return () => { alive = false; };
  }, []);

  const currentModelLabel = llmCfg?.label || llmCfg?.model || agentLabel;

  // The server's .state dir is the single source of truth — refetch on tab focus so two
  // tabs/instances pointed at the same backend always show the same comps/skeletons.
  // (Kept as a fallback for when the SSE stream is down.)
  useEffect(() => {
    const onFocus = () => { if (!document.hidden) refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  // Reload resilience: remember the comp being edited so a page refresh lands back in the
  // editor, not the gallery. Cleared on an explicit "← Comps" close.
  const lastCompKey = `neuegen.lastComp.${brand || 'default'}`;

  const openComp = useCallback(async (id: string) => {
    const r = await api.getDesign(id);
    if (r.ok && r.design) {
      setEditorGreet(false);
      setEditorAutoRun(null);
      setDoc(r.design);
      try { localStorage.setItem(lastCompKey, id); } catch { /* private mode etc. */ }
    }
  }, [lastCompKey]);

  // Toggle one card in/out of the selection without opening it (modifier-click / marquee helper).
  const toggleSelected = useCallback((id: string) => {
    setSelected((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);

  // Variant SET as a unit: selecting a set selects every member (the owner's ask — a set should be
  // just as selectable as a single comp). The set-level checkbox is "on" only when EVERY member is
  // selected; clicking it selects all members if any are missing, else deselects them all.
  const toggleSelectedSet = useCallback((ids: string[]) => {
    setSelected((cur) => {
      const next = new Set(cur);
      const allOn = ids.every((id) => next.has(id));
      if (allOn) for (const id of ids) next.delete(id);
      else for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const toggleSelectedSkel = useCallback((id: string) => {
    setSelectedSkels((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);
  const clearSkelSelection = useCallback(() => setSelectedSkels(new Set()), []);

  // Skeleton deletion: POST /api/skeleton/delete (see studio-server.mjs / lib/skeletons.mjs
  // deleteSkeleton) — not wrapped in api.ts yet, so call it directly the same way exportSelected
  // calls /api/design/export inline below.
  const deleteSelectedSkels = useCallback(async () => {
    const ids = [...selectedSkels];
    if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} copied layout${ids.length === 1 ? '' : 's'}? This can't be undone.`)) return;
    setSkelBarBusy(true);
    try {
      for (const id of ids) {
        try {
          await fetch('/api/skeleton/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* keep going — refresh reflects whatever actually got deleted */ }
      }
      flash(`Deleted ${ids.length} copied layout${ids.length === 1 ? '' : 's'}`);
      clearSkelSelection();
      refresh();
    } finally { setSkelBarBusy(false); }
  }, [selectedSkels, clearSkelSelection, refresh]);

  // Card click router: a plain click opens; ⌘/Ctrl or Shift toggles into the selection instead.
  // The marquee's own pointer handlers suppress the click that ends a real drag, so a click here
  // is always a genuine click (never the tail of a rubber-band).
  const onCardClick = useCallback((e: React.MouseEvent, id: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) { e.preventDefault(); toggleSelected(id); return; }
    openComp(id);
  }, [openComp, toggleSelected]);

  // Auto-reopen the stored comp once the first listDesigns for this mount resolves — only if it
  // still exists in the fetched list, and at most once per mount (no loops after closing).
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || doc || !comps.length) return;
    let stored: string | null = null;
    try { stored = localStorage.getItem(lastCompKey); } catch { /* ignore */ }
    if (!stored) return;
    autoOpened.current = true;
    if (comps.some((c) => c.id === stored)) openComp(stored);
    else { try { localStorage.removeItem(lastCompKey); } catch { /* ignore */ } }
  }, [comps, doc, lastCompKey, openComp]);

  // "New comp" → open the Editor directly on a fresh blank 1:1 comp, and GREET (attach a reference
  // to copy, or start blank with a size choice). No standalone screen — the choice is in-editor.
  const newComp = async () => {
    setBusy('blank');
    try {
      const preset = CANVAS_PRESETS[0]; // 1:1 default; editable in-editor from the greeting
      const fresh = buildBlankDoc('', { w: preset.w, h: preset.h }, { name: 'New comp', brand: brand ?? null });
      // A fresh blank comp reads as a clean white artboard (the owner disliked the old blue-navy
      // tint). role:'base' so the top-strip frame-color control targets it. Editable in-editor.
      fresh.layers = [{
        id: layerId('base'), type: 'shape', role: 'base', name: 'Background',
        box: { x: 0, y: 0, w: preset.w, h: preset.h },
        style: { shapeKind: 'rect', background: '#ffffff' },
      }];
      const s = await api.saveDesign(fresh);
      if (s.ok && s.design) {
        try { localStorage.setItem(lastCompKey, s.design.id); } catch { /* private mode etc. */ }
        setEditorAutoRun(null);
        setEditorGreet(true);
        setDoc(s.design);
      } else flash(s.error || 'Could not create comp');
    } finally { setBusy(null); }
  };

  // "Copied layouts" card → apply the saved skeleton onto a fresh blank comp and open the editor
  // directly (a one-click shortcut — no standalone new-comp screen).
  const startFromSkeleton = async (id: string) => {
    const r = await api.getSkeleton(id);
    if (!r.ok || !r.skeleton) return;
    const skel = r.skeleton;
    setBusy('blank');
    try {
      let fresh = buildBlankDoc('color:#ffffff', { w: skel.canvas.w, h: skel.canvas.h }, {
        name: skel.name ? `From ${skel.name}` : 'New comp',
        brand: brand ?? null,
        reference: skel.sourceRef ?? null,
      });
      fresh = applySkeleton(fresh, skel);
      const s = await api.saveDesign(fresh);
      if (s.ok && s.design) {
        try { localStorage.setItem(lastCompKey, s.design.id); } catch { /* private mode etc. */ }
        setEditorGreet(false);
        setEditorAutoRun(null);
        setDoc(s.design);
      } else flash(s.error || 'Could not create comp');
    } finally { setBusy(null); }
  };

  const duplicateComp = async (d: DesignSummary) => {
    const r = await api.getDesign(d.id);
    if (!r.ok || !r.design) return;
    const copy = JSON.parse(JSON.stringify(r.design)) as DesignDoc;
    copy.id = designId();
    copy.name = `${copy.name} copy`;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    const s = await api.saveDesign(copy);
    if (s.ok) { flash('Duplicated'); refresh(); }
  };

  // Blank comp (1:1 / 4:5 / 9:16): no reference, no base image — just a solid full-canvas
  // base shape to build on. Same shape as a Figma import doc (no role:'base' image layer),
  // which the editor already handles. Save + open immediately.
  const createBlank = async (presetId: CanvasPresetId) => {
    const preset = CANVAS_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setBusy('blank');
    try {
      const fresh = buildBlankDoc('', { w: preset.w, h: preset.h }, {
        name: `Blank ${preset.name}`,
        brand: brand ?? null,
      });
      // Clean white artboard base (was a blue-navy tint the owner disliked). role:'base' so the
      // top-strip frame-color control edits it in place.
      fresh.layers = [{
        id: layerId('base'),
        type: 'shape',
        role: 'base',
        name: 'Background',
        box: { x: 0, y: 0, w: preset.w, h: preset.h },
        style: { shapeKind: 'rect', background: '#ffffff' },
      }];
      const s = await api.saveDesign(fresh);
      if (s.ok && s.design) {
        try { localStorage.setItem(lastCompKey, s.design.id); } catch { /* private mode etc. */ }
        setEditorGreet(false);
        setEditorAutoRun(null);
        setDoc(s.design);
      } else flash(s.error || 'Could not create blank comp');
    } finally { setBusy(null); }
  };

  // ── floating action bar: bulk delete / export / rename over the current selection ──
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const deleteSelected = useCallback(async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} comp${ids.length === 1 ? '' : 's'}? This can't be undone.`)) return;
    setBarBusy(true);
    try {
      for (const id of ids) await api.deleteDesign(id);
      flash(`Deleted ${ids.length} comp${ids.length === 1 ? '' : 's'}`);
      clearSelection();
      refresh();
    } finally { setBarBusy(false); }
  }, [selected, clearSelection, refresh]);

  // Download the selection as correctly-named PNGs. Everything happens client-side:
  //   - fetch each comp's full doc (api.getDesign) and rasterize it to a full-res PNG,
  //   - name each file by the comp's real name (sanitized, deduped),
  //   - group into  Workspace / Batch / <name>.png  folders inside a single STORE-method ZIP.
  // A single selected comp downloads as a plain named .png (no zip). Comps that fail to render
  // are skipped with a note rather than corrupting the archive.
  const downloadSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setBarBusy(true);
    try {
      // Resolve each id → its summary (for naming/folders) in the current selection order.
      const picked = ids
        .map((id) => comps.find((c) => c.id === id))
        .filter((c): c is DesignSummary => !!c);

      // Folder key: Workspace (brand) / Batch (template or adType). Sanitized, empty parts dropped.
      const folderFor = (d: DesignSummary): string => {
        const ws = sanitizeName(d.brand || '', '');
        const batch = sanitizeName(d.template || d.adType || '', '');
        return [ws, batch].filter(Boolean).join('/');
      };

      // Single comp → plain named PNG, no zip.
      if (picked.length === 1) {
        const d = picked[0];
        const r = await api.getDesign(d.id);
        if (!r.ok || !r.design) { flash('Could not render comp for download'); return; }
        const png = await rasterizeDesign(r.design as unknown as DesignDoc).catch(() => null);
        if (!png) { flash('Could not render comp for download'); return; }
        triggerDownload(new Blob([dataUrlToBytes(png).buffer as ArrayBuffer], { type: 'image/png' }), `${sanitizeName(d.name, d.id)}.png`);
        flash('Downloaded 1 comp');
        return;
      }

      // Multiple → build one ZIP with a folder structure, deduping names within each folder.
      const usedByFolder = new Map<string, Set<string>>();
      const entries: { path: string; data: Uint8Array }[] = [];
      let skipped = 0;
      for (const d of picked) {
        const r = await api.getDesign(d.id);
        const png = r.ok && r.design
          ? await rasterizeDesign(r.design as unknown as DesignDoc).catch(() => null)
          : null;
        if (!png) { skipped++; continue; }
        const folder = folderFor(d);
        if (!usedByFolder.has(folder)) usedByFolder.set(folder, new Set());
        const file = uniqueInFolder(usedByFolder.get(folder)!, sanitizeName(d.name, d.id), '.png');
        entries.push({ path: folder ? `${folder}/${file}` : file, data: dataUrlToBytes(png) });
      }
      if (!entries.length) { flash('Nothing could be rendered — download skipped'); return; }
      const stamp = new Date().toISOString().slice(0, 10);
      const zipName = `${sanitizeName(allWorkspaces ? 'comps' : (brand || 'comps'), 'comps')}-${stamp}.zip`;
      triggerDownload(buildZip(entries), zipName);
      flash(`Downloaded ${entries.length} comp${entries.length === 1 ? '' : 's'}${skipped ? ` (${skipped} skipped)` : ''}`);
    } finally { setBarBusy(false); }
  };

  // Rename is only offered when exactly one comp is selected: round-trip the full doc
  // (getDesign → set .name → saveDesign), then refresh so the new name shows.
  const renameSelected = async () => {
    if (selected.size !== 1) return;
    const id = [...selected][0];
    const cur = comps.find((c) => c.id === id);
    const next = window.prompt('Rename comp', cur?.name || '');
    if (next == null) return;
    const name = next.trim();
    if (!name || name === cur?.name) return;
    setBarBusy(true);
    try {
      const r = await api.getDesign(id);
      if (!r.ok || !r.design) { flash('Could not load comp'); return; }
      const s = await api.saveDesign({ ...(r.design as DesignDoc), name, updatedAt: Date.now() });
      if (s.ok) { flash('Renamed'); refresh(); }
      else flash(s.error || 'save failed');
    } finally { setBarBusy(false); }
  };

  // Add a tag: round-trip the FULL doc (getDesign → set tags → saveDesign) — the summary row
  // alone is not a valid save payload. Thumb is omitted on save; the server keeps the existing one.
  const addTag = async (d: DesignSummary, raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    const r = await api.getDesign(d.id);
    if (!r.ok || !r.design) { flash('Could not load comp'); return; }
    const full = r.design as TaggableDoc;
    const tags = Array.from(new Set([...(full.tags || []), tag]));
    const s = await api.saveDesign({ ...full, tags, updatedAt: Date.now() } as TaggableDoc);
    if (s.ok) refresh();
    else flash(s.error || 'save failed');
  };

  const removeTag = async (d: DesignSummary, tag: string) => {
    const r = await api.getDesign(d.id);
    if (!r.ok || !r.design) return;
    const full = r.design as TaggableDoc;
    const tags = (full.tags || []).filter((t) => t !== tag);
    const s = await api.saveDesign({ ...full, tags, updatedAt: Date.now() } as TaggableDoc);
    if (s.ok) refresh();
  };

  const commitTagDraft = (d: DesignSummary) => {
    const v = tagDraft;
    setTagEditFor(null);
    setTagDraft('');
    if (v.trim()) addTag(d, v);
  };

  // Every distinct tag across the workspace's comps — the filter bar chips.
  // Hidden `set:*` membership tags (variant sets) never show as chips or match filters.
  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const d of comps) for (const t of visibleTags(d.tags)) s.add(t);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [comps]);

  const filteredComps = useMemo(() => {
    const q = query.trim().toLowerCase();
    return comps.filter((d) => {
      if (tagFilter && !visibleTags(d.tags).includes(tagFilter)) return false;
      if (!q) return true;
      if (d.name.toLowerCase().includes(q)) return true;
      return visibleTags(d.tags).some((t) => t.toLowerCase().includes(q));
    });
  }, [comps, query, tagFilter]);

  // Variant stacks: comps sharing a `set:vset_xxx` tag collapse into one stack row. Sets with a
  // single visible member render as a plain card (original gallery order preserved).
  const { stackRows, singleComps } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of filteredComps) {
      const sid = setIdOf(d.tags);
      if (sid) counts.set(sid, (counts.get(sid) || 0) + 1);
    }
    const rows: { setId: string; members: DesignSummary[] }[] = [];
    const seen = new Map<string, DesignSummary[]>();
    const singles: DesignSummary[] = [];
    for (const d of filteredComps) {
      const sid = setIdOf(d.tags);
      if (!sid || (counts.get(sid) || 0) < 2) { singles.push(d); continue; }
      let members = seen.get(sid);
      if (!members) {
        members = [];
        seen.set(sid, members);
        rows.push({ setId: sid, members });
      }
      members.push(d);
    }
    for (const r of rows) r.members.sort((a, b) => a.createdAt - b.createdAt);
    return { stackRows: rows, singleComps: singles };
  }, [filteredComps]);

  // "Make variants…": round-trip the full doc, deep-copy it n times into a fresh variant set
  // (fresh ids, shared hidden `set:` tag), save the stamped source + every copy.
  const createVariants = async (d: DesignSummary, n: number) => {
    setVariantsFor(null);
    setBusy('variants');
    try {
      const r = await api.getDesign(d.id);
      if (!r.ok || !r.design) { flash('Could not load comp'); return; }
      const { source, variants } = makeVariants(r.design as VariantDoc, n);
      const s = await api.saveDesign({ ...source, updatedAt: Date.now() });
      if (!s.ok) { flash(s.error || 'save failed'); return; }
      let saved = 0;
      for (const v of variants) {
        const sv = await api.saveDesign(v);
        if (sv.ok) saved++;
      }
      flash(`Created ${saved} variant(s)`);
      refresh();
    } finally { setBusy(null); }
  };

  // "Push to siblings…": copy the checked field groups from this variant onto every other
  // member of its set — per sibling getDesign → pushToVariants → saveDesign, with progress.
  const pushToSiblings = async () => {
    if (!pushFor) return;
    const siblings = comps.filter((c) => c.id !== pushFor.d.id && setIdOf(c.tags) === pushFor.setId);
    if (!siblings.length) { flash('No siblings in this set'); setPushFor(null); return; }
    setBusy('push');
    try {
      const src = await api.getDesign(pushFor.d.id);
      if (!src.ok || !src.design) { flash('Could not load source variant'); return; }
      let done = 0;
      let matchedTotal = 0;
      for (const sib of siblings) {
        setNote(`Pushing to siblings… ${done}/${siblings.length}`);
        const t = await api.getDesign(sib.id);
        if (!t.ok || !t.design) continue;
        const { doc: pushed, matched } = pushToVariants(src.design, t.design as VariantDoc, pushFields);
        const s = await api.saveDesign(pushed);
        if (s.ok) { done++; matchedTotal += matched; }
      }
      flash(`Pushed to ${done}/${siblings.length} sibling(s) · ${matchedTotal} node(s) matched`);
      setPushFor(null);
      refresh();
    } finally { setBusy(null); }
  };

  const applyToBatch = async () => {
    if (!applyFor) return;
    const images = batchImages.filter((i) => applyPicked.has(i.src));
    if (!images.length) return;
    setBusy('apply');
    try {
      const r = await api.applyDesignBatch(applyFor.id, images);
      // Multiple comps created from one design = a natural variant set: stamp each created doc
      // with a shared hidden set tag (fetch + save — no new server route needed).
      if (r.ok && (r.created?.length || 0) > 1) {
        const setId = variantSetId();
        let i = 0;
        for (const c of r.created || []) {
          const g = await api.getDesign(c.id);
          if (g.ok && g.design) {
            await api.saveDesign(stampVariant(g.design as VariantDoc, setId, String.fromCharCode(65 + Math.min(i, 25))));
          }
          i++;
        }
      }
      flash(r.ok ? `Created ${r.created?.length} comp(s)` : (r.error || 'failed'));
      setApplyFor(null);
      setApplyPicked(new Set());
      refresh();
    } finally { setBusy(null); }
  };

  // ── drop / paste: PNG → open editor + copy-reference agent run; Figma clipboard → direct import ──
  const fileToDataUrl = (f: File) => new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(f);
  });

  // Measure a data-URL image → natural pixel size (for canvas aspect). Falls back to 1:1.
  const measureImage = (dataUrl: string) => new Promise<{ w: number; h: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 1080, h: img.naturalHeight || 1080 });
    img.onerror = () => resolve({ w: 1080, h: 1080 });
    img.src = dataUrl;
  });

  // Drop / paste a reference PNG → create a blank comp sized to the reference's aspect ratio, open
  // the Editor, and hand it an autoRun so it kicks a "copy this reference" AGENT run at once (the
  // same /api/design/agent opts.reference path, streaming into the editor's agent feed). No
  // standalone extraction screen — the copy happens inside design mode like any other agent run.
  const startFromImageFile = useCallback(async (file: File) => {
    setBusy('upload');
    try {
      const dataUrl = await fileToDataUrl(file);
      const r = await api.uploadRef(dataUrl);
      if (!r.ok || !r.id || !r.url) { flash('Upload failed'); return; }
      // Canvas sized to the reference: cap the long edge to 1080 so we ship an ad-shaped comp.
      const { w, h } = await measureImage(dataUrl);
      const scale = 1080 / Math.max(w, h);
      const canvas = { w: Math.round(w * scale), h: Math.round(h * scale) };
      const fresh = buildBlankDoc('color:#ffffff', canvas, {
        name: 'Copy of reference',
        brand: brand ?? null,
        reference: { kind: 'upload', ref: r.id, url: r.url, label: file.name || 'Dropped reference' },
      });
      const s = await api.saveDesign(fresh);
      if (!s.ok || !s.design) { flash(s.error || 'Could not create comp'); return; }
      try { localStorage.setItem(lastCompKey, s.design.id); } catch { /* private mode etc. */ }
      setEditorGreet(false);
      setEditorAutoRun({ reference: { ref: r.id, label: file.name || 'Dropped reference' } });
      setDoc(s.design);
    } finally { setBusy(null); }
  }, [brand, lastCompKey]);

  const importFromFigma = useCallback(async (html: string) => {
    setBusy('figma');
    try {
      const r = await parseFigmaClipboard(html);
      if (!r.ok || !r.nodes) { flash(r.error || 'Could not read the Figma clipboard'); return; }
      const urls = await uploadFigmaImages(r.images || [], async (dataUrl) => {
        const u = await api.uploadRef(dataUrl);
        return { url: u.url || '' };
      });
      applyFigmaImageUrls(r.nodes, urls);
      const now = Date.now();
      const fresh: DesignDoc = {
        id: designId(),
        name: r.name || 'From Figma',
        canvas: r.canvas || { w: 1080, h: 1080 },
        layers: r.nodes,
        brand: brand ?? null,
        reference: null,
        link: null,
        skeletonId: null,
        source: { kind: 'figma', ref: 'clipboard' },
        createdAt: now,
        updatedAt: now,
        schemaVersion: 3,
      };
      const s = await api.saveDesign(fresh);
      if (s.ok && s.design) { flash('Imported from Figma'); setDoc(s.design); }
      else flash(s.error || 'save failed');
    } finally { setBusy(null); }
  }, [brand]);

  useEffect(() => {
    if (doc) return; // in the editor, paste is handled there (a reference to copy)
    const onPaste = (e: ClipboardEvent) => {
      const html = e.clipboardData?.getData('text/html') || null;
      if (html && sniffFigmaClipboard(html)) { e.preventDefault(); importFromFigma(html); return; }
      const file = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
      if (file) { e.preventDefault(); startFromImageFile(file); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [doc, importFromFigma, startFromImageFile]);

  // Keyboard over the selection (matches Finder): Escape clears; Delete/Backspace deletes (with the
  // same confirm the bar uses). Both are ignored while typing in a field so the search/tag inputs
  // keep normal editing. ⌘/Ctrl-A selects every visible comp when the gallery isn't focused on an
  // input. Bound whenever the gallery is showing so Select-all works before anything is selected.
  const filteredIdsRef = useRef<string[]>([]);
  filteredIdsRef.current = filteredComps.map((d) => d.id);
  // Skeleton ids for ⌘/Ctrl-A parity — refs so the key handler stays a stable one-time binding.
  const skelIdsRef = useRef<string[]>([]);
  skelIdsRef.current = skeletons.map((s) => s.id);
  const skelOpenRef = useRef(false);
  skelOpenRef.current = skelOpen;
  useEffect(() => {
    const typingIn = (el: EventTarget | null) => {
      const n = el as HTMLElement | null;
      if (!n) return false;
      const tag = n.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || n.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (typingIn(e.target)) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        // Context-aware select-all: if a copied-layout selection is the active one (or the
        // skeleton grid is the only thing selectable), ⌘/Ctrl-A fills that grid; otherwise it
        // selects every comp. Comps are the primary grid, so they win when nothing's selected.
        const skelActive = selectedSkels.size > 0 && !selected.size;
        if (skelActive) {
          const ids = skelIdsRef.current;
          if (ids.length) { e.preventDefault(); setSelectedSkels(new Set(ids)); }
          return;
        }
        const ids = filteredIdsRef.current;
        if (ids.length) { e.preventDefault(); setSelected(new Set(ids)); }
        return;
      }
      if (selectedSkels.size) {
        if (e.key === 'Escape') { clearSkelSelection(); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); void deleteSelectedSkels(); return; }
      }
      if (!selected.size) return;
      if (e.key === 'Escape') { clearSelection(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); void deleteSelected(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.size, clearSelection, deleteSelected, selectedSkels.size, clearSkelSelection, deleteSelectedSkels]);

  // ── rubber-band marquee ──────────────────────────────────────────────────
  // Pointer-down on EMPTY gallery space starts a drag. Drags that begin on a card / button /
  // input / menu are ignored (those are clicks / opens). We move past a ~4px threshold before it
  // counts as a drag, then on every move recompute the client-coord rect and select every card
  // ([data-card-id]) whose getBoundingClientRect intersects it. A modifier (⌘/Ctrl/Shift) adds to
  // the existing selection; a plain drag replaces it. Suppresses the trailing click so the card
  // under pointer-up doesn't also open.
  const onGalleryPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Ignore drags that originate on interactive elements or inside a card.
    if (target.closest('[data-card-id],button,a,input,textarea,select,[role="menu"]')) return;

    const container = galleryRef.current;
    if (!container) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const additive = e.metaKey || e.ctrlKey || e.shiftKey;
    const base = additive ? new Set(selected) : new Set<string>();
    let dragging = false;

    const cards = () => Array.from(container.querySelectorAll<HTMLElement>('[data-card-id]'));

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // below threshold → still a click
      dragging = true;
      const rect = {
        x: Math.min(startX, ev.clientX),
        y: Math.min(startY, ev.clientY),
        w: Math.abs(dx),
        h: Math.abs(dy),
      };
      setMarquee(rect);
      const next = new Set(base);
      for (const el of cards()) {
        const r = el.getBoundingClientRect();
        const hit = r.left < rect.x + rect.w && r.right > rect.x && r.top < rect.y + rect.h && r.bottom > rect.y;
        const id = el.dataset.cardId;
        if (id && hit) next.add(id);
      }
      setSelected(next);
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setMarquee(null);
      if (dragging) {
        // Swallow the click that fires after a real drag so pointer-up over empty space doesn't
        // clear, and over a card doesn't open.
        const swallow = (ce: MouseEvent) => { ce.stopPropagation(); ce.preventDefault(); };
        window.addEventListener('click', swallow, { capture: true, once: true });
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [selected]);

  // A plain click on empty gallery space (no drag) clears the selection.
  const onGalleryClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-card-id],button,a,input,textarea,select,[role="menu"]')) return;
    if (selected.size) clearSelection();
  }, [selected.size, clearSelection]);

  // Same rubber-band marquee as the comps grid, retargeted at the skeleton cards
  // ([data-skel-id]) and the separate selectedSkels Set.
  const onSkelGridPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-skel-id],button,a,input,textarea,select,[role="menu"]')) return;

    const container = skelGridRef.current;
    if (!container) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const additive = e.metaKey || e.ctrlKey || e.shiftKey;
    const base = additive ? new Set(selectedSkels) : new Set<string>();
    let dragging = false;

    const cards = () => Array.from(container.querySelectorAll<HTMLElement>('[data-skel-id]'));

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      dragging = true;
      const rect = {
        x: Math.min(startX, ev.clientX),
        y: Math.min(startY, ev.clientY),
        w: Math.abs(dx),
        h: Math.abs(dy),
      };
      setSkelMarquee(rect);
      const next = new Set(base);
      for (const el of cards()) {
        const r = el.getBoundingClientRect();
        const hit = r.left < rect.x + rect.w && r.right > rect.x && r.top < rect.y + rect.h && r.bottom > rect.y;
        const id = el.dataset.skelId;
        if (id && hit) next.add(id);
      }
      setSelectedSkels(next);
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setSkelMarquee(null);
      if (dragging) {
        const swallow = (ce: MouseEvent) => { ce.stopPropagation(); ce.preventDefault(); };
        window.addEventListener('click', swallow, { capture: true, once: true });
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [selectedSkels]);

  const onSkelGridClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-skel-id],button,a,input,textarea,select,[role="menu"]')) return;
    if (selectedSkels.size) clearSkelSelection();
  }, [selectedSkels.size, clearSkelSelection]);

  if (doc) {
    return (
      <Editor
        initialDoc={doc}
        greet={editorGreet}
        autoRun={editorAutoRun}
        onClose={() => {
          try { localStorage.removeItem(lastCompKey); } catch { /* ignore */ }
          setEditorGreet(false);
          setEditorAutoRun(null);
          setDoc(null);
          refresh();
        }}
      />
    );
  }

  return (
    <div
      className={styles.view}
      data-drop={dropActive || undefined}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) {
          e.preventDefault();
          setDropActive(true);
        }
      }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropActive(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDropActive(false);
        const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
        if (file) startFromImageFile(file);
      }}
    >
      {/* Hero strip — the funnel: New comp (split: reference / blank sizes), the drop/paste
          zone as a subtle inline affordance, search + agent chip on the same line. */}
      <div className={styles.hero}>
        <div className={styles.newSplit}>
          <button type="button" className={styles.newBtn} onClick={() => void newComp()}>
            <Icon name="plus" size={14} /> New comp
          </button>
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button type="button" className={styles.newBtnMore} aria-label="More ways to start a comp">
                <Icon name="chevron-down" size={13} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className={styles.menu} align="start" sideOffset={4} collisionPadding={8}>
                {/* New comp opens the editor and greets with attach-a-reference; these jump
                    straight to a blank canvas at a chosen size, skipping the greeting. */}
                {CANVAS_PRESETS.map((p) => (
                  <DropdownMenu.Item key={p.id} className={styles.menuItem} onSelect={() => createBlank(p.id)}>
                    <span className={styles.menuIcon}><Icon name="shape-square" size={13} /></span>
                    Blank {p.name}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        <span className={styles.dropZone}>
          <Icon name="photo" size={13} />
          Drop / paste a reference — it opens in the editor and the agent copies it
        </span>
        <div className={styles.heroRight}>
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search comps by name or tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className={styles.tagChip} data-active={allWorkspaces || undefined}
            title="Show comps from every workspace" onClick={() => setAllWorkspaces((v) => !v)}>
            All workspaces
          </button>
          {/* Read-only model indicator — no switching UI (the owner wants Ornith as the single
              default for everything; the backend routes to whatever LM Studio has loaded). */}
          <span className={styles.agentChip} title="Design-agent model">Agent: {currentModelLabel}</span>
        </div>
      </div>

      {(allTags.length > 0 || tagFilter) ? (
        <div className={styles.filterRow}>
          {allTags.map((t) => (
            <button
              key={t}
              type="button"
              className={styles.tagChip}
              data-active={tagFilter === t || undefined}
              onClick={() => setTagFilter((cur) => (cur === t ? null : t))}
            >
              {t}
            </button>
          ))}
          {tagFilter ? (
            <button type="button" className={styles.clearFilter} onClick={() => setTagFilter(null)}>
              clear <Icon name="x" size={10} />
            </button>
          ) : null}
        </div>
      ) : null}

      <section
        ref={galleryRef}
        className={styles.section}
        onPointerDown={onGalleryPointerDown}
        onClick={onGalleryClick}
      >
        <div className={styles.sectionHead}>
          <p className="eyebrow">Sets &amp; comps</p>
          {comps.length > 0 ? <span className={styles.sectionCount}>{filteredComps.length}</span> : null}
          {selected.size > 0 ? (
            <span className={styles.sectionCount} data-selcount title="Selected — click a card's checkbox to add/remove, drag to marquee-select, Del to delete, Esc to clear">
              · {selected.size} selected
            </span>
          ) : null}
          {filteredComps.length > 0 && selected.size < filteredComps.length ? (
            <button type="button" className={styles.selectAll}
              title="Select all comps (⌘/Ctrl-A)"
              onClick={() => setSelected(new Set(filteredComps.map((d) => d.id)))}>
              Select all
            </button>
          ) : null}
        </div>
        {comps.length === 0 ? (
          <EmptyState
            icon="palette"
            title="No comps yet"
            hint="New comp opens the editor — attach a reference and the agent copies its layout, or start from a blank canvas. Or drop a reference here."
            action={{ label: 'New comp', onClick: () => void newComp() }}
          />
        ) : filteredComps.length === 0 ? (
          <EmptyState
            icon="search"
            title="No matches"
            hint="No comps match the current search / tag filter."
            action={{ label: 'Clear search & filters', icon: 'x', onClick: () => { setQuery(''); setTagFilter(null); } }}
          />
        ) : (
          <>
            {stackRows.map(({ setId, members }) => {
              const memberIds = members.map((m) => m.id);
              const selCount = memberIds.filter((id) => selected.has(id)).length;
              const allOn = selCount === memberIds.length;
              return (
              <div key={setId} className={styles.stackRow} data-selected={allOn || undefined}>
                <div className={styles.stackHead}>
                  {/* Set-level checkbox: selecting a set selects every member (parity — a set is
                      as selectable as a single comp). On = all members selected. */}
                  <button
                    type="button"
                    className={`${styles.selBox} ${styles.selBoxSet}`}
                    data-on={allOn || undefined}
                    data-partial={(selCount > 0 && !allOn) || undefined}
                    aria-label={allOn ? 'Deselect set' : 'Select set'}
                    aria-pressed={allOn}
                    title={allOn ? 'Deselect all in set' : 'Select all in set'}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleSelectedSet(memberIds); }}
                  >
                    {allOn ? <Icon name="check" size={11} /> : (selCount > 0 ? <Icon name="minus" size={11} /> : null)}
                  </button>
                  <span className={styles.stackHeadLabel}>
                    {members[0].name.replace(/\s+·\s+[A-Z]$/, '')} · {members.length} variants
                    {selCount > 0 ? <span className={styles.stackSelCount}> · {selCount} selected</span> : null}
                  </span>
                </div>
                <div className={styles.stackCards}>
                  {members.map((d, i) => (
                    <div key={d.id} className={styles.stackCard} data-card-id={d.id}
                      data-selected={selected.has(d.id) || undefined}>
                      <button type="button" className={styles.stackThumb} title={d.name}
                        onClick={(e) => onCardClick(e, d.id)}>
                        <CompThumbImg d={d} />
                        <span className={styles.stackLetter}>{String.fromCharCode(65 + Math.min(i, 25))}</span>
                      </button>
                      <button
                        type="button"
                        className={`${styles.selBox} ${styles.selBoxSm}`}
                        data-on={selected.has(d.id) || undefined}
                        aria-label={selected.has(d.id) ? 'Deselect comp' : 'Select comp'}
                        aria-pressed={selected.has(d.id)}
                        title={selected.has(d.id) ? 'Deselect' : 'Select'}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleSelected(d.id); }}
                      >
                        {selected.has(d.id) ? <Icon name="check" size={10} /> : null}
                      </button>
                      <CardMenu
                        onOpen={() => openComp(d.id)}
                        onDuplicate={() => duplicateComp(d)}
                        onVariants={() => setVariantsFor(d)}
                        onPush={() => setPushFor({ d, setId })}
                        onApply={() => setApplyFor(d)}
                      />
                    </div>
                  ))}
                </div>
              </div>
              );
            })}
            <div className={styles.compGrid}>
              {singleComps.map((d) => (
                <div key={d.id} className={styles.compCard} data-card-id={d.id}
                  data-selected={selected.has(d.id) || undefined}>
                  <button type="button" className={styles.compThumb}
                    onClick={(e) => onCardClick(e, d.id)}>
                    <CompThumbImg d={d} withRatio />
                  </button>
                  <button
                    type="button"
                    className={styles.selBox}
                    data-on={selected.has(d.id) || undefined}
                    aria-label={selected.has(d.id) ? 'Deselect comp' : 'Select comp'}
                    aria-pressed={selected.has(d.id)}
                    title={selected.has(d.id) ? 'Deselect' : 'Select'}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleSelected(d.id); }}
                  >
                    {selected.has(d.id) ? <Icon name="check" size={12} /> : null}
                  </button>
                  <CardMenu
                    onOpen={() => openComp(d.id)}
                    onDuplicate={() => duplicateComp(d)}
                    onVariants={() => setVariantsFor(d)}
                    onApply={() => setApplyFor(d)}
                    onAddTag={() => { setTagEditFor(d.id); setTagDraft(''); }}
                  />
                  <div className={styles.compBody}>
                    <div className={styles.cardFoot}>
                      <button type="button" className={styles.compName} title={d.name} onClick={(e) => onCardClick(e, d.id)}>{d.name}</button>
                      <span className={styles.compMeta}>{d.layers} layers</span>
                      {d.updatedAt ? <span className={styles.compTime}>{relTime(d.updatedAt)}</span> : null}
                    </div>
                    {(visibleTags(d.tags).length > 0 || tagEditFor === d.id) ? (
                      <div className={styles.tagRow}>
                        {visibleTags(d.tags).slice(0, 3).map((t) => (
                          <button
                            key={t}
                            type="button"
                            className={styles.tagChip}
                            data-active={tagFilter === t || undefined}
                            title={`Filter by “${t}” (double-click to remove the tag)`}
                            onClick={() => setTagFilter((cur) => (cur === t ? null : t))}
                            onDoubleClick={() => removeTag(d, t)}
                          >
                            {t}
                          </button>
                        ))}
                        {visibleTags(d.tags).length > 3 ? (
                          <span className={styles.tagMore}>+{visibleTags(d.tags).length - 3}</span>
                        ) : null}
                        {tagEditFor === d.id ? (
                          <input
                            className={styles.tagInput}
                            autoFocus
                            value={tagDraft}
                            placeholder="tag…"
                            onChange={(e) => setTagDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitTagDraft(d);
                              if (e.key === 'Escape') { setTagEditFor(null); setTagDraft(''); }
                            }}
                            onBlur={() => commitTagDraft(d)}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {skeletons.length > 0 ? (
        <section className={styles.section}>
          {/* Copied-layouts head — same rhythm as the comps head: disclosure toggle, count,
              live selected-count, and a Select-all (only meaningful once the grid is open). */}
          <div className={styles.sectionHead}>
            <button
              type="button"
              className={styles.disclosure}
              aria-expanded={skelOpen}
              onClick={() => setSkelOpen((o) => !o)}
            >
              <span className={styles.discChevron} data-open={skelOpen || undefined}>
                <Icon name="chevron-right" size={12} />
              </span>
              <span className="eyebrow">Copied layouts</span>
              <span className={styles.sectionCount}>{skeletons.length}</span>
            </button>
            {selectedSkels.size > 0 ? (
              <span className={styles.sectionCount} data-selcount
                title="Selected — click a card's checkbox to add/remove, drag to marquee-select, Del to delete, Esc to clear">
                · {selectedSkels.size} selected
              </span>
            ) : null}
            {skelOpen && skeletons.length > 0 && selectedSkels.size < skeletons.length ? (
              <button type="button" className={styles.selectAll}
                title="Select all copied layouts (⌘/Ctrl-A)"
                onClick={() => setSelectedSkels(new Set(skeletons.map((s) => s.id)))}>
                Select all
              </button>
            ) : null}
          </div>
          {skelOpen ? (
            <div
              ref={skelGridRef}
              className={styles.skelGrid}
              onPointerDown={onSkelGridPointerDown}
              onClick={onSkelGridClick}
            >
              {skeletons.map((s) => (
                <div key={s.id} className={styles.skelCardWrap} data-skel-id={s.id}
                  data-selected={selectedSkels.has(s.id) || undefined}>
                  <button type="button" className={styles.skelCard}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey) { e.preventDefault(); toggleSelectedSkel(s.id); return; }
                      startFromSkeleton(s.id);
                    }}>
                    {s.sourceRef?.url ? <img src={s.sourceRef.url} alt="" loading="lazy" decoding="async" /> : null}
                    <span className={styles.skelBody}>
                      <span className={styles.skelName}>{s.name}</span>
                      <span className={styles.skelMeta}>{s.layerCount} layers · {s.extractedBy}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.selBox} ${styles.selBoxSm}`}
                    data-on={selectedSkels.has(s.id) || undefined}
                    aria-label={selectedSkels.has(s.id) ? 'Deselect copied layout' : 'Select copied layout'}
                    aria-pressed={selectedSkels.has(s.id)}
                    title={selectedSkels.has(s.id) ? 'Deselect' : 'Select'}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleSelectedSkel(s.id); }}
                  >
                    {selectedSkels.has(s.id) ? <Icon name="check" size={10} /> : null}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Rubber-band marquee rectangle. Drawn inside a fixed overlay whose own viewport offset is
          subtracted (marqueeStyle) so the rect lands exactly under the cursor even though an
          ancestor (<main>'s backdrop-filter) establishes the containing block for fixed elements.
          The overlay stays mounted so its rect is measurable the instant a drag begins. */}
      <div ref={overlayRef} className={styles.marqueeLayer} aria-hidden>
        {marquee ? <div className={styles.marquee} style={marqueeStyle(marquee)} /> : null}
        {skelMarquee ? <div className={styles.marquee} style={marqueeStyle(skelMarquee)} /> : null}
      </div>

      {/* Floating selection bar for "Copied layouts" — same pattern as the comps bar, kept
          separate so it never mixes with a concurrent comp selection. */}
      {selectedSkels.size > 0 ? (
        <div className={styles.selBar} role="toolbar" aria-label="Copied layout selection actions">
          <span className={styles.selBarCount}>{selectedSkels.size} selected</span>
          <span className={styles.selBarDiv} aria-hidden />
          <button type="button" className={`${styles.selBarBtn} ${styles.selBarDanger}`} onClick={deleteSelectedSkels} disabled={skelBarBusy}>
            <Icon name="x" size={13} /> Delete {selectedSkels.size}
          </button>
          <span className={styles.selBarDiv} aria-hidden />
          <button type="button" className={styles.selBarClose} onClick={clearSkelSelection} aria-label="Clear selection" title="Clear selection (Esc)">
            <Icon name="x" size={13} />
          </button>
        </div>
      ) : null}

      {/* Floating selection bar — appears whenever ≥1 comp is selected. */}
      {selected.size > 0 ? (
        <div className={styles.selBar} role="toolbar" aria-label="Selection actions">
          <span className={styles.selBarCount}>{selected.size} selected</span>
          <span className={styles.selBarDiv} aria-hidden />
          <button type="button" className={styles.selBarBtn} onClick={renameSelected}
            disabled={selected.size !== 1 || barBusy} title={selected.size === 1 ? 'Rename this comp' : 'Select exactly one to rename'}>
            <Icon name="pencil" size={13} /> Rename
          </button>
          <button type="button" className={styles.selBarBtn} onClick={downloadSelected} disabled={barBusy}
            title={selected.size === 1 ? 'Download this comp as a named PNG' : `Download ${selected.size} comps as a named ZIP (grouped by workspace/batch)`}>
            <Icon name="download" size={13} /> Download {selected.size}
          </button>
          <button type="button" className={`${styles.selBarBtn} ${styles.selBarDanger}`} onClick={deleteSelected} disabled={barBusy}>
            <Icon name="x" size={13} /> Delete {selected.size}
          </button>
          <span className={styles.selBarDiv} aria-hidden />
          <button type="button" className={styles.selBarClose} onClick={clearSelection} aria-label="Clear selection" title="Clear selection (Esc)">
            <Icon name="x" size={13} />
          </button>
        </div>
      ) : null}

      {note ? <div className={styles.note}>{note}</div> : null}
      {busy === 'upload' || busy === 'figma' ? <div className={styles.note}>{busy === 'figma' ? 'Importing from Figma…' : 'Uploading…'}</div> : null}

      {applyFor ? (
        <div className={styles.modalScrim} onClick={() => setApplyFor(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <p className={styles.modalTitle}>Apply “{applyFor.name}” to images</p>
            <div className={styles.applyGrid}>
              {batchImages.map((img) => (
                <button
                  key={img.src} type="button" className={styles.applyCell}
                  data-picked={applyPicked.has(img.src) || undefined}
                  onClick={() => setApplyPicked((p) => { const n = new Set(p); if (n.has(img.src)) n.delete(img.src); else n.add(img.src); return n; })}
                >
                  <img src={img.src} alt="" loading="lazy" decoding="async" />
                  <span>{img.label}</span>
                </button>
              ))}
            </div>
            <div className={styles.modalActions}>
              <button type="button" className={styles.cardBtn} onClick={() => setApplyFor(null)}>Cancel</button>
              <button type="button" className={styles.newBtn} onClick={applyToBatch} disabled={applyPicked.size === 0 || busy !== null}>
                {busy === 'apply' ? 'Creating…' : `Create ${applyPicked.size} comp(s)`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {variantsFor ? (
        <div className={styles.modalScrim} onClick={() => setVariantsFor(null)}>
          <div className={`${styles.modal} ${styles.modalSm}`} onClick={(e) => e.stopPropagation()}>
            <p className={styles.modalTitle}>Make variants of “{variantsFor.name}”</p>
            <p className={styles.modalHint}>How many copies? They stack together in the gallery and can push changes to each other.</p>
            <div className={styles.countRow}>
              {[2, 3, 4, 5, 6].map((n) => (
                <button
                  key={n} type="button" className={styles.countBtn}
                  disabled={busy !== null}
                  onClick={() => createVariants(variantsFor, n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className={styles.modalActions}>
              <button type="button" className={styles.cardBtn} onClick={() => setVariantsFor(null)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}

      {pushFor ? (
        <div className={styles.modalScrim} onClick={() => setPushFor(null)}>
          <div className={`${styles.modal} ${styles.modalSm}`} onClick={(e) => e.stopPropagation()}>
            <p className={styles.modalTitle}>Push “{pushFor.d.name}” to siblings</p>
            <p className={styles.modalHint}>Copies the checked field groups onto every other variant in this set. Nodes are matched by element, role, name, then position — unmatched nodes stay untouched.</p>
            <div className={styles.checkCol}>
              {([
                ['layout', 'Layout', 'position, size, rotation (scaled across canvas sizes)'],
                ['styles', 'Styles', 'colors, fonts, fills, effects'],
                ['text', 'Text', 'copy on text / badge / button layers'],
                ['images', 'Images', 'image sources + fit (base image stays)'],
              ] as const).map(([key, label, hint]) => (
                <label key={key} className={styles.checkRow}>
                  <input
                    type="checkbox"
                    checked={!!pushFields[key]}
                    onChange={(e) => setPushFields((f) => ({ ...f, [key]: e.target.checked }))}
                  />
                  <span>{label}</span>
                  <span className={styles.checkHint}>{hint}</span>
                </label>
              ))}
            </div>
            <div className={styles.modalActions}>
              <button type="button" className={styles.cardBtn} onClick={() => setPushFor(null)}>Cancel</button>
              <button
                type="button" className={styles.newBtn} onClick={pushToSiblings}
                disabled={busy !== null || !Object.values(pushFields).some(Boolean)}
              >
                {busy === 'push' ? 'Pushing…' : 'Push to siblings'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
