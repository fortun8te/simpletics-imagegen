// Editor.tsx — the design editor shell: document state, undo/redo history, keyboard,
// left panel (layers TREE + elements), the Stage (canvas — see Stage.tsx), and the right
// inspector (Figma-style sections: Position / Typography / Fill / Effects, plus brief link
// and the design agent).
//
// v3 shell: multi-select (selectedIds), entered-group drill stack, ⌘G/⌘⇧G, autoH re-measure +
// normalizeGroups on EVERY commit, continuous zoom, X-ray anatomy view. Document actions are
// deliberately minimal: Copy to Figma (primary) + PNG — everything else lives in the gallery.
//
// History protocol: every discrete edit goes through commit() (snapshot → past). The Stage and
// the scrub inputs stream frames with commit=false and finish with commit=true — the shell
// snapshots once at the first streamed frame so a whole gesture is ONE undo step.
//
// ── LIVE-SYNC PROTOCOL (Figma-style cross-tab sync) ──────────────────────────────────────────
// Two channels, one EventSource ('/events'):
//
//  1. EPHEMERAL ('live') — mid-gesture frames, sub-100ms end to end, never touch disk:
//     • SEND: every local mutation (stream frame OR commit) diffs the previous doc against the
//       next one for changed node boxes/rotation and POSTs them to /api/design/live as
//       { id, origin: TAB_ORIGIN, nodes:[{id, box, rotation?}] }, throttled to ~1 frame / 50ms
//       (frames within the window coalesce into one pending map, latest box per node wins).
//       TAB_ORIGIN is a per-tab uuid so a tab never applies its own echoes.
//     • RECEIVE: SSE 'live' events for THIS doc id with origin ≠ mine patch the matching nodes'
//       box/rotation directly into the current doc (normalizeGroups after) — NO history entry,
//       NO dirty flag. Application is rAF-capped; events older than the doc's updatedAt are
//       dropped. While the local user is mid-gesture (dragSnapshot active) remote patches buffer
//       and apply once the gesture commits, so two cursors never fight over one frame.
//
//  2. COMMIT ('doc') — the existing truth channel: every action autosaves ~250ms after its
//     commit (thumbnail raster still throttled to ≥5s), the server broadcasts 'doc', and other
//     tabs silently reload when clean (or show the "updated in another tab" chip when dirty).
//     'live' frames are cosmetic previews; 'doc' reloads always win.
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useStore } from '../../store';
import { api } from '../../api';
import { Icon } from '../Icon';
import Stage, { type UnderlayState } from './Stage';
import AgentPanel from './AgentPanel';
import BrandKitPanel from './BrandKitPanel';
import { WorkingIndicator } from '../WorkingIndicator';
import { ELEMENTS, ELEMENT_CATEGORIES, buildElement, findElementInstance, type ElementDef, type ParamSpec, type ParamValue } from './elements';
import PresetPicker from './PresetPicker';
import * as elementLibRaw from '../../../lib/elements.mjs';
import { rasterizeDesign } from './raster';
import { copyForFigma } from './figmaClipboard';
import { remeasureAutoHeights } from './textMetrics';
import {
  isGroup, layerId, resolveGradient, skeletonFromDoc, validateDesign,
  type DesignDoc, type GradientFill, type GroupNode, type Layer, type LayerStyle, type SceneNode,
} from '../../lib/sceneGraph';
import {
  findNode, findParentGroup, findParentList, groupNodes, leaves, normalizeGroups,
  reparentNode, scaleNodeInto, ungroupNode, walk,
} from '../../lib/sceneTree';
import { listLocalFonts } from '../../lib/fonts';
import type { SavedElement, Slot } from '../../types';
import styles from './Editor.module.css';

const HISTORY_CAP = 60;

