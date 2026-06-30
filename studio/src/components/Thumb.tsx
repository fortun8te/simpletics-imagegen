// Eager image in a fixed aspect-ratio:1 box (NO loading=lazy — avoids layout thrash).
// src is resolved through api.imgUrl so the same path convention is used everywhere.
// Fades in on load; the box keeps a subtle surface while the image streams in.
import { useState } from 'react';
import { api } from '../api';
import styles from './Thumb.module.css';

export function Thumb({ relPath, alt = '' }: { relPath: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className={styles.box}>
      <img
        className={`${styles.img} ${loaded ? styles.loaded : ''}`}
        src={api.imgUrl(relPath)}
        alt={alt}
        decoding="async"
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}
