// NewCompFlow.tsx — creating a comp the reference-first way, in a single step.
//
// Pick the REFERENCE — the real ad whose design you're copying: a cached TrendTrack ad
// (with its metrics), an uploaded/pasted screenshot of any ad, or none (blank). Codex vision
// extracts the overlay layout as editable layers AND the reference's own background (solid or
// gradient); the moment extraction lands the comp is created — no separate base-image step.
//
// The result is an unsaved DesignDoc handed to the Editor: reference attached (for the
// tracing-paper underlay), skeleton applied, background taken from the reference, linked to
// the current batch. Skipping the reference makes a blank white comp at a chosen canvas.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { api } from '../../api';
import {
  applySkeleton, buildBlankDoc, CANVAS_PRESETS,
  type DesignDoc, type DesignReference, type Skeleton,
} from '../../lib/sceneGraph';
import SkeletonLoader from './SkeletonLoader';
import styles from './NewCompFlow.module.css';

// ── side-by-side "building comp" scaffold ──────────────────────────────────────────────────
// The RIGHT column mirrors the reference aspect and fills with grey shimmer boxes arranged like
// an ad (hero image block, a few text lines, a CTA pill). As extraction passes report, we parse
// their granular summaries to (a) know how many layers were read and (b) reveal/settle that many
// boxes — shimmering (still reading) → solid-ish (settled). The scaffold is illustrative, not the
// real layout; visible fill-in per pass is the goal.

// A fixed slot template — enough boxes to feel like an ad. `weight` biases which settle first
// (hero + headline before the fine print), `kind` picks the visual (image block / text line / cta).
type SlotKind = 'hero' | 'line' | 'cta';
interface ScaffoldSlot { kind: SlotKind; h: number; w: string; }
const SCAFFOLD_SLOTS: ScaffoldSlot[] = [
  { kind: 'hero', h: 46, w: '100%' }, // big hero/image region (percent of panel height)
  { kind: 'line', h: 7, w: '82%' },   // headline
  { kind: 'line', h: 5, w: '68%' },   // subhead
  { kind: 'line', h: 4, w: '90%' },   // body line
  { kind: 'line', h: 4, w: '74%' },   // body line
  { kind: 'line', h: 4, w: '58%' },   // body line
  { kind: 'cta',  h: 9, w: '48%' },   // CTA pill
];

/**
 * Read the granular extraction summaries and derive how the scaffold should look:
 * - `revealed`   : how many slots to show as active (shimmering or settled)
 * - `settled`    : how many of those have "landed" (solid-ish, done reading)
 * - `pass`       : the current pass number (drives a subtle nudge)
 * - `archetype`  : classified archetype once known (nudges CTA emphasis)
 * - `canvasLocked` / `bgHex` : late-stage settle signals
 * Falls back to a time-independent "still warming up" state before the first parseable line.
 */
