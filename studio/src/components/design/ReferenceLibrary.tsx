// ReferenceLibrary — an in-editor picker for the reference you want to copy. It is the design
// editor's home for the old standalone "Copy from Reference" library: the TrendTrack disk cache
// (free local search + optional paid live import) plus a screenshot upload. It is deliberately
// self-contained and READ-ONLY toward the doc — picking a reference just hands the caller a
// REFS_DIR-backed ref id + label, and the Editor kicks the copy as an in-chat agent run.
//
// Why upload on pick: the /api/design/agent reference path resolves body.reference.ref against
// .state/refs (the uploaded-ref store). Cached TrendTrack images live in a different store, so a
// trendtrack pick is fetched and re-uploaded via /api/upload-ref to get a refs-backed id first.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { Icon } from '../Icon';
import styles from './ReferenceLibrary.module.css';

export interface PickedReference { ref: string; url: string; label: string }

/** ERR-5: reject oversized uploads client-side, before ever touching FileReader/readAsDataURL —
 *  a 30MB+ image would otherwise base64-inflate to 40MB+ in memory and in the POST body, which is
 *  a slow, easy-to-hang request for no benefit (references are downscaled server-side anyway). */
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

interface ReferenceLibraryProps {
  onPick: (ref: PickedReference) => void;
  onClose: () => void;
}

type CachedAd = { id: string; brand: string; hook: string | null; verdict: string | null; hasImage: boolean };

function useCachedAds() {
  const [ads, setAds] = useState<CachedAd[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const brands = await fetch('/api/trendtrack/cache').then((r) => r.json());
        const all: CachedAd[] = [];
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

/** Fetch a URL as a data URL — used to re-upload a cached TrendTrack image into the refs store. */
async function urlToDataUrl(url: string): Promise<string | null> {
  try {
    const blob = await fetch(url).then((r) => (r.ok ? r.blob() : null));
    if (!blob) return null;
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('read failed'));
      fr.readAsDataURL(blob);
    });
  } catch { return null; }
}

export default function ReferenceLibrary({ onPick, onClose }: ReferenceLibraryProps) {
  const cachedAds = useCachedAds();
  const [query, setQuery] = useState('');
  const [searchAds, setSearchAds] = useState<CachedAd[] | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Free local search over the whole cache (0 credits). Live import is explicit + priced.
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

  // Pick a cached ad → upload its image into the refs store → hand back the refs-backed id.
  // ERR-55: both the fetch (urlToDataUrl) and the upload can fail — previously this returned
  // silently, leaving the user staring at a spinner-that-vanished with no idea anything went
  // wrong. Surface both failure modes as a visible inline error.
  const pickTrendtrack = async (ad: CachedAd) => {
    if (busyId) return;
    setBusyId(ad.id);
    setError(null);
    try {
      const dataUrl = await urlToDataUrl(api.trendtrackImageUrl(ad.id));
      if (!dataUrl) { setError('Could not load that reference image — try again.'); return; }
      const r = await api.uploadRef(dataUrl);
      if (r.ok && r.id && r.url) {
        onPick({ ref: r.id, url: r.url, label: `${ad.brand} · ${(ad.hook || ad.id).slice(0, 48)}` });
      } else {
        setError('Upload failed — try again.');
      }
    } finally { setBusyId(null); }
  };

  const onUpload = (file: File | null) => {
    if (!file) return;
    setError(null);
    // ERR-5: reject oversized files BEFORE readAsDataURL (base64-inflating a 30MB+ file in
    // memory + shipping it in a JSON POST body is slow and easy to hang on).
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`That file is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB) — max 30MB.`);
      return;
    }
    setBusyId('upload');
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const r = await api.uploadRef(String(reader.result));
        if (r.ok && r.id && r.url) onPick({ ref: r.id, url: r.url, label: file.name || 'Uploaded reference' });
        else setError('Upload failed — try again.');
      } finally { setBusyId(null); }
    };
    // ERR-56: reader.onerror previously reset busy state silently — the user had no idea the
    // read failed (vs. just being slow). Surface it.
    reader.onerror = () => {
      setBusyId(null);
      setError('Could not read that file — try again.');
    };
    reader.readAsDataURL(file);
  };

  // Paste a screenshot while the picker is open.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
      if (f) { e.preventDefault(); onUpload(f); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ads = useMemo(() => searchAds ?? cachedAds, [searchAds, cachedAds]);

  return (
    <div className={styles.scrim} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.head}>
          <p className={styles.title}>Copy a reference</p>
          <span className={styles.sub}>Pick an ad — the agent copies its layout into this comp.</span>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <Icon name="x" size={13} />
          </button>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.ghostBtn} onClick={() => fileInput.current?.click()} disabled={busyId === 'upload'}>
            <Icon name="photo" size={13} /> {busyId === 'upload' ? 'Uploading…' : 'Upload screenshot…'}
          </button>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => onUpload(e.target.files?.[0] || null)} />
          <input
            className={styles.searchInput}
            placeholder="Search cached ads (free) — brand, hook, copy…"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          {credits != null ? <span className={styles.creditChip}>{credits.toLocaleString()} credits</span> : null}
        </div>

        {error ? <p className={styles.errorNote} role="alert">{error}</p> : null}

        {query.trim() && searchAds !== null ? (
          <button type="button" className={styles.liveBtn} onClick={importLive} disabled={importing}>
            {importing ? 'Importing…' : `Search TrendTrack LIVE for “${query.trim()}” — ≈10 credits`}
          </button>
        ) : null}

        {ads.length === 0 ? (
          <p className={styles.empty}>
            {query.trim()
              ? 'No cached matches — use the live search above (paid), or upload a screenshot.'
              : 'Nothing cached yet — import a brand from the Plan rail, or upload a screenshot.'}
          </p>
        ) : (
          <div className={styles.grid}>
            {ads.map((ad) => (
              <button
                key={ad.id} type="button" className={styles.cell}
                data-busy={busyId === ad.id || undefined}
                disabled={!!busyId}
                onClick={() => void pickTrendtrack(ad)}
                title={`Copy ${ad.brand} · ${ad.hook || ad.id}`}
              >
                <img src={api.trendtrackImageUrl(ad.id)} alt="" loading="lazy" decoding="async" />
                <span className={styles.cellLabel}>
                  {ad.verdict ? <b>{ad.verdict}</b> : null} {ad.hook || ad.id}
                </span>
                {busyId === ad.id ? <span className={styles.cellSpinner} aria-hidden /> : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