// Per-tab identity for the live-sync channel — a tab must never apply its own echoed frames.
const TAB_ORIGIN: string = (() => {
  try { return crypto.randomUUID(); } catch { return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
})();

/** One live-sync node patch: absolute box (+ rotation) keyed by node id. */
interface LiveNode { id: string; box: { x: number; y: number; w: number; h: number }; rotation?: number }

/** Diff two docs for changed node boxes/rotation — the live-sync payload (≤200 nodes, cheap). */
function collectLiveDiff(prev: DesignDoc, next: DesignDoc): LiveNode[] {
  const prevById = new Map<string, SceneNode>();
  walk(prev.layers, (n) => { prevById.set(n.id, n); });
  const changed: LiveNode[] = [];
  walk(next.layers, (n) => {
    const p = prevById.get(n.id);
    if (!p) return;
    const b = n.box;
    const pb = p.box;
    const rot = (n as { rotation?: number }).rotation || 0;
    const prot = (p as { rotation?: number }).rotation || 0;
    if (b.x !== pb.x || b.y !== pb.y || b.w !== pb.w || b.h !== pb.h || rot !== prot) {
      changed.push({ id: n.id, box: { x: b.x, y: b.y, w: b.w, h: b.h }, ...(rot ? { rotation: rot } : {}) });
    }
  });
  return changed;
}

type UnderlayMode = 'off' | 'over' | 'side';

// ── concept-level element catalog ──
// The library consolidates variants into one canonical parametric def each (aliases like
// ig-caption-light resolve inside buildElement). The picker must show CONCEPTS only: hide any
// id that is an alias key (defensive — ELEMENT_ALIASES may not be exported everywhere) and
// dedupe defs that share an id.
const ELEMENT_ALIAS_IDS: Set<string> = new Set(Object.keys(
  (elementLibRaw as unknown as { ELEMENT_ALIASES?: Record<string, unknown> }).ELEMENT_ALIASES ?? {},
));
const CANONICAL_ELEMENTS: ElementDef[] = (() => {
  const seen = new Set<string>();
  return ELEMENTS.filter((el) => {
    if (ELEMENT_ALIAS_IDS.has(el.id)) return false; // consolidated variant → not a row
    if (seen.has(el.id)) return false;              // duplicate def → first wins
    seen.add(el.id);
    return true;
  });
})();

interface EditorProps {
  initialDoc: DesignDoc;
  onClose: () => void;
}

/** Done render images of the current batch — the batch-apply targets (used by gallery too). */
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

// ── scrub-able number input (Figma-style: drag the label to scrub, type to set) ──
function NumInput({
  label, value, step = 1, min, max, auto,
  onLive, onDone,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  /** render "Auto" instead of the number (autoH height) */
  auto?: boolean;
  onLive: (v: number) => void;
  onDone: (v: number) => void;
}) {
  const [text, setText] = useState<string | null>(null); // non-null while editing
  const scrub = useRef<{ startX: number; startV: number; moved: boolean; last: number } | null>(null);
  // blur fires after Enter/Escape's own handling — this flag stops it from double-committing
  // (or re-committing a value Escape just reverted).
  const settled = useRef(false);
  const clampV = (v: number) => Math.max(min ?? -Infinity, Math.min(max ?? Infinity, v));
  const parse = (t: string | null) => (t !== null && t.trim() !== '' && !Number.isNaN(Number(t)) ? clampV(Number(t)) : null);

  const onLabelDown = (e: ReactPointerEvent) => {
    if (auto) return;
    scrub.current = { startX: e.clientX, startV: value, moved: false, last: value };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onLabelMove = (e: ReactPointerEvent) => {
    const s = scrub.current;
    if (!s) return;
    const dx = e.clientX - s.startX;
    if (!s.moved && Math.abs(dx) < 3) return;
    s.moved = true;
    s.last = clampV(Math.round((s.startV + dx * step) / step) * step);
    onLive(s.last);
  };
  const onLabelUp = () => {
    const s = scrub.current;
    scrub.current = null;
    // commit the last LIVE value we sent — the `value` prop can lag a frame behind
    if (s?.moved) onDone(clampV(s.last));
  };

  // Commit is deterministic: typing previews live (Figma-style), Enter commits DIRECTLY (never
  // relies on blur firing), Escape reverts, blur commits whatever is still previewed.
  const commitText = (t: string | null) => {
    const v = parse(t);
    if (v !== null && v !== value) onDone(v);
    setText(null);
  };

  return (
    <label className={styles.numField}>
      <span
        className={styles.scrubLabel}
        onPointerDown={onLabelDown}
        onPointerMove={onLabelMove}
        onPointerUp={onLabelUp}
      >
        {label}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={text ?? (auto ? 'Auto' : String(value))}
        onFocus={(e) => { settled.current = false; setText(auto ? '' : String(value)); e.target.select(); }}
        onChange={(e) => {
          setText(e.target.value);
          const v = parse(e.target.value);
          if (v !== null) onLive(v); // live preview as you type
        }}
        onBlur={() => { if (!settled.current) commitText(text); settled.current = false; }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            settled.current = true; // blur must not commit again
            commitText((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') {
            settled.current = true; // blur must not commit the reverted preview
            setText(null);
            onLive(value);
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
      />
    </label>
  );
}

/** Auto-generated form for a parametric element instance — edits rebuild it in place. */
function ParamForm({ def, params, brandColors, onChange }: {
  def: ElementDef;
  params: Record<string, ParamValue>;
  brandColors: string[];
  onChange: (patch: Record<string, ParamValue>) => void;
}) {
  return (
    <div className={styles.paramForm}>
      {def.params.map((spec: ParamSpec) => {
        const val = params[spec.key] ?? spec.default;
        const set = (v: ParamValue) => onChange({ [spec.key]: v });
        if (spec.type === 'boolean') {
          return (
            <button key={spec.key} type="button" className={styles.pillToggle}
              data-active={!!val || undefined} onClick={() => set(!val)}>
              {spec.label || spec.key}
            </button>
          );
        }
        if (spec.type === 'enum') {
          return (
            <div key={spec.key} className={styles.alignRow}>
              {(spec.options || []).map((o) => (
                <button key={o} type="button" className={styles.alignBtn}
                  data-active={val === o || undefined} onClick={() => set(o)}>{o}</button>
              ))}
            </div>
          );
        }
        if (spec.type === 'number') {
          // committed on blur/Enter (each commit is one undo step + a full element rebuild)
          return (
            <label key={spec.key} className={styles.paramRow}>
              <span>{spec.label || spec.key}</span>
              <input type="number" defaultValue={Number(val) || 0} min={spec.min} max={spec.max}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                onBlur={(e) => {
                  const n = Math.max(spec.min ?? -Infinity, Math.min(spec.max ?? Infinity, Number(e.target.value) || 0));
                  if (n !== (Number(val) || 0)) set(n);
                }} />
            </label>
          );
        }
        if (spec.type === 'color') {
          return (
            <label key={spec.key} className={styles.paramRow}>
              <span>{spec.label || spec.key}</span>
              <span className={styles.paramColorWrap}>
                {brandColors.slice(0, 5).map((c) => (
                  <button key={c} type="button" className={styles.swatch} style={{ background: c }} onClick={() => set(c)} />
                ))}
                <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(String(val)) ? String(val) : '#000000'}
                  onChange={(e) => set(e.target.value)} />
              </span>
            </label>
          );
        }
        if (spec.type === 'stringList') {
          const joined = Array.isArray(val) ? (val as string[]).join('\n') : String(val);
          return (
            <label key={spec.key} className={styles.paramRowCol}>
              <span>{spec.label || spec.key} (one per line)</span>
              <textarea rows={3} spellCheck={false} defaultValue={joined}
                onKeyDown={(e) => e.stopPropagation()}
                onBlur={(e) => { if (e.target.value !== joined) set(e.target.value.split('\n')); }} />
            </label>
          );
        }
        if (spec.type === 'series') {
          const text = Array.isArray(val)
            ? (val as { label: string; color: string; points: number[] }[])
              .map((s) => `${s.label},${s.color},${s.points.join(' ')}`).join('\n')
            : '';
          return (
            <label key={spec.key} className={styles.paramRowCol}>
              <span>{spec.label || spec.key} (label,#color,points…)</span>
              <textarea rows={3} spellCheck={false} defaultValue={text}
                onBlur={(e) => {
                  const series = e.target.value.split('\n').filter(Boolean).map((line) => {
                    const [label = '', color = '#111111', pts = ''] = line.split(',');
                    return { label: label.trim(), color: color.trim(), points: pts.trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n)) };
                  }).filter((s) => s.points.length);
                  if (series.length) set(series as unknown as ParamValue);
                }} />
            </label>
          );
        }
        // text — committed on blur (NOT per keystroke: each commit rebuilds the whole element)
        return (
          <label key={spec.key} className={styles.paramRowCol}>
            <span>{spec.label || spec.key}</span>
            <textarea rows={String(val).length > 40 ? 2 : 1} spellCheck={false} defaultValue={String(val)}
              onKeyDown={(e) => e.stopPropagation()}
              onBlur={(e) => { if (e.target.value !== String(val)) set(e.target.value); }} />
          </label>
        );
      })}
    </div>
  );
}

export default function Editor({ initialDoc, onClose }: EditorProps) {
  const config = useStore((s) => s.config);
  const storeBrand = useStore((s) => s.brand);
  const storeBatch = useStore((s) => s.batch);

  const [doc, setDoc] = useState<DesignDoc>(() => {
    // Normalize on load: re-measure every autoH text box with the browser's exact measurer.
    // Saved docs carry server-side ESTIMATES (and pre-fix docs an over-tall pill estimate) —
    // one pass here means stale heights never reach the canvas.
    const d = JSON.parse(JSON.stringify(initialDoc)) as DesignDoc;
    try { remeasureAutoHeights(leaves(d.layers, true)); } catch { /* never block a load */ }
    return d;
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [enteredGroupId, setEnteredGroupId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(!initialDoc.updatedAt || initialDoc.updatedAt === initialDoc.createdAt);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [xray, setXray] = useState(false);
  const [underlayMode, setUnderlayMode] = useState<UnderlayMode>('off');
  const [underlayOpacity, setUnderlayOpacity] = useState(0.5);
  const [savedElements, setSavedElements] = useState<SavedElement[]>([]);
  // right panel tabs: Design (inspector) | Agent (chat) — persisted across sessions
  const [rightTab, setRightTabState] = useState<'design' | 'agent'>(() => {
    try { return localStorage.getItem('neuegen.editor.rightTab') === 'agent' ? 'agent' : 'design'; } catch { return 'design'; }
  });
  const setRightTab = (t: 'design' | 'agent') => {
    setRightTabState(t);
    try { localStorage.setItem('neuegen.editor.rightTab', t); } catch { /* private mode */ }
  };
  // compact Elements browser (popover) — default collapsed so Layers gets the space
  const [elementsOpen, setElementsOpen] = useState(false);
  const [elemQuery, setElemQuery] = useState('');
  const [elemCat, setElemCat] = useState<string>('All');
  const [elemHi, setElemHi] = useState(0); // arrow-key highlight index into the flat popover list
  const elementsWrapRef = useRef<HTMLDivElement>(null);
  // agent run lock: editing is frozen while a run is in flight for this doc
  const [agentBusy, setAgentBusy] = useState(false);
  const agentBusyRef = useRef(false);
  agentBusyRef.current = agentBusy;

  // Live agent feed → overlay label + canvas flash targets (targetId = real node id per op).
  const designEvents = useStore((s) => s.ui.designEvents);
  const agentStepLabel = useMemo(() => {
    for (let i = designEvents.length - 1; i >= 0; i--) {
      const s = designEvents[i].step;
      if (s?.summary) return s.summary;
    }
    return 'Agent working…';
  }, [designEvents]);
  const agentFlashes = useMemo(
    () => designEvents
      .filter((e) => e.step?.kind === 'op' && (e.step.data as { targetId?: string } | undefined)?.targetId)
      .slice(-8)
      .map((e) => ({ id: (e.step!.data as { targetId: string }).targetId, at: e.step!.at })),
    [designEvents],
  );
  // local font families for the Typography combo (Chrome Local Font Access; [] elsewhere)
  const [localFonts, setLocalFonts] = useState<string[]>([]);
  useEffect(() => { listLocalFonts().then(setLocalFonts).catch(() => {}); }, []);
  // live sync: a newer copy of this doc was saved elsewhere while we have local edits
  const [remoteUpdate, setRemoteUpdate] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const dragRowId = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; mode: 'above' | 'into' } | null>(null);

  const batchImages = useBatchImages();
  void batchImages; // apply-to-batch moved to the gallery; kept for parity of the hook

  useEffect(() => { api.listElements().then((r) => setSavedElements(r.elements || [])); }, []);

  // Brand kit (colors/fonts) for this doc's workspace — swatches + on-brand elements.
  const kitBrand = doc.brand || storeBrand || '';
  const [brandKit, setBrandKit] = useState<{ colors: string[]; fonts: string[]; notes: string }>({ colors: [], fonts: [], notes: '' });
  useEffect(() => {
    if (kitBrand) api.getBrandKit(kitBrand).then((r) => { if (r.ok) setBrandKit(r.kit); });
  }, [kitBrand]);
  const addBrandColor = async (color: string) => {
    if (!kitBrand || !color || brandKit.colors.includes(color)) return;
    const kit = { ...brandKit, colors: [...brandKit.colors, color].slice(0, 16) };
    setBrandKit(kit);
    await api.saveBrandKit(kitBrand, kit);
    flash('Added to brand colors');
  };

  const imageFileInput = useRef<HTMLInputElement>(null);
  const imageFileTarget = useRef<'insert' | string>('insert'); // 'insert' = new layer, else layer id to swap

  const flash = (m: string) => { setNote(m); window.setTimeout(() => setNote(null), 3000); };

  // ── history ──
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const dragSnapshot = useRef<string | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;

  const pushHistory = useCallback((snapshot: string) => {
    past.current.push(snapshot);
    if (past.current.length > HISTORY_CAP) past.current.shift();
    future.current = [];
  }, []);

  // ── live-sync SEND: coalesce changed boxes and POST at most one frame per ~50ms ──
  const liveOut = useRef<{ lastSent: number; pending: Map<string, LiveNode>; timer: number | null }>(
    { lastSent: 0, pending: new Map(), timer: null },
  );
  const queueLive = useCallback((changed: LiveNode[]) => {
    if (!changed.length) return;
    const st = liveOut.current;
    for (const c of changed) st.pending.set(c.id, c); // latest box per node wins within the window
    if (st.timer != null) return;
    const wait = Math.max(0, 50 - (Date.now() - st.lastSent));
    st.timer = window.setTimeout(() => {
      st.timer = null;
      st.lastSent = Date.now();
      const nodes = [...st.pending.values()].slice(0, 200);
      st.pending.clear();
      void api.designLive({ id: docRef.current.id, origin: TAB_ORIGIN, nodes }); // fire-and-forget
    }, wait);
  }, []);

  // ── live-sync RECEIVE: buffer remote patches, apply rAF-capped, hold while mid-gesture ──
  const liveIn = useRef<Map<string, LiveNode>>(new Map());
  const liveRaf = useRef<number | null>(null);
  const applyRemoteLive = useCallback(() => {
    liveRaf.current = null;
    const patches = liveIn.current;
    if (!patches.size) return;
    if (dragSnapshot.current != null) return; // mid-gesture — keep buffering, flush on commit
    const byId = new Map(patches);
    patches.clear();
    const next = JSON.parse(JSON.stringify(docRef.current)) as DesignDoc;
    let touched = false;
    walk(next.layers, (n) => {
      const p = byId.get(n.id);
      if (!p) return;
      n.box = { ...p.box };
      (n as { rotation?: number }).rotation = p.rotation || undefined;
      touched = true;
    });
    if (!touched) return;
    normalizeGroups(next);
    setDoc(next); // NO history, NO dirty — this is a remote preview, truth arrives via 'doc'
  }, []);
  const scheduleRemoteLive = useCallback(() => {
    if (liveRaf.current != null) return;
    liveRaf.current = window.requestAnimationFrame(() => applyRemoteLive());
  }, [applyRemoteLive]);

  /** Post-mutation invariants: autoH text boxes hug their content, group boxes hug children. */
  const settle = (d: DesignDoc) => {
    remeasureAutoHeights(leaves(d.layers, true));
    normalizeGroups(d);
  };

  /** One discrete edit = one undo step. */
  const commit = useCallback((mutate: (d: DesignDoc) => void) => {
    pushHistory(JSON.stringify(docRef.current));
    const next = JSON.parse(JSON.stringify(docRef.current)) as DesignDoc;
    mutate(next);
    settle(next);
    queueLive(collectLiveDiff(docRef.current, next)); // live-sync: broadcast the moved boxes
    setDoc(next);
    setDirty(true);
  }, [pushHistory, queueLive]);

  /** Stage/scrub stream protocol — commit=false frames share ONE snapshot from gesture start. */
  const onStreamChange = useCallback((mutate: (d: DesignDoc) => void, commitFlag: boolean) => {
    if (!commitFlag) {
      if (dragSnapshot.current == null) dragSnapshot.current = JSON.stringify(docRef.current);
      const next = JSON.parse(JSON.stringify(docRef.current)) as DesignDoc;
      mutate(next);
      settle(next);
      queueLive(collectLiveDiff(docRef.current, next)); // live-sync: mid-gesture frame
      setDoc(next);
      setDirty(true);
      return;
    }
    if (dragSnapshot.current != null) {
      pushHistory(dragSnapshot.current);
      dragSnapshot.current = null;
      const next = JSON.parse(JSON.stringify(docRef.current)) as DesignDoc;
      mutate(next);
      settle(next);
      queueLive(collectLiveDiff(docRef.current, next)); // live-sync: final gesture frame
      setDoc(next);
      setDirty(true);
      scheduleRemoteLive(); // gesture over — flush any remote patches buffered while dragging
    } else {
      commit(mutate);
    }
  }, [commit, pushHistory, queueLive, scheduleRemoteLive]);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(JSON.stringify(docRef.current));
    setDoc(JSON.parse(prev));
    setDirty(true);
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(JSON.stringify(docRef.current));
    setDoc(JSON.parse(next));
    setDirty(true);
  }, []);

  // Selection bookkeeping: drop ids that no longer exist (agent rewrites, undo across group ops).
  useEffect(() => {
    setSelectedIds((ids) => {
      const alive = ids.filter((id) => findNode(doc, id));
      return alive.length === ids.length ? ids : alive;
    });
    if (enteredGroupId && !findNode(doc, enteredGroupId)) setEnteredGroupId(null);
  }, [doc, enteredGroupId]);

  const selected = selectedIds.length === 1 ? findNode(doc, selectedIds[0]) : null;
  const selectedLeaf = selected && !isGroup(selected) ? selected : null;

  // ── persistence + exports ──
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const lastThumbAt = useRef(0); // gallery thumbnails are rasterized at most every 5s
  const lastSavedAt = useRef(0); // ignore the SSE echo of our OWN save (it can beat the re-render)

  const save = useCallback(async (silent = false) => {
    const errs = validateDesign(docRef.current);
    if (errs.length) { flash(`invalid: ${errs[0]}`); return false; }
    setBusy('save');
    // thumbnail for the gallery — tiny raster, best-effort, throttled (autosave runs often)
    const wantThumb = Date.now() - lastThumbAt.current >= 5000;
    const thumb = wantThumb
      ? await rasterizeDesign(docRef.current, 360 / docRef.current.canvas.w).catch(() => null)
      : null;
    if (thumb) lastThumbAt.current = Date.now();
    const r = await api.saveDesign(docRef.current, thumb);
    setBusy(null);
    if (r.ok && r.design) {
      lastSavedAt.current = r.design.updatedAt; // before setDoc renders — the SSE echo races it
      setDoc((d) => ({ ...d, updatedAt: r.design!.updatedAt }));
      setDirty(false);
      if (!silent) flash('Saved');
      return true;
    }
    flash(r.error || 'save failed');
    return false;
  }, []);

  // ── autosave: ~250ms after the last COMMIT so "every action" persists near-instantly
  // (never mid-drag — stream frames keep dragSnapshot non-null until the gesture's final
  // commit flushes it; the gallery thumbnail raster stays throttled to ≥5s in save()) ──
  useEffect(() => {
    if (!dirty || dragSnapshot.current != null) return;
    const t = window.setTimeout(() => {
      if (dragSnapshot.current == null && dirtyRef.current) void save(true);
    }, 250);
    return () => window.clearTimeout(t);
  }, [doc, dirty, save]);

  /** Pull the server copy of this doc (silent replace — selection survives by id). */
  const reloadRemote = useCallback(async () => {
    const r = await api.getDesign(docRef.current.id);
    if (r.ok && r.design) {
      const next = r.design;
      remeasureAutoHeights(leaves(next.layers, true));
      normalizeGroups(next);
      setDoc(next);
      setDirty(false);
      setRemoteUpdate(null);
    }
  }, []);

  // ── live sync, commit channel: another tab (or the gallery/agent) saved this doc → replace
  // silently when we have no local edits; when dirty, show a chip instead of clobbering local
  // work. The ephemeral channel ('live') patches boxes in place — see the protocol doc on top. ──
  useEffect(() => {
    let es: EventSource | null = null;
    try { es = new EventSource('/events'); } catch { return; }
    const onDocEvent = (e: Event) => {
      try {
        const p = JSON.parse((e as MessageEvent).data) as { kind?: string; id?: string; updatedAt?: number };
        if (!p || p.kind !== 'design' || p.id !== docRef.current.id) return;
        if (typeof p.updatedAt !== 'number' || p.updatedAt <= (docRef.current.updatedAt || 0)) return;
        if (p.updatedAt <= lastSavedAt.current) return; // our own save echoed back
        if (dirtyRef.current) setRemoteUpdate(p.updatedAt);
        else void reloadRemote();
      } catch { /* bad frame */ }
    };
    const onLiveEvent = (e: Event) => {
      try {
        const p = JSON.parse((e as MessageEvent).data) as { id?: string; origin?: string; nodes?: LiveNode[]; at?: number };
        if (!p || p.id !== docRef.current.id) return;       // different doc
        if (!p.origin || p.origin === TAB_ORIGIN) return;   // my own echo
        if (typeof p.at === 'number' && p.at <= (docRef.current.updatedAt || 0)) return; // stale frame
        if (!Array.isArray(p.nodes) || !p.nodes.length) return;
        for (const n of p.nodes) {
          if (n && typeof n.id === 'string' && n.box) liveIn.current.set(n.id, n);
        }
        scheduleRemoteLive();
      } catch { /* bad frame */ }
    };
    es.addEventListener('doc', onDocEvent);
    es.addEventListener('live', onLiveEvent);
    return () => { es?.close(); };
  }, [reloadRemote, scheduleRemoteLive]);

  const doFigmaCopy = async () => {
    setBusy('figma');
    // GESTURE SAFETY: start the clipboard write FIRST, synchronously inside this click handler.
    // copyForFigma registers the write with promise-backed blobs so the browser holds the user
    // gesture open while the payload builds. Awaiting a network save() before it would spend the
    // gesture and get the write silently rejected in Safari/Firefox — the "copy does nothing" bug.
    const copyPromise = copyForFigma(docRef.current);
    try {
      const r = await copyPromise;
      flash(r.ok ? `Copied — ${r.detail}. Paste in Figma (⌘V).` : r.detail);
    } finally { setBusy(null); }
    // Persist AFTER the write is registered — never gate the gesture-bound clipboard write on it.
    void save(true);
  };

  const downloadPng = async () => {
    setBusy('png');
    try {
      const png = await rasterizeDesign(docRef.current);
      const a = document.createElement('a');
      a.href = png;
      a.download = `${docRef.current.name.replace(/[^a-zA-Z0-9_-]+/g, '-')}.png`;
      a.click();
    } catch { flash('PNG render failed'); }
    finally { setBusy(null); }
  };

  const saveAsSkeleton = async () => {
    const skel = skeletonFromDoc(docRef.current);
    const r = await api.saveSkeleton(skel);
    flash(r.ok ? 'Layout saved — reusable from “New comp”' : (r.error || 'failed'));
  };

  /** Apply an agent-produced doc (AgentPanel hands it here) — ONE undo step. */
  const applyAgentDoc = useCallback((design: DesignDoc) => {
    pushHistory(JSON.stringify(docRef.current));
    const next = design;
    remeasureAutoHeights(leaves(next.layers, true));
    normalizeGroups(next);
    setDoc(next);
    setDirty(false); // the server already persisted this doc
  }, [pushHistory]);

  // ── structure ops ──
  const groupSelection = useCallback(() => {
    const ids = selectedIds.filter((id) => {
      const n = findNode(docRef.current, id);
      return n && !(!isGroup(n) && n.role === 'base');
    });
    if (!ids.length) return;
    commit((d) => {
      const g = groupNodes(d, ids, undefined);
      if (g) setSelectedIds([g.id]);
    });
  }, [selectedIds, commit]);

  const ungroupSelection = useCallback(() => {
    const groups = selectedIds.filter((id) => {
      const n = findNode(docRef.current, id);
      return n && isGroup(n);
    });
    if (!groups.length) return;
    commit((d) => {
      const freed: string[] = [];
      for (const id of groups) {
        const children = ungroupNode(d, id);
        if (children) freed.push(...children.map((c) => c.id));
      }
      if (freed.length) setSelectedIds(freed);
    });
  }, [selectedIds, commit]);

  const deleteSelection = useCallback(() => {
    const ids = selectedIds.filter((id) => {
      const n = findNode(docRef.current, id);
      return n && !(!isGroup(n) && n.role === 'base');
    });
    if (!ids.length) return;
    commit((d) => {
      for (const id of ids) {
        const list = findParentList(d, id);
        if (list) list.splice(list.findIndex((n) => n.id === id), 1);
      }
    });
    setSelectedIds([]);
  }, [selectedIds, commit]);

  const duplicateSelection = useCallback(() => {
    const ids = selectedIds.filter((id) => {
      const n = findNode(docRef.current, id);
      return n && !(!isGroup(n) && n.role === 'base');
    });
    if (!ids.length) return;
    const created: string[] = [];
    commit((d) => {
      for (const id of ids) {
        const list = findParentList(d, id);
        const src = list?.find((n) => n.id === id);
        if (!list || !src) continue;
        const copy = JSON.parse(JSON.stringify(src)) as SceneNode;
        const reid = (n: SceneNode) => {
          n.id = layerId(n.role || n.type);
          if (isGroup(n)) n.children.forEach(reid);
        };
        reid(copy);
        copy.box = { ...copy.box, x: Math.min(copy.box.x + 24, d.canvas.w - copy.box.w), y: Math.min(copy.box.y + 24, d.canvas.h - copy.box.h) };
        if (isGroup(copy)) {
          const dx = copy.box.x - src.box.x;
          const dy = copy.box.y - src.box.y;
          walk(copy.children, (n) => { n.box = { ...n.box, x: n.box.x + dx, y: n.box.y + dy }; });
        }
        list.splice(list.indexOf(src) + 1, 0, copy);
        created.push(copy.id);
      }
    });
    if (created.length) setSelectedIds(created);
  }, [selectedIds, commit]);

  /** Align: single selection → to the CANVAS; 2+ selected → to the SELECTION bounds (Figma). */
  const alignSelected = (dir: 'l' | 'c' | 'r' | 't' | 'm' | 'b') => {
    if (!selectedIds.length) return;
    commit((d) => {
      const nodes = selectedIds
        .map((id) => findNode(d, id))
        .filter((n): n is SceneNode => !!n && !(!isGroup(n) && n.role === 'base'));
      if (!nodes.length) return;
      const multi = nodes.length >= 2;
      const bx = multi ? Math.min(...nodes.map((n) => n.box.x)) : 0;
      const by = multi ? Math.min(...nodes.map((n) => n.box.y)) : 0;
      const bw = multi ? Math.max(...nodes.map((n) => n.box.x + n.box.w)) - bx : d.canvas.w;
      const bh = multi ? Math.max(...nodes.map((n) => n.box.y + n.box.h)) - by : d.canvas.h;
      for (const n of nodes) {
        let dx = 0, dy = 0;
        if (dir === 'l') dx = bx - n.box.x;
        if (dir === 'c') dx = Math.round(bx + (bw - n.box.w) / 2) - n.box.x;
        if (dir === 'r') dx = bx + bw - n.box.w - n.box.x;
        if (dir === 't') dy = by - n.box.y;
        if (dir === 'm') dy = Math.round(by + (bh - n.box.h) / 2) - n.box.y;
        if (dir === 'b') dy = by + bh - n.box.h - n.box.y;
        walk([n], (x) => { x.box = { ...x.box, x: x.box.x + dx, y: x.box.y + dy }; });
      }
    });
  };

  /** Distribute 3+ selected with equal gaps along an axis (Figma parity). */
  const distributeSelected = (axis: 'h' | 'v') => {
    if (selectedIds.length < 3) return;
    commit((d) => {
      const nodes = selectedIds
        .map((id) => findNode(d, id))
        .filter((n): n is SceneNode => !!n && !(!isGroup(n) && n.role === 'base'));
      if (nodes.length < 3) return;
      const key = axis === 'h' ? 'x' : 'y';
      const size = axis === 'h' ? 'w' : 'h';
      const sorted = [...nodes].sort((a, b) => a.box[key] - b.box[key]);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const span = (last.box[key] + last.box[size]) - first.box[key];
      const total = sorted.reduce((s, n) => s + n.box[size], 0);
      const gap = (span - total) / (sorted.length - 1);
      let cursor = first.box[key];
      for (const n of sorted) {
        const delta = Math.round(cursor) - n.box[key];
        if (delta) {
          walk([n], (x) => { x.box = { ...x.box, [key]: x.box[key] + delta }; });
        }
        cursor += n.box[size] + gap;
      }
    });
  };

  // ── keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      // agent run lock: no document mutation from the keyboard while a run is in flight
      if (agentBusyRef.current) {
        if (mod && ['z', 's', 'g', 'd', 'v', 'x'].includes(e.key.toLowerCase())) e.preventDefault();
        if (['Backspace', 'Delete', '[', ']', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        if (e.shiftKey) ungroupSelection(); else groupSelection();
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const level = enteredGroupId
          ? (findNode(docRef.current, enteredGroupId) as GroupNode | null)?.children ?? docRef.current.layers
          : docRef.current.layers;
        setSelectedIds(level.filter((n) => !n.hidden && !n.locked && !(!isGroup(n) && n.role === 'base')).map((n) => n.id));
        return;
      }
      if (mod && e.key.toLowerCase() === 'c' && selectedIds.length) {
        e.preventDefault();
        const nodes = selectedIds.map((id) => findNode(docRef.current, id)).filter(Boolean);
        (window as unknown as { __ngClipboard?: string }).__ngClipboard = JSON.stringify(nodes);
        flash(`Copied ${nodes.length} layer(s)`);
        return;
      }
      if (mod && e.key.toLowerCase() === 'v' && (window as unknown as { __ngClipboard?: string }).__ngClipboard) {
        e.preventDefault();
        try {
          const nodes = JSON.parse((window as unknown as { __ngClipboard?: string }).__ngClipboard!) as SceneNode[];
          const reid = (n: SceneNode) => {
            n.id = layerId(n.role || n.type);
            if (isGroup(n)) n.children.forEach(reid);
          };
          for (const n of nodes) {
            reid(n);
            walk([n], (x) => { x.box = { ...x.box, x: x.box.x + 24, y: x.box.y + 24 }; });
          }
          commit((d) => { d.layers.push(...nodes); });
          setSelectedIds(nodes.map((n) => n.id));
        } catch { /* stale clipboard */ }
        return;
      }
      // z-order: [ / ] step, ⌘[ / ⌘] to back/front — within the node's own parent list
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        commit((d) => {
          for (const id of selectedIds) {
            const list = findParentList(d, id);
            if (!list) continue;
            const i = list.findIndex((n) => n.id === id);
            if (i < 0) continue;
            const floor = list.findIndex((n) => !isGroup(n) && n.role === 'base') + 1; // never below base
            if (e.key === ']') {
              const to = mod ? list.length - 1 : Math.min(list.length - 1, i + 1);
              const [n] = list.splice(i, 1); list.splice(to, 0, n);
            } else {
              const to = mod ? floor : Math.max(floor, i - 1);
              const [n] = list.splice(i, 1); list.splice(to, 0, n);
            }
          }
        });
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSelection(); return; }
      if (e.key === 'Escape') {
        if (enteredGroupId) setEnteredGroupId(null);
        else setSelectedIds([]);
        return;
      }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && selectedIds.length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        commit((d) => {
          for (const id of selectedIds) {
            const n = findNode(d, id);
            if (!n || n.locked || (!isGroup(n) && n.role === 'base')) continue;
            walk([n], (x) => { x.box = { ...x.box, x: x.box.x + dx, y: x.box.y + dy }; });
          }
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds, enteredGroupId, commit, undo, redo, save, groupSelection, ungroupSelection, deleteSelection, duplicateSelection]);

  // ── fill from brief (link → config copy candidates) ──
  const link = doc.link || null;
  const linkedCopy = useMemo(() => {
    if (!link) return [];
    const brand = config.brands.find((b) => b.id === link.brand);
    const batch = brand?.batches.find((bt) => bt.code === link.batch);
    const ad = batch?.ads?.find((a) => a.id === link.ad);
    const variation = ad?.variations?.find((v) => v.id === link.variation) || ad?.variations?.[0];
    const out: { label: string; text: string }[] = [];
    if (variation?.copy) out.push({ label: 'Variation copy', text: variation.copy });
    if (variation?.label) out.push({ label: 'Variation label', text: variation.label });
    if (ad?.title) out.push({ label: 'Ad title', text: ad.title });
    return out;
  }, [config, link]);

  const setLink = (partial: Partial<NonNullable<DesignDoc['link']>> | null) => {
    commit((d) => {
      if (partial === null) { d.link = null; return; }
      d.link = { brand: storeBrand || '', batch: storeBatch || '', ad: '', ...d.link, ...partial } as DesignDoc['link'];
    });
  };

  const mutateSelected = (fn: (l: Layer) => void, live = false) => {
    if (!selectedLeaf) return;
    const apply = (d: DesignDoc) => {
      const n = findNode(d, selectedLeaf.id);
      if (n && !isGroup(n)) fn(n);
    };
    if (live) onStreamChange(apply, false);
    else onStreamChange(apply, true);
  };

  const setStyle = (patch: Partial<LayerStyle>, live = false) => {
    mutateSelected((l) => { l.style = { ...l.style, ...patch }; }, live);
  };

  const insertLayers = (nodes: SceneNode[]) => {
    if (!nodes.length) return;
    commit((d) => { d.layers.push(...(JSON.parse(JSON.stringify(nodes)) as SceneNode[])); });
    // select the parametric instance root (its param form is the whole point of inserting) and
    // land in the Design tab so the settings are immediately visible
    const inst = nodes.find((n) => (n as SceneNode & { element?: unknown }).element) || nodes[nodes.length - 1];
    setSelectedIds([inst.id]);
    setRightTab('design');
  };

  /** One-click preset: build a whole-ad archetype into the doc as ONE grouped, undoable step.
   *  `replace` (default for a near-empty comp) clears existing non-base layers first; otherwise
   *  the preset is added on top. The new layers are wrapped in a single group so the archetype
   *  moves/undoes/selects as one unit. */
  const insertPreset = ({ layers: built, name }: { layers: SceneNode[]; name: string }, replace: boolean) => {
    if (!built.length) return;
    let groupId: string | null = null;
    commit((d) => {
      if (replace) {
        // keep the base layer, drop everything above it — a preset is a whole ad
        d.layers = d.layers.filter((l) => !isGroup(l) && (l as Layer).role === 'base');
      }
      const fresh = JSON.parse(JSON.stringify(built)) as SceneNode[];
      const ids = fresh.map((n) => n.id);
      d.layers.push(...fresh);
      const g = groupNodes(d, ids, name);
      if (g) groupId = g.id;
    });
    if (groupId) setSelectedIds([groupId]);
    setEnteredGroupId(null);
    setRightTab('design');
    flash(replace ? `${name} preset applied` : `${name} preset added`);
  };

  /** Insert a NEW image layer or swap the src of an existing one (imageFileTarget). */
  const onImageFile = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const r = await api.uploadRef(String(reader.result));
      if (!r.ok || !r.url) { flash('Upload failed'); return; }
      const target = imageFileTarget.current;
      if (target === 'insert') {
        const cw = docRef.current.canvas.w;
        insertLayers([{
          id: layerId('image'), type: 'image', role: 'product', name: file.name || 'Image',
          src: r.url, fit: 'contain',
          box: { x: Math.round(cw * 0.2), y: Math.round(docRef.current.canvas.h * 0.3), w: Math.round(cw * 0.6), h: Math.round(cw * 0.6) },
        }]);
      } else {
        commit((d) => {
          const n = findNode(d, target);
          if (n && !isGroup(n)) n.src = r.url;
        });
        flash('Image replaced');
      }
    };
    reader.readAsDataURL(file);
  };

  // ── layers tree rows ──
  interface Row { n: SceneNode; depth: number }
  const rows = useMemo(() => {
    const out: Row[] = [];
    const visit = (nodes: SceneNode[], depth: number) => {
      for (let i = nodes.length - 1; i >= 0; i--) { // top of stack first
        const n = nodes[i];
        out.push({ n, depth });
        if (isGroup(n) && !collapsed.has(n.id)) visit(n.children, depth + 1);
      }
    };
    visit(doc.layers, 0);
    return out;
  }, [doc, collapsed]);

  // 100+ layers: the list is a tall internal scroll region — when selection changes from the
  // CANVAS (or agent), reveal the selected row. block:'nearest' makes this a no-op when the
  // user clicked the row itself (already visible), so it never yanks the list around.
  const layerListRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const id = selectedIds[0];
    if (!id || !layerListRef.current) return;
    layerListRef.current
      .querySelector(`[data-node-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIds]);

  const onRowDrop = (targetId: string, mode: 'above' | 'into') => {
    const srcId = dragRowId.current;
    dragRowId.current = null;
    setDrop(null);
    if (!srcId || srcId === targetId) return;
    commit((d) => {
      if (mode === 'into') {
        const g = findNode(d, targetId);
        if (g && isGroup(g)) reparentNode(d, srcId, targetId, g.children.length);
        return;
      }
      // 'above' in the panel = AFTER in the array (panel renders top-first)
      const list = findParentList(d, targetId);
      if (!list) return;
      const parentGroup = (() => {
        let pg: string | null = null;
        walk(d.layers, (n, parent) => { if (n.id === targetId) pg = parent?.id ?? null; });
        return pg;
      })();
      const idx = list.findIndex((n) => n.id === targetId);
      reparentNode(d, srcId, parentGroup, idx + 1);
    });
  };

  const underlay: UnderlayState | null =
    doc.reference && underlayMode === 'over'
      ? { url: doc.reference.url, mode: 'over', opacity: underlayOpacity }
      : null;

  const linkBrand = config.brands.find((b) => b.id === (link?.brand || storeBrand));
  const linkBatch = linkBrand?.batches.find((bt) => bt.code === (link?.batch || storeBatch));

  const selGradient: GradientFill | null = selectedLeaf ? resolveGradient(selectedLeaf.style) : null;
  const fillMode: 'none' | 'solid' | 'gradient' =
    selGradient ? 'gradient' : selectedLeaf?.style?.background ? 'solid' : 'none';

  // ── parametric element instance under the selection → auto param form ──
  // v2: selecting a CHILD inside an element also surfaces its instance's params — params are
  // the single edit path for elements (raw style edits leave stale residue on rebuild).
  const ownerHit = selected && !(selected as SceneNode & { element?: unknown }).element
    ? findElementInstance(doc, selected.id)
    : null;
  const instNode = selected
    ? ((selected as SceneNode & { element?: unknown }).element ? selected : ownerHit?.instance ?? null)
    : null;
  const elInst = instNode
    ? (instNode as SceneNode & { element?: { id: string; params: Record<string, unknown>; v: number } }).element ?? null
    : null;
  const elDef: ElementDef | null = elInst ? ELEMENTS.find((d) => d.id === elInst.id) ?? null : null;

  /** Param edit → rebuild the element in place: same node id, POSITION kept, natural measured
   *  size (v2 — squeezing fresh content into the old bounds distorted fonts and re-clipped). */
  const applyParamPatch = (patch: Record<string, ParamValue>) => {
    if (!instNode || !elInst || !elDef) return;
    const targetId = instNode.id;
    commit((d) => {
      const node = findNode(d, targetId);
      if (!node) return;
      const inst = (node as SceneNode & { element?: { id: string; params: Record<string, unknown> } }).element;
      if (!inst) return;
      const list = findParentList(d, targetId);
      if (!list) return;
      const idx = list.findIndex((n) => n.id === targetId);
      if (idx < 0) return;
      const built = buildElement(inst.id, d, { ...inst.params, ...patch }, brandKit);
      if (!built.length) return;
      const fresh = built.find((n) => (n as SceneNode & { element?: unknown }).element) || built[0];
      const dx = node.box.x - fresh.box.x;
      const dy = node.box.y - fresh.box.y;
      walk([fresh], (n) => { n.box.x += dx; n.box.y += dy; });
      fresh.id = targetId; // selection + history stay stable
      list.splice(idx, 1, fresh);
    });
  };

  // ── compact elements browser: close the popover on outside click / Escape ──
  useEffect(() => {
    if (!elementsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!elementsWrapRef.current?.contains(e.target as Node)) setElementsOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setElementsOpen(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc, true);
    };
  }, [elementsOpen]);

  const q = elemQuery.trim().toLowerCase();
  const filteredElements = CANONICAL_ELEMENTS.filter((el) =>
    (elemCat === 'All' || el.category === elemCat)
    && (!q || el.name.toLowerCase().includes(q) || el.hint.toLowerCase().includes(q) || el.category.toLowerCase().includes(q)));
  const filteredSaved = savedElements.filter((el) =>
    (elemCat === 'All' || elemCat === 'Saved') && (!q || el.name.toLowerCase().includes(q)));

  // flat, in-render-order list of insertable popover rows — drives arrow-key navigation
  const popItems: { key: string; insert: () => void }[] = [
    ...(elemCat === 'All' ? ELEMENT_CATEGORIES : [elemCat]).flatMap((cat) =>
      filteredElements.filter((el) => el.category === cat).map((el) => ({
        key: `lib:${el.id}`,
        insert: () => { insertLayers(buildElement(el.id, docRef.current, undefined, brandKit)); setElementsOpen(false); },
      }))),
    ...filteredSaved.map((el) => ({
      key: `saved:${el.id}`,
      insert: () => {
        insertLayers(el.layers.map((l) => ({ ...JSON.parse(JSON.stringify(l)), id: layerId(l.role || l.type) })));
        setElementsOpen(false);
      },
    })),
  ];
  const hiIndex = popItems.length ? Math.min(elemHi, popItems.length - 1) : -1;
  const onPopKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setElemHi((i) => Math.min(i + 1, popItems.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setElemHi((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (hiIndex >= 0) popItems[hiIndex].insert(); }
    e.stopPropagation();
  };

  // Typography font combo suggestions: brand-kit fonts pinned first, then local families
  const fontOptions = [...brandKit.fonts, ...localFonts.filter((f) => !brandKit.fonts.includes(f))];

  // ── render ──
  return (
    <div className={styles.editor}>
      {/* ── top strip ── */}
      <div className={styles.topStrip}>
        <button type="button" className={styles.backBtn} onClick={onClose}>← Comps</button>
        <input
          className={styles.nameInput}
          value={doc.name}
          onChange={(e) => { setDoc((d) => ({ ...d, name: e.target.value })); setDirty(true); }}
          spellCheck={false}
          aria-label="Comp name"
        />

        <span
          className={styles.underlayLabel}
          title="Aspect ratio is locked — set upfront when the comp was created"
        >
          {doc.canvas.w}×{doc.canvas.h}
        </span>

        <div className={styles.zoomGroup}>
          <button type="button" className={styles.zoomBtn} onClick={() => setZoom('fit')} data-active={zoom === 'fit' || undefined}>Fit</button>
          <button type="button" className={styles.zoomBtn} onClick={() => setZoom(1)} data-active={zoom === 1 || undefined}>100%</button>
        </div>

        {/* frame background — visible whenever the base is a solid-color shape */}
        {(() => {
          const base = doc.layers.find((l) => !isGroup(l) && l.role === 'base') as Layer | undefined;
          if (!base || base.type !== 'shape') return null;
          const cur = typeof base.style?.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(base.style.background)
            ? base.style.background : '#ffffff';
          return (
            <label className={styles.frameColorWrap} title="Frame background color">
              <input
                type="color" value={cur} className={styles.frameColor}
                aria-label="Frame background color"
                onChange={(e) => onStreamChange((d) => {
                  const b = d.layers.find((l) => !isGroup(l) && (l as Layer).role === 'base') as Layer | undefined;
                  if (b) b.style = { ...b.style, background: e.target.value };
                }, false)}
                onBlur={() => onStreamChange(() => {}, true)}
              />
            </label>
          );
        })()}

        <button
          type="button" className={styles.iconBtn}
          data-active={xray || undefined}
          title="X-ray — show how this ad is built"
          aria-label="Toggle X-ray"
          aria-pressed={xray}
          onClick={() => setXray((v) => !v)}
        >
          <Icon name={xray ? 'eye-off' : 'eye'} size={14} />
        </button>

        {doc.reference ? (
          <div className={styles.underlayGroup}>
            <span className={styles.underlayLabel}>Ref</span>
            {/* Side-by-side compare: the reference shown in a panel BESIDE the canvas. */}
            <button
              type="button" className={styles.zoomBtn}
              data-active={underlayMode === 'side' || undefined}
              aria-pressed={underlayMode === 'side'}
              title="Compare side by side — reference beside the canvas"
              onClick={() => setUnderlayMode((m) => (m === 'side' ? 'off' : 'side'))}
            >
              <Icon name="columns" size={13} />
              Side by side
            </button>
            {/* Tracing-paper overlay: the reference faint ON the canvas. */}
            <button
              type="button" className={styles.zoomBtn}
              data-active={underlayMode === 'over' || undefined}
              aria-pressed={underlayMode === 'over'}
              title="Overlay on canvas — the reference as tracing paper"
              onClick={() => setUnderlayMode((m) => (m === 'over' ? 'off' : 'over'))}
            >
              <Icon name="copy" size={13} />
              Overlay
            </button>
            {underlayMode === 'over' ? (
              <input
                type="range" min={10} max={100} value={Math.round(underlayOpacity * 100)}
                className={styles.opacitySlider}
                onChange={(e) => setUnderlayOpacity(Number(e.target.value) / 100)}
                aria-label="Underlay opacity"
              />
            ) : null}
          </div>
        ) : null}

        <div className={styles.topActions}>
          {remoteUpdate ? (
            <button type="button" className={styles.remoteChip} title="This comp was saved elsewhere — click to load the newer version (your unsaved edits are replaced)"
              onClick={() => void reloadRemote()}>
              Updated in another tab · reload
            </button>
          ) : null}
          <span
            className={styles.saveStatus}
            data-state={busy === 'save' ? 'saving' : dirty ? 'dirty' : 'saved'}
            title="Autosaved — ⌘S forces a save"
          >
            <span className={styles.saveDot} />
            {busy === 'save' ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}
          </span>
          <button type="button" className={styles.iconBtn} onClick={undo} title="Undo (⌘Z)"><Icon name="undo" size={14} /></button>
          <button type="button" className={styles.iconBtn} onClick={redo} title="Redo (⇧⌘Z)"><Icon name="redo" size={14} /></button>
          <span className={styles.actionDivider} />
          <button type="button" className={styles.ghostBtn} onClick={downloadPng} disabled={busy !== null} title="Download as PNG">PNG</button>
          <button type="button" className={styles.primaryBtn} onClick={doFigmaCopy} disabled={busy !== null} title="Copy to clipboard as native Figma layers — then paste in Figma (⌘V)">
            <Icon name="figma" size={13} />
            {busy === 'figma' ? 'Copying…' : 'Copy to Figma'}
          </button>
        </div>
      </div>

      <div className={styles.body}>
        {/* ── left: layers tree + elements ── */}
        <aside className={styles.left}>
          <div className={styles.panelHeaderRow}>
            <p className={`eyebrow ${styles.panelLabel}`}>Layers</p>
            {/* overflow menu — the odd one-off document actions live here, out of the way */}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className={styles.overflowBtn} title="More actions" aria-label="Layer actions">⋯</button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className={styles.menu} align="end" sideOffset={6}>
                  <DropdownMenu.Item
                    className={styles.menuItem}
                    onSelect={() => { imageFileTarget.current = 'insert'; imageFileInput.current?.click(); }}
                  >
                    <span className={styles.menuIcon}><Icon name="photo" size={13} /></span>
                    Add image…
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className={styles.menuItem}
                    disabled={!selectedLeaf || selectedLeaf.role === 'base'}
                    onSelect={async () => {
                      if (!selectedLeaf || selectedLeaf.role === 'base') return;
                      const r = await api.saveElement(selectedLeaf.name || selectedLeaf.role || selectedLeaf.type, [selectedLeaf], doc.canvas);
                      if (r.ok && r.elements) { setSavedElements(r.elements); flash('Element saved'); }
                    }}
                  >
                    <span className={styles.menuIcon}><Icon name="diamond" size={13} /></span>
                    Save selection as element
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className={styles.menuItem} onSelect={() => void saveAsSkeleton()}>
                    <span className={styles.menuIcon}><Icon name="frame" size={13} /></span>
                    Save layout as skeleton
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
          <div className={styles.layerList} ref={layerListRef}>
            {rows.map(({ n, depth }) => (
              <div
                key={n.id}
                className={styles.layerRow}
                data-node-id={n.id}
                data-active={selectedIds.includes(n.id) || undefined}
                data-hidden={n.hidden || undefined}
                data-drop={drop?.id === n.id ? drop.mode : undefined}
                data-group={isGroup(n) || undefined}
                data-depth={depth || undefined}
                style={{ paddingLeft: 6 + depth * 14 }}
                draggable={!(!isGroup(n) && n.role === 'base')}
                onDragStart={(e) => { dragRowId.current = n.id; e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={(e) => {
                  if (!dragRowId.current || dragRowId.current === n.id) return;
                  e.preventDefault();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const mode = isGroup(n) && e.clientY > rect.top + rect.height * 0.4 ? 'into' : 'above';
                  setDrop((d0) => (d0?.id === n.id && d0.mode === mode ? d0 : { id: n.id, mode }));
                }}
                onDragLeave={() => setDrop((d0) => (d0?.id === n.id ? null : d0))}
                onDrop={(e) => { e.preventDefault(); onRowDrop(n.id, drop?.mode || 'above'); }}
                onDragEnd={() => { dragRowId.current = null; setDrop(null); }}
                onClick={(e) => {
                  if (e.shiftKey) {
                    setSelectedIds((ids) => ids.includes(n.id) ? ids.filter((i) => i !== n.id) : [...ids, n.id]);
                  } else setSelectedIds([n.id]);
                }}
                onDoubleClick={() => setRenamingId(n.id)}
              >
                {/* tree guide rails — one hairline per ancestor depth, so a grouped comp reads
                    as a clean indented tree (Task-style) rather than 50 flat rows */}
                {depth > 0 ? (
                  <span className={styles.guides} aria-hidden>
                    {Array.from({ length: depth }, (_, g) => (
                      <span key={g} className={styles.guide} />
                    ))}
                  </span>
                ) : null}
                {isGroup(n) ? (
                  <button
                    type="button" className={styles.caret}
                    data-open={!collapsed.has(n.id) || undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCollapsed((c) => { const nc = new Set(c); if (nc.has(n.id)) nc.delete(n.id); else nc.add(n.id); return nc; });
                    }}
                  >
                    <Icon name="chevron-right" size={11} />
                  </button>
                ) : <span className={styles.caretSpace} />}
                <span className={styles.layerIcon}>
                  <Icon
                    name={
                      (n as SceneNode & { element?: unknown }).element ? 'diamond'
                        : isGroup(n) ? 'frame'
                          : n.type === 'image' ? 'photo'
                            : n.type === 'vignette' ? 'shape-circle'
                              : n.type === 'shape' ? ({
                                ellipse: 'shape-circle', starburst: 'shape-star', arrow: 'shape-line',
                                line: 'shape-line', polyline: 'shape-poly',
                              } as Record<string, string>)[n.style?.shapeKind || 'rect'] || 'shape-square'
                                : 'type-text'
                    }
                    size={13}
                  />
                </span>
                {renamingId === n.id ? (
                  <input
                    className={styles.renameInput}
                    defaultValue={n.name || n.role || n.type}
                    autoFocus
                    onBlur={(e) => { commit((d) => { const x = findNode(d, n.id); if (x) x.name = e.target.value || x.name; }); setRenamingId(null); }}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                ) : (
                  <span className={styles.layerName}>{n.name || n.role || n.type}</span>
                )}
                <span className={styles.layerBtns}>
                  <button
                    type="button" className={styles.microBtn} title={n.locked ? 'Unlock' : 'Lock'}
                    data-on={n.locked || undefined}
                    onClick={(e) => { e.stopPropagation(); commit((d) => { const x = findNode(d, n.id); if (x) x.locked = !x.locked; }); }}
                  >
                    <Icon name={n.locked ? 'lock' : 'unlock'} size={13} />
                  </button>
                  <button
                    type="button" className={styles.microBtn} title={n.hidden ? 'Show' : 'Hide'}
                    data-on={n.hidden || undefined}
                    onClick={(e) => { e.stopPropagation(); commit((d) => { const x = findNode(d, n.id); if (x) x.hidden = !x.hidden; }); }}
                  >
                    <Icon name={n.hidden ? 'eye-off' : 'eye'} size={13} />
                  </button>
                </span>
              </div>
            ))}
          </div>
          <div className={styles.layerFooter}>
            <button type="button" className={styles.ghostBtn} onClick={groupSelection} disabled={selectedIds.length < 2} title="Group selection (⌘G)">Group</button>
            <button type="button" className={styles.ghostBtn} onClick={ungroupSelection} disabled={!selected || !isGroup(selected)} title="Ungroup (⌘⇧G)">Ungroup</button>
          </div>

          {/* ── one-click archetype presets (a preset is a whole ad) ── */}
          <PresetPicker
            doc={doc}
            brandKit={brandKit}
            onInsert={insertPreset}
            nearEmpty={!doc.layers.some((l) => isGroup(l) || (l as Layer).role !== 'base')}
          />

          {/* ── compact elements browser: one row + searchable popover (Layers keeps the space) ── */}
          <div className={styles.elementsRow} ref={elementsWrapRef}>
            <button
              type="button" className={styles.elementsTrigger}
              data-active={elementsOpen || undefined}
              title="Insert a parametric element (badge, price, chart, list …)"
              onClick={() => { setElementsOpen((v) => !v); setElemHi(0); }}
            >
              <Icon name="diamond" size={12} />
              Elements
              <span className={styles.elementsCount}>{CANONICAL_ELEMENTS.length + savedElements.length}</span>
              <Icon name="chevron-down" size={11} />
            </button>
            {elementsOpen ? (
              <div className={styles.elementsPop}>
                <div className={styles.elementsPopHead}>
                  <input
                    className={styles.elementsSearch}
                    placeholder="Search elements…"
                    value={elemQuery}
                    autoFocus
                    spellCheck={false}
                    onChange={(e) => { setElemQuery(e.target.value); setElemHi(0); }}
                    onKeyDown={onPopKeyDown}
                  />
                  <select
                    className={styles.elementsCatSelect}
                    value={elemCat}
                    onChange={(e) => { setElemCat(e.target.value); setElemHi(0); }}
                    aria-label="Element category"
                  >
                    {['All', ...ELEMENT_CATEGORIES, ...(savedElements.length ? ['Saved'] : [])].map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div className={styles.elementsPopBody}>
                  {(elemCat === 'All' ? ELEMENT_CATEGORIES : [elemCat]).map((cat) => {
                    const els = filteredElements.filter((el) => el.category === cat);
                    if (!els.length) return null;
                    return (
                      <div key={cat} className={styles.elementCat}>
                        <span className={styles.elementCatLabel}>{cat}</span>
                        <div className={styles.elementList}>
                          {els.map((el) => (
                            <button key={el.id} type="button" className={styles.elementRow} title={el.hint}
                              data-hi={(hiIndex >= 0 && popItems[hiIndex]?.key === `lib:${el.id}`) || undefined}
                              onClick={() => { insertLayers(buildElement(el.id, doc, undefined, brandKit)); setElementsOpen(false); }}>
                              <span className={styles.elementName}>{el.name}</span>
                              <span className={styles.elementHint}>{el.hint}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {filteredSaved.length ? (
                    <div className={styles.elementCat}>
                      <span className={styles.elementCatLabel}>Saved</span>
                      <div className={styles.elementList}>
                        {filteredSaved.map((el) => (
                          <button key={el.id} type="button" className={styles.elementRow} title="Saved element"
                            data-hi={(hiIndex >= 0 && popItems[hiIndex]?.key === `saved:${el.id}`) || undefined}
                            onClick={() => {
                              insertLayers(el.layers.map((l) => ({ ...JSON.parse(JSON.stringify(l)), id: layerId(l.role || l.type) })));
                              setElementsOpen(false);
                            }}>
                            <span className={styles.elementName}>★ {el.name}</span>
                            <span className={styles.elementHint}>Saved element</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {!filteredElements.length && !filteredSaved.length ? (
                    <p className={styles.hint}>No elements match “{elemQuery}”.</p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
          <input
            ref={imageFileInput} type="file" accept="image/*" hidden
            onChange={(e) => { onImageFile(e.target.files?.[0] || null); e.target.value = ''; }}
          />
        </aside>

        {/* ── center: reference side-by-side + stage ── */}
        <div className={styles.center}>
          {doc.reference && underlayMode === 'side' ? (
            <div className={styles.sidePanel}>
              <div className={styles.sideHead}>
                <span className={styles.sideTitle} title={doc.reference.label || 'Reference'}>
                  Reference
                </span>
                <button
                  type="button" className={styles.sideClose}
                  title="Hide reference panel" aria-label="Hide reference panel"
                  onClick={() => setUnderlayMode('off')}
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
              <div className={styles.sideImgWrap}>
                <img src={doc.reference.url} alt="Reference" />
              </div>
              <span className={styles.sideLabel} title={doc.reference.label || 'Reference'}>{doc.reference.label || 'Reference'}</span>
            </div>
          ) : null}
          <div
            className={styles.stageWrap}
            data-fit={zoom === 'fit' || undefined}
            data-locked={agentBusy || undefined}
          >
            {agentBusy ? (
              <div className={styles.agentOverlay}>
                <span className={styles.agentPill}>
                  <WorkingIndicator label={agentStepLabel} tone="active" />
                </span>
              </div>
            ) : null}
            <Stage
              doc={doc}
              selectedIds={selectedIds}
              enteredGroupId={enteredGroupId}
              zoom={zoom}
              underlay={underlay}
              xray={xray}
              flashes={agentFlashes}
              locked={agentBusy}
              onSelect={(ids) => setSelectedIds(ids)}
              onEnterGroup={setEnteredGroupId}
              onZoom={(z) => setZoom(z)}
              onChange={onStreamChange}
            />
            {note ? <div className={styles.note}>{note}</div> : null}
          </div>
        </div>

        {/* ── right: tabbed panel — Design (inspector) | Agent (chat) ── */}
        <aside className={styles.right} data-tab={rightTab}>
          <div className={styles.tabBar} role="tablist">
            <button
              type="button" role="tab" className={styles.tabBtn}
              aria-selected={rightTab === 'design'}
              data-active={rightTab === 'design' || undefined}
              onClick={() => setRightTab('design')}
            >
              Design
            </button>
            <button
              type="button" role="tab" className={styles.tabBtn}
              aria-selected={rightTab === 'agent'}
              data-active={rightTab === 'agent' || undefined}
              onClick={() => setRightTab('agent')}
            >
              <Icon name="sparkles" size={11} /> Agent
            </button>
          </div>

          {rightTab === 'agent' ? (
            <AgentPanel
              docId={doc.id}
              ensureSaved={() => save(true)}
              onApply={applyAgentDoc}
              onRunStart={() => { setRightTab('agent'); setAgentBusy(true); }}
              onRunEnd={() => setAgentBusy(false)}
              onUndoRun={undo}
              flash={flash}
              brand={kitBrand}
              selection={selectedIds
                .map((id) => {
                  const n = findNode(doc, id);
                  return n ? { id, name: n.name || n.role || n.type } : null;
                })
                .filter((s): s is { id: string; name: string } => s !== null)}
            />
          ) : (
            <div className={styles.designTab}>
          {/* element instance — auto param form at the very top */}
          {instNode && elInst && elDef ? (
            <>
              <p className={`eyebrow ${styles.panelLabel}`}>Element · {elDef.name}</p>
              <ParamForm
                key={`${instNode.id}:${JSON.stringify(elInst.params)}`}
                def={elDef}
                params={elInst.params as Record<string, ParamValue>}
                brandColors={brandKit.colors}
                onChange={applyParamPatch}
              />
            </>
          ) : null}

          {/* brief link */}
          <p className={`eyebrow ${styles.panelLabel}`}>Brief link</p>
          <div className={styles.linkRow}>
            <select
              className={styles.select}
              value={link?.ad || ''}
              onChange={(e) => setLink(e.target.value ? { ad: e.target.value, variation: undefined } : null)}
            >
              <option value="">Not linked</option>
              {(linkBatch?.ads || []).map((a) => (
                <option key={a.id} value={a.id}>{a.title || a.id}</option>
              ))}
            </select>
            {link?.ad ? (
              <select
                className={styles.select}
                value={link.variation || ''}
                onChange={(e) => setLink({ variation: e.target.value || undefined })}
              >
                <option value="">variation…</option>
                {(linkBatch?.ads?.find((a) => a.id === link.ad)?.variations || []).map((v) => (
                  <option key={v.id} value={v.id}>{v.label || v.id}</option>
                ))}
              </select>
            ) : null}
          </div>
          {link?.ad && linkedCopy.length ? (
            <div className={styles.linkPreview}>
              {linkedCopy.slice(0, 2).map((c) => (
                <span key={c.label} className={styles.linkCopyLine} title={c.text}>
                  <b>{c.label}:</b> {c.text.slice(0, 70)}{c.text.length > 70 ? '…' : ''}
                </span>
              ))}
              <button
                type="button" className={styles.fillBtn}
                title="headline ← ad title, caption/subhead ← variation copy — one click populates the comp"
                onClick={() => commit((d) => {
                  const title = linkedCopy.find((c) => c.label === 'Ad title')?.text;
                  const copyTx = linkedCopy.find((c) => c.label === 'Variation copy')?.text;
                  for (const l of leaves(d.layers, true)) {
                    if (l.role === 'headline' && title) l.text = title;
                    if ((l.role === 'caption' || l.role === 'subhead') && copyTx) l.text = copyTx;
                  }
                })}
              >
                Fill all text from brief
              </button>
            </div>
          ) : null}
          {selectedLeaf && selectedLeaf.type !== 'image' && selectedLeaf.type !== 'shape' && linkedCopy.length ? (
            <div className={styles.fillRow}>
              {linkedCopy.map((c) => (
                <button key={c.label} type="button" className={styles.fillBtn} title={c.text}
                  onClick={() => mutateSelected((l) => { l.text = c.text; })}>
                  Fill: {c.label}
                </button>
              ))}
            </div>
          ) : null}

          {/* ── selection inspector ── */}
          <p className={`eyebrow ${styles.panelLabel}`}>
            {selected ? (selected.name || selected.role || selected.type) : selectedIds.length > 1 ? `${selectedIds.length} selected` : 'Nothing selected'}
          </p>

          {selectedIds.length >= 1 ? (
            <div className={styles.section}>
              <div className={styles.alignRow} title={selectedIds.length >= 2 ? 'Align to selection' : 'Align to canvas'}>
                {([['l', '⇤'], ['c', '↔'], ['r', '⇥'], ['t', '⤒'], ['m', '↕'], ['b', '⤓']] as const).map(([dir, glyph]) => (
                  <button key={dir} type="button" className={styles.alignBtn}
                    title={{ l: 'Align left', c: 'Center horizontally', r: 'Align right', t: 'Align top', m: 'Center vertically', b: 'Align bottom' }[dir]}
                    onClick={() => alignSelected(dir)}>
                    {glyph}
                  </button>
                ))}
                {selectedIds.length >= 3 ? (
                  <>
                    <button type="button" className={styles.alignBtn} title="Distribute horizontally (equal gaps)"
                      onClick={() => distributeSelected('h')}>⇹</button>
                    <button type="button" className={styles.alignBtn} title="Distribute vertically (equal gaps)"
                      onClick={() => distributeSelected('v')}>⇳</button>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}

          {selected ? (
            <div className={styles.props}>
              {/* Position */}
              <div className={styles.sectionTitle}>Position</div>
              <div className={styles.numGrid}>
                <NumInput label="X" value={selected.box.x} onLive={(v) => setPos('x', v)} onDone={(v) => setPosDone('x', v)} />
                <NumInput label="Y" value={selected.box.y} onLive={(v) => setPos('y', v)} onDone={(v) => setPosDone('y', v)} />
                <NumInput label="W" value={selected.box.w} min={1} onLive={(v) => setPos('w', v)} onDone={(v) => setPosDone('w', v)} />
                <NumInput
                  label="H" value={selected.box.h} min={1}
                  auto={!!selectedLeaf?.autoH}
                  onLive={(v) => setPos('h', v)} onDone={(v) => setPosDone('h', v)}
                />
              </div>
              {selectedLeaf ? (
                <div className={styles.numGrid}>
                  <NumInput label="ROT" value={selectedLeaf.rotation || 0} step={1} min={-180} max={180}
                    onLive={(v) => mutateSelected((l) => { l.rotation = v || undefined; }, true)}
                    onDone={(v) => mutateSelected((l) => { l.rotation = v || undefined; })} />
                </div>
              ) : null}

              {selectedLeaf?.type === 'image' ? (
                <div className={styles.rowSplit}>
                  <button type="button" className={styles.ghostBtn}
                    onClick={() => { imageFileTarget.current = selectedLeaf.id; imageFileInput.current?.click(); }}>
                    Replace image…
                  </button>
                  <button type="button" className={styles.pillToggle}
                    data-active={(selectedLeaf.fit || 'cover') === 'contain' || undefined}
                    title="cover fills the box; contain fits the whole image"
                    onClick={() => mutateSelected((l) => { l.fit = (l.fit || 'cover') === 'cover' ? 'contain' : 'cover'; })}>
                    {(selectedLeaf.fit || 'cover') === 'contain' ? 'contain' : 'cover'}
                  </button>
                  <button type="button" className={styles.pillToggle}
                    data-active={(selectedLeaf.style?.shapeKind || 'rect') === 'ellipse' || undefined}
                    title="Circle crop"
                    onClick={() => setStyle({ shapeKind: (selectedLeaf.style?.shapeKind || 'rect') === 'ellipse' ? 'rect' : 'ellipse' })}>
                    ◯
                  </button>
                </div>
              ) : null}

              {selectedLeaf?.type === 'shape' ? (
                <>
                  <div className={styles.sectionTitle}>Shape</div>
                  <div className={styles.rowSplit}>
                    <div className={styles.alignRow}>
                      {(['rect', 'ellipse', 'starburst', 'arrow', 'line'] as const).map((k) => (
                        <button key={k} type="button" className={styles.alignBtn}
                          data-active={(selectedLeaf.style?.shapeKind || 'rect') === k || undefined}
                          onClick={() => setStyle({ shapeKind: k })}>
                          {k === 'rect' ? '▭' : k === 'ellipse' ? '◯' : k === 'starburst' ? '✹' : k === 'arrow' ? '↗' : '╱'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {(selectedLeaf.style?.shapeKind === 'starburst') ? (
                    <div className={styles.numGrid}>
                      <NumInput label="SPIKES" value={selectedLeaf.style?.spikes ?? 12} min={6} max={40}
                        onLive={(v) => setStyle({ spikes: v }, true)} onDone={(v) => setStyle({ spikes: v })} />
                    </div>
                  ) : null}
                  {(selectedLeaf.style?.shapeKind === 'arrow' || selectedLeaf.style?.shapeKind === 'line') ? (
                    <button type="button" className={styles.pillToggle}
                      data-active={selectedLeaf.style?.flipDiag || undefined}
                      title="Mirror the diagonal (↘ vs ↗)"
                      onClick={() => setStyle({ flipDiag: !selectedLeaf.style?.flipDiag })}>
                      flip ↔
                    </button>
                  ) : null}
                </>
              ) : null}

              {selectedLeaf && (selectedLeaf.type === 'text' || selectedLeaf.type === 'badge' || selectedLeaf.type === 'button') ? (
                <>
                  <div className={styles.sectionTitle}>Text</div>
                  <textarea
                    className={styles.textInput}
                    value={selectedLeaf.text || ''}
                    rows={2}
                    spellCheck={false}
                    onChange={(e) => mutateSelected((l) => { l.text = e.target.value; })}
                  />
                  <div className={styles.numGrid}>
                    <NumInput label="SIZE" value={selectedLeaf.style?.fontSize || 40} min={6}
                      onLive={(v) => setStyle({ fontSize: v }, true)} onDone={(v) => setStyle({ fontSize: v })} />
                    <NumInput label="WGHT" value={selectedLeaf.style?.fontWeight || 600} step={100} min={100} max={900}
                      onLive={(v) => setStyle({ fontWeight: v }, true)} onDone={(v) => setStyle({ fontWeight: v })} />
                    <NumInput label="LH" value={selectedLeaf.style?.lineHeight || 1.2} step={0.05} min={0.7} max={3}
                      onLive={(v) => setStyle({ lineHeight: v }, true)} onDone={(v) => setStyle({ lineHeight: v })} />
                    <NumInput label="TRACK" value={selectedLeaf.style?.letterSpacing || 0} step={0.5}
                      onLive={(v) => setStyle({ letterSpacing: v }, true)} onDone={(v) => setStyle({ letterSpacing: v })} />
                  </div>
                  <div className={styles.rowSplit}>
                    <div className={styles.alignRow}>
                      {(['left', 'center', 'right'] as const).map((a) => (
                        <button key={a} type="button" className={styles.alignBtn}
                          data-active={(selectedLeaf.style?.align || 'left') === a || undefined}
                          onClick={() => setStyle({ align: a })}>
                          {a === 'left' ? '⟵' : a === 'center' ? '⟷' : '⟶'}
                        </button>
                      ))}
                    </div>
                    <button type="button" className={styles.pillToggle}
                      data-active={selectedLeaf.style?.uppercase || undefined}
                      onClick={() => setStyle({ uppercase: !selectedLeaf.style?.uppercase })}>
                      AA
                    </button>
                    <button type="button" className={styles.pillToggle}
                      data-active={selectedLeaf.style?.strikethrough || undefined}
                      title="Strikethrough (old price)"
                      onClick={() => setStyle({ strikethrough: !selectedLeaf.style?.strikethrough })}>
                      <s>S</s>
                    </button>
                    <button type="button" className={styles.pillToggle}
                      data-active={selectedLeaf.autoH || undefined}
                      title="Auto height — the box hugs the text"
                      onClick={() => mutateSelected((l) => { l.autoH = !l.autoH; })}>
                      ↕A
                    </button>
                  </div>
                  <input
                    className={styles.fontInput}
                    placeholder={brandKit.fonts[0] ? `Font (brand: ${brandKit.fonts.join(', ')})` : 'Font family (optional)'}
                    value={selectedLeaf.style?.fontFamily || ''}
                    spellCheck={false}
                    list="ng-font-options"
                    onChange={(e) => setStyle({ fontFamily: e.target.value || undefined })}
                  />
                  <datalist id="ng-font-options">
                    {fontOptions.map((f) => <option key={f} value={f} />)}
                  </datalist>
                  {!(selectedLeaf as Layer & { sizeLocked?: boolean }).sizeLocked ? (
                    <button
                      type="button" className={styles.ghostBtnWide}
                      data-active={selectedLeaf.style?.pill || undefined}
                      title="Instagram-caption style — every wrapped line hugs its own rounded background"
                      onClick={() => {
                        const on = !selectedLeaf.style?.pill;
                        // OFF must RESET the pill chrome — keeping background/padding behind
                        // was the "turning pills off doesn't reset" bug.
                        setStyle(on
                          ? { pill: true, background: selectedLeaf.style?.background || '#000000' }
                          : { pill: false, background: undefined, padding: undefined });
                      }}
                    >
                      {selectedLeaf.style?.pill ? 'IG caption pills · on' : 'IG caption pills'}
                    </button>
                  ) : (
                    <p className={styles.hint}>Element-built text — pill &amp; chrome live in the element params above.</p>
                  )}
                </>
              ) : null}

              {selectedLeaf && selectedLeaf.type !== 'image' ? (
                <>
                  <div className={styles.sectionTitle}>Fill</div>
                  <div className={styles.rowSplit}>
                    {(['none', 'solid', 'gradient'] as const).map((m) => (
                      <button key={m} type="button" className={styles.alignBtn}
                        data-active={fillMode === m || undefined}
                        onClick={() => {
                          if (m === 'none') setStyle({ background: undefined, gradient: null });
                          else if (m === 'solid') setStyle({ background: selectedLeaf.style?.background || '#000000', gradient: null });
                          else setStyle({
                            gradient: selGradient || {
                              type: 'linear', angle: 180,
                              stops: [
                                { color: selectedLeaf.style?.background || '#000000', pos: 0 },
                                { color: 'transparent', pos: 1 },
                              ],
                            },
                          });
                        }}>
                        {m}
                      </button>
                    ))}
                  </div>
                  {brandKit.colors.length || kitBrand ? (
                    <div className={styles.swatchRow}>
                      {brandKit.colors.map((c) => (
                        <button
                          key={c} type="button" className={styles.swatch} style={{ background: c }}
                          title={`${c} — click: fill · ⌥click: text color`}
                          onClick={(e) => (e.altKey ? setStyle({ color: c }) : setStyle({ background: c, gradient: null }))}
                        />
                      ))}
                      {selectedLeaf.style?.background && !brandKit.colors.includes(selectedLeaf.style.background) ? (
                        <button type="button" className={styles.swatchAdd} title="Save this fill to the brand colors"
                          onClick={() => addBrandColor(selectedLeaf.style!.background!)}>
                          +
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {fillMode === 'solid' ? (
                    <div className={styles.colorRow}>
                      {selectedLeaf.type !== 'shape' && selectedLeaf.type !== 'vignette' ? (
                        <label className={styles.colorField}><span>Text</span>
                          <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(selectedLeaf.style?.color || '') ? selectedLeaf.style!.color! : '#ffffff'}
                            onChange={(e) => setStyle({ color: e.target.value })} />
                        </label>
                      ) : null}
                      <label className={styles.colorField}><span>Fill</span>
                        <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(selectedLeaf.style?.background || '') ? selectedLeaf.style!.background! : '#000000'}
                          onChange={(e) => setStyle({ background: e.target.value })} />
                      </label>
                      <NumInput label="RADIUS" value={selectedLeaf.style?.radius || 0} min={0}
                        onLive={(v) => setStyle({ radius: v }, true)} onDone={(v) => setStyle({ radius: v })} />
                      <NumInput label="PAD" value={selectedLeaf.style?.padding || 0} min={0}
                        onLive={(v) => setStyle({ padding: v }, true)} onDone={(v) => setStyle({ padding: v })} />
                    </div>
                  ) : null}
                  {fillMode === 'gradient' && selGradient ? (
                    <div className={styles.gradientEditor}>
                      <div className={styles.rowSplit}>
                        <button type="button" className={styles.alignBtn}
                          data-active={selGradient.type === 'linear' || undefined}
                          onClick={() => setStyle({ gradient: { ...selGradient, type: 'linear' } })}>linear</button>
                        <button type="button" className={styles.alignBtn}
                          data-active={selGradient.type === 'radial' || undefined}
                          onClick={() => setStyle({ gradient: { ...selGradient, type: 'radial' } })}>radial</button>
                        {selGradient.type === 'linear' ? (
                          <NumInput label="ANGLE" value={selGradient.angle ?? 0} step={5} min={0} max={360}
                            onLive={(v) => setStyle({ gradient: { ...selGradient, angle: v } }, true)}
                            onDone={(v) => setStyle({ gradient: { ...selGradient, angle: v } })} />
                        ) : null}
                      </div>
                      {selGradient.stops.map((st, i) => (
                        <div key={i} className={styles.stopRow}>
                          <input type="color"
                            value={/^#[0-9a-fA-F]{6}$/.test(st.color) ? st.color : '#000000'}
                            onChange={(e) => {
                              const stops = selGradient.stops.map((x, j) => j === i ? { ...x, color: e.target.value } : x);
                              setStyle({ gradient: { ...selGradient, stops } });
                            }} />
                          <input type="range" min={0} max={100} value={Math.round(st.pos * 100)}
                            onChange={(e) => {
                              const stops = selGradient.stops.map((x, j) => j === i ? { ...x, pos: Number(e.target.value) / 100 } : x);
                              setStyle({ gradient: { ...selGradient, stops } });
                            }} />
                          <button type="button" className={styles.microBtn} disabled={selGradient.stops.length <= 2}
                            onClick={() => setStyle({ gradient: { ...selGradient, stops: selGradient.stops.filter((_, j) => j !== i) } })}>
                            <Icon name="x" size={11} />
                          </button>
                        </div>
                      ))}
                      {selGradient.stops.length < 4 ? (
                        <button type="button" className={styles.ghostBtnWide}
                          onClick={() => setStyle({ gradient: { ...selGradient, stops: [...selGradient.stops, { color: '#ffffff', pos: 1 }] } })}>
                          + stop
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : null}

              {/* Group: clip toggle */}
              {selected && isGroup(selected) ? (
                <div className={styles.rowSplit}>
                  <button type="button" className={styles.pillToggle}
                    data-active={(selected as GroupNode).clip || undefined}
                    title="Clip content — children render cropped to this frame"
                    onClick={() => commit((d) => {
                      const g = findNode(d, selected.id);
                      if (g && isGroup(g)) g.clip = !g.clip;
                    })}>
                    Clip content
                  </button>
                  {(selected as GroupNode).clip ? (
                    <NumInput label="RADIUS" value={(selected as GroupNode).style?.radius || 0} min={0}
                      onLive={(v) => onStreamChange((d) => { const g = findNode(d, selected.id); if (g && isGroup(g)) g.style = { ...g.style, radius: v || undefined }; }, false)}
                      onDone={(v) => onStreamChange((d) => { const g = findNode(d, selected.id); if (g && isGroup(g)) g.style = { ...g.style, radius: v || undefined }; }, true)} />
                  ) : null}
                </div>
              ) : null}

              {/* Effects */}
              <div className={styles.sectionTitle}>Effects</div>
              {selectedLeaf ? (
                <div className={styles.rowSplit}>
                  <select
                    className={styles.select}
                    value={selectedLeaf.style?.blend || 'normal'}
                    title="Blend mode"
                    onChange={(e) => setStyle({ blend: e.target.value === 'normal' ? undefined : e.target.value as LayerStyle['blend'] })}
                  >
                    {(['normal', 'multiply', 'screen', 'overlay'] as const).map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                  <NumInput label="BLUR" value={selectedLeaf.style?.blur || 0} min={0} max={120}
                    onLive={(v) => setStyle({ blur: v || undefined }, true)}
                    onDone={(v) => setStyle({ blur: v || undefined })} />
                </div>
              ) : null}
              {selectedLeaf && findParentGroup(doc, selectedLeaf.id) ? (
                <button type="button" className={styles.pillToggle}
                  data-active={selectedLeaf.isMask || undefined}
                  title="Use this layer's shape as a mask for its group siblings"
                  onClick={() => mutateSelected((l) => { l.isMask = !l.isMask; })}>
                  Use as mask
                </button>
              ) : null}
              <div className={styles.effectRow}>
                <span className={styles.effectLabel}>Opacity</span>
                <input type="range" min={0} max={100}
                  value={Math.round(((isGroup(selected) ? selected.style?.opacity : selected.style?.opacity) ?? 1) * 100)}
                  onChange={(e) => {
                    const v = Number(e.target.value) / 100;
                    onStreamChange((d) => {
                      const n = findNode(d, selected.id);
                      if (n) n.style = { ...n.style, opacity: v };
                    }, false);
                  }}
                  onPointerUp={() => onStreamChange(() => {}, true)}
                />
              </div>
              {selectedLeaf && selectedLeaf.type !== 'image' && selectedLeaf.type !== 'vignette' ? (
                <div className={styles.rowSplit}>
                  <button type="button" className={styles.pillToggle}
                    data-active={selectedLeaf.style?.shadow || undefined}
                    title="Soft drop shadow"
                    onClick={() => setStyle({ shadow: !selectedLeaf.style?.shadow })}>
                    Shadow
                  </button>
                  <label className={styles.colorField}><span>Stroke</span>
                    <input type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(selectedLeaf.style?.stroke?.color || '') ? selectedLeaf.style!.stroke!.color : '#ffffff'}
                      onChange={(e) => setStyle({ stroke: { color: e.target.value, width: selectedLeaf.style?.stroke?.width || 2 } })} />
                  </label>
                  <NumInput label="W" value={selectedLeaf.style?.stroke?.width || 0} min={0} max={40}
                    onLive={(v) => setStyle({ stroke: v > 0 ? { color: selectedLeaf.style?.stroke?.color || '#ffffff', width: v } : undefined }, true)}
                    onDone={(v) => setStyle({ stroke: v > 0 ? { color: selectedLeaf.style?.stroke?.color || '#ffffff', width: v } : undefined })} />
                </div>
              ) : null}
              {selectedLeaf?.type === 'vignette' ? (
                <>
                  <div className={styles.effectRow}>
                    <span className={styles.effectLabel}>Strength</span>
                    <input type="range" min={5} max={100}
                      value={Math.round((selectedLeaf.style?.vignette?.strength ?? 0.7) * 100)}
                      onChange={(e) => setStyle({ vignette: { strength: Number(e.target.value) / 100, size: selectedLeaf.style?.vignette?.size ?? 0.45 } }, true)}
                      onPointerUp={() => onStreamChange(() => {}, true)}
                    />
                  </div>
                  <div className={styles.effectRow}>
                    <span className={styles.effectLabel}>Size</span>
                    <input type="range" min={0} max={90}
                      value={Math.round((selectedLeaf.style?.vignette?.size ?? 0.45) * 100)}
                      onChange={(e) => setStyle({ vignette: { strength: selectedLeaf.style?.vignette?.strength ?? 0.7, size: Number(e.target.value) / 100 } }, true)}
                      onPointerUp={() => onStreamChange(() => {}, true)}
                    />
                  </div>
                  <div className={styles.colorRow}>
                    <label className={styles.colorField}><span>Color</span>
                      <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(selectedLeaf.style?.background || '') ? selectedLeaf.style!.background! : '#000000'}
                        onChange={(e) => setStyle({ background: e.target.value })} />
                    </label>
                  </div>
                </>
              ) : null}
              {selectedLeaf?.type === 'shape' ? (
                <div className={styles.alignRow}>
                  {([null, 'to-top', 'to-bottom'] as const).map((g) => (
                    <button key={String(g)} type="button" className={styles.alignBtn}
                      data-active={(typeof selectedLeaf.style?.gradient === 'string' ? selectedLeaf.style.gradient : null) === g || undefined}
                      onClick={() => setStyle({ gradient: g })}>
                      {g === null ? 'solid' : g === 'to-top' ? 'fade ↑' : 'fade ↓'}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className={styles.hint}>
              Click selects · double-click enters a group · shift-click multi-selects · drag empty canvas for marquee.
              ⌘G groups, ⌘⇧G ungroups, ⌘D duplicates, arrows nudge, ⌘Z undoes, ⌘-wheel zooms.
            </p>
          )}

          {/* Brand kit lives at the BOTTOM of the Design tab (v2) — it crowded the agent chat. */}
          <BrandKitPanel brand={kitBrand} flash={flash} />

            </div>
          )}
        </aside>
      </div>
    </div>
  );

  // Position setters work on the single selected node (group OR leaf). Group x/y translates
  // descendants; group w/h scales them proportionally, like the canvas handles.
  function applyPos(k: 'x' | 'y' | 'w' | 'h', v: number, live: boolean) {
    if (!selected) return;
    const id = selected.id;
    onStreamChange((d) => {
      const n = findNode(d, id);
      if (!n) return;
      if (isGroup(n)) {
        const to = { ...n.box, [k]: Math.round(v) };
        if (k === 'x' || k === 'y') {
          const dx = to.x - n.box.x;
          const dy = to.y - n.box.y;
          walk([n], (x) => { x.box = { ...x.box, x: x.box.x + dx, y: x.box.y + dy }; });
        } else {
          scaleNodeInto(n, { ...n.box }, to);
        }
      } else {
        n.box = { ...n.box, [k]: Math.round(v) };
      }
    }, !live);
  }
  function setPos(k: 'x' | 'y' | 'w' | 'h', v: number) { applyPos(k, v, true); }
  function setPosDone(k: 'x' | 'y' | 'w' | 'h', v: number) { applyPos(k, v, false); }
}
