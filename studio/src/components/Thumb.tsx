// Eager image in a fixed aspect-ratio:1 box (NO loading=lazy — avoids layout thrash).
// src is resolved through api.imgUrl so the same path convention is used everywhere.
// Fades in on load; the box keeps a checkerboard surface while the image streams in.
// `v` (e.g. updatedAt) cache-busts so stale thumbs refresh after saves; a broken image
// falls back to a quiet icon tile instead of the browser's broken-image glyph.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from './Icon';
import styles from './Thumb.module.css';

export function Thumb({ relPath, alt = '', v }: { relPath: string; alt?: string; v?: number }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = api.imgUrl(relPath) + (v ? `&v=${v}` : '');

  // New source (path or version) → try again from a clean slate.
  useEffect(() => { setLoaded(false); setFailed(false); }, [src]);

  return (
    <div className={styles.box}>
      {failed ? (
        <span className={styles.fallback} aria-hidden><Icon name="palette" size={18} /></span>
      ) : (
        <img
          className={`${styles.img} ${loaded ? styles.loaded : ''}`}
          src={src}
          alt={alt}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
