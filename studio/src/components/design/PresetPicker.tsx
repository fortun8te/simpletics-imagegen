// PresetPicker.tsx — ONE-CLICK archetype presets for the Design editor.
//
// A preset is a WHOLE ad (story-native, X-post, before/after, us-vs-them, IG-DM, offer-hero,
// apple-notes, stat-chart, …) — not furniture like Elements. Before this, dropping an archetype
// meant typing a chat instruction to the agent. This is a big-tappable picker: one click builds
// the template at the doc's current canvas and drops it in as a single grouped, undoable step.
//
// Interaction is modeled 1:1 on the Editor's Elements popover (trigger row → searchable popover,
// outside-click / Escape to close, arrow-key highlight). The list is driven ENTIRELY by whatever
// `TEMPLATES` contains — the parallel worker adding apple-notes / stat-chart (and grouping the
// build output) needs no change here; we map over the registry.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Icon } from '../Icon';
import type { DesignDoc, SceneNode } from '../../lib/sceneGraph';
import styles from './PresetPicker.module.css';

// templates.mjs is plain shared JS (Node + browser) owned by another worker and has no .d.mts
// yet, so the named import is untyped — pin the shapes we use right here.
// @ts-expect-error — untyped shared module (lib/templates.mjs); typed via the casts below.
import { TEMPLATES as TEMPLATES_RAW, buildTemplate as buildTemplate_RAW } from '../../../lib/templates.mjs';

export interface TemplateDef {
  id: string;
  name: string;
  hint: string;
  params: Record<string, unknown>;
  /** optional grouping label the parallel worker may add (e.g. "Social" / "Chart") */
  group?: string;
}

const TEMPLATES = (TEMPLATES_RAW as TemplateDef[]) || [];
const buildTemplate = buildTemplate_RAW as (
  id: string,
  doc: DesignDoc,
  params?: Record<string, unknown>,
  kit?: unknown,
) => { def: TemplateDef | null; layers: SceneNode[] };

/** Tiny per-archetype glyph — cheap visual cue so rows aren't a wall of text. Falls back to a
 *  generic frame glyph for any id we don't recognise (future templates render fine untouched). */
const GLYPH: Record<string, string> = {
  'story-native': 'photo',
  'x-post-ad': 'diamond',
  'before-after': 'columns',
  comparison: 'columns',
  'ig-dm': 'diamond',
  'offer-hero': 'sparkles',
  'apple-notes': 'type-text',
  'stat-chart': 'table',
};

interface PresetPickerProps {
  doc: DesignDoc;
  brandKit: { colors: string[]; fonts: string[]; notes: string };
  /** Insert the built preset (already grouped into one node) — commits as ONE undo step and
   *  selects the group. `replace` drops existing non-base layers first. */
  onInsert: (built: { layers: SceneNode[]; name: string }, replace: boolean) => void;
  /** True when the comp is empty save for the base layer — replace is then the sensible default. */
  nearEmpty: boolean;
}

export default function PresetPicker({ doc, brandKit, onInsert, nearEmpty }: PresetPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  // keep the latest doc/kit without re-subscribing the picker — build at click time
  const docRef = useRef(doc);
  docRef.current = doc;
  const kitRef = useRef(brandKit);
  kitRef.current = brandKit;

  const q = query.trim().toLowerCase();
  const items = useMemo(
    () =>
      TEMPLATES.filter(
        (t) =>
          !q ||
          t.name.toLowerCase().includes(q) ||
          t.hint.toLowerCase().includes(q) ||
          t.id.toLowerCase().includes(q),
      ),
    [q],
  );

  // grouped for render (a template may declare .group; ungrouped ones fall under "Archetypes")
  const groups = useMemo(() => {
    const by = new Map<string, TemplateDef[]>();
    for (const t of items) {
      const key = t.group || 'Archetypes';
      (by.get(key) || by.set(key, []).get(key)!).push(t);
    }
    return [...by.entries()];
  }, [items]);

  // flat in-render order — drives arrow-key navigation (mirrors the Elements popover)
  const flat = useMemo(() => groups.flatMap(([, ts]) => ts), [groups]);
  const hiIndex = flat.length ? Math.min(hi, flat.length - 1) : -1;

  const pick = (t: TemplateDef) => {
    const built = buildTemplate(t.id, docRef.current, {}, kitRef.current);
    if (!built.layers.length) return;
    onInsert({ layers: built.layers, name: t.name }, nearEmpty);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hiIndex >= 0) pick(flat[hiIndex]);
    }
    e.stopPropagation();
  };

  // close on outside click / Escape — identical to the Elements popover
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc, true);
    };
  }, [open]);

  return (
    <div className={styles.row} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        data-active={open || undefined}
        title="Drop a full-ad archetype — one click builds the whole layout"
        onClick={() => {
          setOpen((v) => !v);
          setHi(0);
        }}
      >
        <Icon name="sparkles" size={13} />
        Presets
        <span className={styles.count}>{TEMPLATES.length}</span>
        <Icon name="chevron-down" size={11} />
      </button>

      {open ? (
        <div className={styles.pop}>
          <div className={styles.popHead}>
            <input
              className={styles.search}
              placeholder="Search archetypes…"
              value={query}
              autoFocus
              spellCheck={false}
              onChange={(e) => {
                setQuery(e.target.value);
                setHi(0);
              }}
              onKeyDown={onKeyDown}
            />
            <span className={styles.mode} title={nearEmpty ? 'Empty comp — the preset replaces it' : 'Comp has content — the preset is added on top'}>
              {nearEmpty ? 'Replace' : 'Add'}
            </span>
          </div>
          <div className={styles.popBody}>
            {groups.map(([groupName, ts]) => (
              <div key={groupName} className={styles.cat}>
                {groups.length > 1 ? <span className={styles.catLabel}>{groupName}</span> : null}
                <div className={styles.list}>
                  {ts.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={styles.preset}
                      title={t.hint}
                      data-hi={(hiIndex >= 0 && flat[hiIndex]?.id === t.id) || undefined}
                      onClick={() => pick(t)}
                    >
                      <span className={styles.glyph}>
                        <Icon name={GLYPH[t.id] || 'frame'} size={15} />
                      </span>
                      <span className={styles.text}>
                        <span className={styles.name}>{t.name}</span>
                        <span className={styles.hint}>{t.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {!flat.length ? <p className={styles.empty}>No archetypes match “{query}”.</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
