// Eager image in a fixed aspect-ratio:1 box (NO loading=lazy — avoids layout thrash).
// src is resolved through api.imgUrl so the same path convention is used everywhere.
import { api } from '../api';
import styles from './Thumb.module.css';

export function Thumb({ relPath, alt = '' }: { relPath: string; alt?: string }) {
  return (
    <div className={styles.box}>
      <img className={styles.img} src={api.imgUrl(relPath)} alt={alt} decoding="async" />
    </div>
  );
}