function readScaffold(steps: string[], total: number) {
  let layerCount = 0;     // best-known layer count read so far
  let pass = 1;
  let archetype: string | null = null;
  let canvasLocked = false;
  let bgHex: string | null = null;
  let done = false;

  for (const raw of steps) {
    const s = raw.toLowerCase();
    // pass number: "pass 1/2…", "refining — pass 2/3…", "reading … pass 1/2…"
    const pm = s.match(/pass (\d+)\s*[\/:]/);
    if (pm) pass = Math.max(pass, Number(pm[1]));
    // layer count: "pass 1: 8 layers · x-post", "done · 6 layers · …", "→ 6 unique"
    const lm = s.match(/(\d+)\s+layers?/);
    if (lm) layerCount = Math.max(layerCount, Number(lm[1]));
    const um = s.match(/→\s*(\d+)\s+unique/);
    if (um) layerCount = Number(um[1]); // dedup gives the authoritative final count
    // archetype: "· x-post", "· story-native", "· generic"
    const am = raw.match(/·\s*(story-native|x-post|before-after|comparison|offer-hero|ig-dm|generic)\b/i);
    if (am) archetype = am[1].toLowerCase();
    if (s.includes('canvas locked')) canvasLocked = true;
    const bm = raw.match(/#([0-9a-f]{6})\b/i);
    if (bm && (s.includes('background') || s.includes('bg') || s.includes('sampled'))) bgHex = `#${bm[1]}`;
    if (s.startsWith('done') || s.includes('skeleton saved')) done = true;
  }

  const n = SCAFFOLD_SLOTS.length;
  // How many slots are "in play". Before any layer count is known, show the hero + first couple of
  // lines warming up. Once we know the real count, clamp it into the scaffold's slot budget.
  const revealed = done
    ? n
    : layerCount > 0
      ? Math.min(n, Math.max(3, layerCount))
      : 3;
  // How many have settled (stopped shimmering). Each completed pass settles more; a final/done
  // state settles everything revealed. Canvas-lock is a late signal → settle the structural boxes.
  const passFrac = total > 1 ? Math.min(1, (pass - 1) / (total - 1)) : (layerCount > 0 ? 1 : 0);
  let settled = done ? revealed : Math.round(revealed * passFrac);
  if (canvasLocked) settled = Math.max(settled, Math.min(revealed, revealed - 1));
  if (bgHex && !done) settled = Math.max(settled, 1); // bg known → hero has a fill

  return { revealed, settled: Math.min(settled, revealed), pass, archetype, bgHex, done };
}

interface NewCompFlowProps {
  onCreated: (doc: DesignDoc) => void;
  onCancel: () => void;
  /** Start directly from a saved skeleton (gallery shortcut). */
  presetSkeleton?: Skeleton | null;
  /**
   * Pre-selected reference (drop-a-PNG-anywhere path): skips the picker and immediately
   * starts the countdown → extraction as if the user had clicked "Copy this ad's design".
   */
  autoRef?: { kind: 'upload'; ref: string; url: string; label?: string } | null;
}

// 5s pre-extraction countdown (was 10). Extraction now requires a vision endpoint (Gemma/local
// or hosted) and the backend retries several passes, so a shorter "get ready" beat is plenty —
// the real work + its live pass/retry progress plays out in the running phase below.
const COUNTDOWN_SECS = 5;
// The vision reader takes one fast pass and only refines (a 2nd pass) if the first read is weak.
// Surfaced in the skeleton loader as a cap, so the copy never implies more work than usually happens.
const VISION_PASSES = 2;

function useCachedAds() {
  const [ads, setAds] = useState<{ id: string; brand: string; hook: string | null; verdict: string | null; hasImage: boolean }[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const brands = await fetch('/api/trendtrack/cache').then((r) => r.json());
        const all: typeof ads = [];
        for (const b of brands?.brands || []) {
          const hit = await fetch(`/api/trendtrack/cache?brand=${encodeURIComponent(b.brand)}`).then((r) => r.json());
          for (const ad of hit?.ads || []) {
            all.push({ id: ad.id, brand: ad.brand, hook: ad.hook, verdict: ad.scaling_verdict, hasImage: !!ad.local_image });
          }
        }
        if (alive) setAds(all.filter((a) => a.hasImage));
      } catch { /* empty cache */ }
    })();
    return () => { alive = false; };
  }, []);
  return ads;
}

/** The reference background extraction returns on the skeleton: solid hex or a gradient. */
type RefBackground = string | { from: string; to: string; angle: number } | null | undefined;

/** Turn an extracted reference background into a buildBlankDoc base src. Defaults to white. */
function baseSrcFromBackground(bg: RefBackground): string {
  if (!bg) return 'color:#ffffff';
  if (typeof bg === 'string') return `color:${bg}`;
  return `gradient:${bg.from}|${bg.to}|${Math.round(bg.angle) || 180}`;
}

