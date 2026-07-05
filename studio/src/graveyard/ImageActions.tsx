// ImageActions — self-contained "Cut out subject" action for an image layer.
//
// Editor wiring (not done here):
//   <ImageActions
//     srcUrl={selectedLayer.src}
//     onCutout={async (dataUrl) => {
//       const ref = await api.uploadRef(dataUrl);   // persist the PNG cutout
//       patchLayer(selectedLayer.id, { src: ref }); // swap the layer's src
//     }}
//   />
// Runs @imgly/background-removal fully in-browser (dynamic import, see
// src/lib/bgRemoval.ts). First run downloads model assets (~40MB) from the
// imgly CDN, so the first-run label calls that out.

import { useEffect, useRef, useState } from 'react';
import { removeBackground } from '../lib/bgRemoval';
import styles from './ImageActions.module.css';

export default function ImageActions({
  srcUrl,
  onCutout,
}: {
  srcUrl: string;
  onCutout: (dataUrl: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [slowStart, setSlowStart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const run = async () => {
    setBusy(true);
    setPct(0);
    setSlowStart(false);
    setError(null);
    const timer = window.setTimeout(() => { if (alive.current) setSlowStart(true); }, 2000);
    try {
      const dataUrl = await removeBackground(srcUrl, (p) => { if (alive.current) setPct(p); });
      if (alive.current) onCutout(dataUrl);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Background removal failed.');
    } finally {
      window.clearTimeout(timer);
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.ghostBtn} disabled={busy} onClick={run}>
        {busy ? 'Cutting out…' : 'Cut out subject'}
      </button>
      {busy && (
        <span className={styles.progress}>
          {pct === 0 && slowStart ? 'Downloading model (first run)…' : `Cutting out… ${pct}%`}
        </span>
      )}
      {error && !busy && <span className={styles.error}>{error}</span>}
    </div>
  );
}