export default function NewCompFlow({ onCreated, onCancel, presetSkeleton = null, autoRef = null }: NewCompFlowProps) {
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const designEvents = useStore((s) => s.ui.designEvents);

  const [reference, setReference] = useState<DesignReference | null>(
    presetSkeleton?.sourceRef ?? (autoRef ? { kind: autoRef.kind, ref: autoRef.ref, url: autoRef.url, label: autoRef.label || 'Dropped reference' } : null),
  );
  const [skeleton, setSkeleton] = useState<Skeleton | null>(presetSkeleton);
  // Extraction lifecycle: idle → countdown (5s, cancelable, client-side only) → running
  // (skeleton loader: shimmer scaffold + live SSE steps + pass/retry progress + elapsed +
  // server-side cancel) → back to idle with a note.
  const [phase, setPhase] = useState<'idle' | 'countdown' | 'running'>('idle');
  const [countdown, setCountdown] = useState(COUNTDOWN_SECS);
  const [elapsed, setElapsed] = useState(0);
  const [extractNote, setExtractNote] = useState<string | null>(null);
  // Last extraction attempt failed → error treatment on the theater (retry from the top).
  const [failed, setFailed] = useState(false);
  const runIdRef = useRef<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  // Refs we know are cached server-side (a previous extract returned cached:true) — those
  // skip the countdown since the response is instant and free. Everything else counts down.
  const knownCached = useRef<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  // No-reference path: reveal a tiny inline canvas-preset choice instead of a base step.
  const [blankOpen, setBlankOpen] = useState(false);
  // Reference aspect ratio (w/h) — measured off the loaded <img> so the skeleton scaffold matches
  // the shape of the comp being built. Defaults to a 4:5 ad frame until the image loads.
  const [refAspect, setRefAspect] = useState(4 / 5);

  const cachedAds = useCachedAds();

  // Local search over the whole cache (0 credits). Live import is explicit + priced.
  const [query, setQuery] = useState('');
  const [searchAds, setSearchAds] = useState<typeof cachedAds | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    if (!query.trim()) { setSearchAds(null); return; }
    const t = window.setTimeout(async () => {
      const r = await api.trendtrackSearch(query.trim());
      setSearchAds(r.ads.filter((a) => a.hasImage).map((a) => ({
        id: a.id, brand: a.brand, hook: a.hook, verdict: a.scaling_verdict, hasImage: a.hasImage,
      })));
      if (r.creditsRemaining != null) setCredits(r.creditsRemaining);
    }, 250);
    return () => window.clearTimeout(t);
  }, [query]);

  const importLive = async () => {
    if (!query.trim() || importing) return;
    setImporting(true);
    try {
      const r = await api.trendtrackImport(query.trim(), 10);
      if (r.ok) {
        if (r.creditsRemaining != null) setCredits(r.creditsRemaining);
        const s = await api.trendtrackSearch(query.trim());
        setSearchAds(s.ads.filter((a) => a.hasImage).map((a) => ({
          id: a.id, brand: a.brand, hook: a.hook, verdict: a.scaling_verdict, hasImage: a.hasImage,
        })));
      }
    } finally { setImporting(false); }
  };

  // Build + hand off the comp from an extracted skeleton: the reference dictates the EXACT
  // canvas ({w,h}), the base fill comes from the reference's own detected background (solid or
  // gradient, else white), and the copied layers apply on top. No base-image picker — the
  // extraction already analyzed everything.
  const createFromSkeleton = (skel: Skeleton, ref: DesignReference | null) => {
    const bg = (skel as unknown as { background?: RefBackground }).background;
    let doc = buildBlankDoc(baseSrcFromBackground(bg), { w: skel.canvas.w, h: skel.canvas.h }, {
      name: ref?.label ? `Our ${ref.label.split('·')[0].trim()} version` : 'New comp',
      brand,
      reference: ref,
      link: brand && batch ? { brand, batch, ad: '' } : null,
    });
    doc = applySkeleton(doc, skel);
    onCreated(doc);
  };

  // No reference at all → a blank white comp at the chosen canvas preset.
  const createBlank = (canvasId: (typeof CANVAS_PRESETS)[number]['id']) => {
    const preset = CANVAS_PRESETS.find((c) => c.id === canvasId) || CANVAS_PRESETS[0];
    const doc = buildBlankDoc('color:#ffffff', { w: preset.w, h: preset.h }, {
      name: 'New comp',
      brand,
      reference: null,
      link: brand && batch ? { brand, batch, ad: '' } : null,
    });
    onCreated(doc);
  };

  // Picking a different reference abandons any countdown / in-flight extraction.
  const resetExtractState = () => {
    const id = runIdRef.current;
    runIdRef.current = null;
    if (id) void api.extractCancel(id);
    setPhase('idle');
  };

  const pickTrendtrack = (ad: { id: string; brand: string; hook: string | null }) => {
    resetExtractState();
    setReference({
      kind: 'trendtrack',
      ref: ad.id,
      url: api.trendtrackImageUrl(ad.id),
      label: `${ad.brand} · ${(ad.hook || ad.id).slice(0, 48)}`,
    });
    setSkeleton(null);
    setExtractNote(null);
    setFailed(false);
  };

  const onUpload = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const r = await api.uploadRef(String(reader.result));
      if (r.ok && r.id && r.url) {
        resetExtractState();
        setReference({ kind: 'upload', ref: r.id, url: r.url, label: file.name || 'Uploaded reference' });
        setSkeleton(null);
        setExtractNote(null);
        setFailed(false);
      }
    };
    reader.readAsDataURL(file);
  };

  // Paste-a-screenshot support while the flow is open.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      const f = item?.getAsFile();
      if (f) onUpload(f);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Actually fire the extraction (after the countdown, or immediately for known-cached refs).
  const fire = async (ref: DesignReference) => {
    const id = `ext_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    runIdRef.current = id;
    setRunId(id);
    setElapsed(0);
    setPhase('running');
    setExtractNote(null);
    setFailed(false);
    const r = await api.extractLayout({ kind: ref.kind, ref: ref.ref }, id);
    if (runIdRef.current !== id) return; // canceled or superseded — a newer flow owns the UI
    runIdRef.current = null;
    setPhase('idle');
    if (r.ok && r.skeleton) {
      if (r.cached) knownCached.current.add(ref.ref);
      // Extraction analyzed everything (layout + background) — create the comp and hand off.
      setSkeleton(r.skeleton);
      createFromSkeleton(r.skeleton, ref);
    } else if (r.canceled) {
      setSkeleton(null);
      setExtractNote('Canceled.');
    } else {
      setSkeleton(null);
      setFailed(true);
      setExtractNote(`Extraction failed (${r.error || 'unknown'}).`);
    }
  };

  // "Copy this ad's design" → start the 10s countdown (or fire straight away when we know the
  // skeleton is cached server-side — instant + free, no point counting down).
  const extract = () => {
    if (!reference || phase !== 'idle') return;
    if (knownCached.current.has(reference.ref)) { void fire(reference); return; }
    setCountdown(COUNTDOWN_SECS);
    setExtractNote(null);
    setFailed(false);
    setPhase('countdown');
  };

  // Countdown tick — fires the extraction when it hits zero.
  useEffect(() => {
    if (phase !== 'countdown') return;
    const t = window.setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          window.clearInterval(t);
          if (reference) void fire(reference);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Elapsed-seconds ticker while extraction runs.
  useEffect(() => {
    if (phase !== 'running') return;
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, [phase]);

  const cancelExtract = () => {
    if (phase === 'countdown') { setPhase('idle'); setExtractNote(null); return; }
    if (phase === 'running') {
      const id = runIdRef.current;
      runIdRef.current = null;
      setPhase('idle');
      setExtractNote('Canceled.');
      if (id) void api.extractCancel(id);
    }
  };

  // Live steps for THIS run only (the design SSE channel is shared).
  const runSteps = useMemo(
    () => (runId ? designEvents.filter((e) => e.runId === runId && e.step).map((e) => e.step!) : []),
    [designEvents, runId],
  );

  // Granular summary strings that drive the building-comp scaffold on the right.
  const runSummaries = useMemo(
    () => runSteps.map((s) => (s.summary || '').trim()).filter(Boolean),
    [runSteps],
  );
  // Parse those summaries → which shimmer boxes to reveal/settle. During countdown nothing has
  // reported yet, so the scaffold shows its "warming up" baseline (hero + first lines shimmering).
  const scaffold = useMemo(
    () => readScaffold(phase === 'running' ? runSummaries : [], VISION_PASSES),
    [runSummaries, phase],
  );

  // presetSkeleton (gallery "start from this layout" shortcut): create immediately — there's
  // no base-image step to pause on. autoRef (drop-a-PNG path): kick off the countdown.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current) return;
    if (presetSkeleton) {
      autoStarted.current = true;
      createFromSkeleton(presetSkeleton, presetSkeleton.sourceRef ?? null);
      return;
    }
    if (autoRef) {
      autoStarted.current = true;
      setCountdown(COUNTDOWN_SECS);
      setPhase('countdown');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRef, presetSkeleton]);

  // ── render — a single reference-picker step; creation happens on extraction ──
  return (
    <div className={styles.flow}>
        <div className={styles.head}>
          <div className={styles.headRow}>
            <div className={styles.headTitles}>
              <h2 className={styles.title}>Pick the reference</h2>
              <span className={styles.sub}>The ad whose design you're copying — extraction analyzes its layout and background, then builds the comp. Paste a screenshot anytime (⌘V).</span>
            </div>
            <button type="button" className={styles.ghostBtn} onClick={onCancel}>Cancel</button>
          </div>
        </div>

        <div className={styles.refActions}>
          <button type="button" className={styles.ghostBtn} onClick={() => fileInput.current?.click()}>
            Upload screenshot…
          </button>
          <input
            ref={fileInput} type="file" accept="image/*" hidden
            onChange={(e) => onUpload(e.target.files?.[0] || null)}
          />
          {blankOpen ? (
            <div className={styles.blankChoice}>
              <span className={styles.canvasLabel}>Blank</span>
              {CANVAS_PRESETS.map((c) => (
                <button
                  key={c.id} type="button" className={styles.canvasBtn}
                  onClick={() => createBlank(c.id)}
                  title={`Blank white ${c.name}`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          ) : (
            <button
              type="button" className={styles.ghostBtn}
              onClick={() => setBlankOpen(true)}
              title="No reference — blank white canvas"
            >
              Skip — start blank
            </button>
          )}
        </div>

        {reference ? (
          <div className={styles.selectedRef}>
            <div className={styles.selectedRefTop}>
              <span className={styles.selectedRefLabel}>{reference.label}</span>
              <div className={styles.selectedRefActions}>
                {phase === 'idle' ? (
                  <button type="button" className={styles.primaryBtn} onClick={extract}>
                    Copy this ad’s design
                  </button>
                ) : (
                  <button type="button" className={styles.ghostBtn} onClick={cancelExtract}>
                    Cancel
                  </button>
                )}
              </div>
            </div>

            {/* Extraction theater. While idle it's just the reference LARGE (the <img> sizes to
                its picture — no letterboxing — so overlay layers map skeleton coords as %). While
                reading (countdown + running) it splits SIDE-BY-SIDE: reference on the LEFT, the
                comp being built on the RIGHT as grey shimmer boxes that fill in per pass. */}
            {phase === 'idle' ? (
              <div className={styles.stage} data-scanning={undefined}>
                <div className={styles.stageInner}>
                  <img
                    src={reference.url}
                    alt=""
                    onLoad={(e) => {
                      const el = e.currentTarget;
                      if (el.naturalWidth && el.naturalHeight) setRefAspect(el.naturalWidth / el.naturalHeight);
                    }}
                  />
                  {failed && !skeleton ? (
                    <div className={styles.failFrame}>
                      <span className={styles.failMsg}>Extraction failed — check the vision endpoint and retry</span>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div
                className={styles.compare}
                style={{ ['--ref-aspect' as string]: String(refAspect || 4 / 5) }}
              >
                {/* LEFT — the reference, aspect-locked, contained, never overflowing. */}
                <figure className={styles.pane}>
                  <span className={styles.paneTag}>Reference</span>
                  <div className={styles.paneFrame} data-scanning>
                    <img
                      className={styles.refImg}
                      src={reference.url}
                      alt=""
                      onLoad={(e) => {
                        const el = e.currentTarget;
                        if (el.naturalWidth && el.naturalHeight) setRefAspect(el.naturalWidth / el.naturalHeight);
                      }}
                    />
                    <div className={styles.scanShade} />
                    <div className={styles.scanLine} />
                  </div>
                </figure>

                {/* RIGHT — the comp being built: grey shimmer boxes at the same aspect. Boxes
                    reveal + settle as passes report (see readScaffold). */}
                <figure className={styles.pane}>
                  <span className={styles.paneTag}>
                    {scaffold.archetype ? `Building · ${scaffold.archetype}` : 'Building comp'}
                  </span>
                  <div
                    className={styles.paneFrame}
                    data-building
                    style={scaffold.bgHex ? { background: scaffold.bgHex } : undefined}
                  >
                    <div className={styles.scaffold}>
                      {SCAFFOLD_SLOTS.map((slot, i) => {
                        const active = i < scaffold.revealed;
                        const settled = i < scaffold.settled;
                        return (
                          <div
                            key={i}
                            className={styles.slot}
                            data-kind={slot.kind}
                            data-active={active || undefined}
                            data-settled={settled || undefined}
                            style={{ height: `${slot.h}%`, width: slot.w }}
                          />
                        );
                      })}
                    </div>
                  </div>
                </figure>
              </div>
            )}

            <div className={styles.statusArea}>
              {phase === 'countdown' ? (
                <>
                  <span className={styles.extractStatus}>Reading reference in {countdown}…</span>
                  <span className={styles.extractHint}>
                    Vision reads the layout in one fast pass, refining only if the first read is weak.
                  </span>
                  <div className={styles.countdownBar}>
                    <div
                      className={styles.countdownFill}
                      style={{ width: `${((COUNTDOWN_SECS - countdown) / COUNTDOWN_SECS) * 100}%` }}
                    />
                  </div>
                </>
              ) : null}

              {phase === 'running' ? (
                <SkeletonLoader
                  steps={runSteps}
                  elapsed={elapsed}
                  aspect={refAspect}
                  totalPasses={VISION_PASSES}
                  title="Reading the reference with vision"
                />
              ) : null}

              {phase === 'idle' && extractNote ? (
                <span className={styles.extractNote} data-failed={failed || undefined}>{extractNote}</span>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className={styles.searchRow}>
          <input
            className={styles.searchInput}
            placeholder="Search cached ads (free) — brand, hook, copy…"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          {credits != null ? <span className={styles.creditChip}>{credits.toLocaleString()} credits left</span> : null}
        </div>
        {query.trim() && searchAds !== null ? (
          <button type="button" className={styles.liveSearchBtn} onClick={importLive} disabled={importing}>
            {importing ? 'Importing…' : `Search TrendTrack LIVE for “${query.trim()}” — costs ≈10 credits`}
          </button>
        ) : null}

        <p className={`eyebrow ${styles.groupLabel}`}>
          {query.trim() ? `Matches · 0 credits` : 'TrendTrack cache · 0 credits'}
        </p>
        {(searchAds ?? cachedAds).length === 0 ? (
          <p className={styles.empty}>
            {query.trim() ? 'No cached matches — use the live search above (paid) or import a brand from the Plan rail.' : 'Nothing cached yet — import a brand from the Plan rail first.'}
          </p>
        ) : (
          <div className={styles.refGrid}>
            {(searchAds ?? cachedAds).map((ad) => (
              <button
                key={ad.id} type="button" className={styles.refCell}
                data-picked={reference?.ref === ad.id || undefined}
                onClick={() => pickTrendtrack(ad)}
              >
                <img src={api.trendtrackImageUrl(ad.id)} alt="" loading="lazy" decoding="async" />
                <span className={styles.refCellLabel}>
                  <b>{ad.verdict}</b> {ad.hook || ad.id}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
}
