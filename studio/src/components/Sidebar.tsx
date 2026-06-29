// Sidebar (container). NEUEGEN wordmark, a brand switcher (Radix dropdown over config.brands),
// a live batch list fetched from api.getBatches(brand) with client-side search + recency sort,
// and a footer with Activity / Settings rows + a health line polled from /api/health every 5s.
import { useEffect, useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useStore } from '../store';
import { api } from '../api';
import type { Health, BrandRef, BatchMeta } from '../types';
import { Icon } from './Icon';
import styles from './Sidebar.module.css';

// First batch code of a brand, used as the landing batch when switching brands.
function firstBatchCode(brand: BrandRef | undefined): string {
  return brand?.batches?.[0]?.code ?? '';
}

// Compact relative-time hint for a batch's modifiedAt (epoch ms).
function relTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return 'now';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export default function Sidebar() {
  const config = useStore((s) => s.config);
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const select = useStore((s) => s.select);
  const setUI = useStore((s) => s.setUI);

  const brands = config.brands ?? [];
  const currentBrand = brands.find((b) => b.id === brand);
  const brandLabel = currentBrand?.name ?? currentBrand?.id ?? 'Select brand';

  // Batches — fetched from the server for the active brand, refetched when brand
  // changes and refreshed periodically (every 10s) so the list stays current.
  const [batches, setBatches] = useState<BatchMeta[]>([]);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!brand) { setBatches([]); return; }
    let alive = true;
    const load = () => api.getBatches(brand).then((b) => { if (alive) setBatches(b); });
    load();
    const t = window.setInterval(load, 10000);
    return () => { alive = false; window.clearInterval(t); };
  }, [brand]);

  // Filter by name (client-side), then sort by modifiedAt desc (most-recent first).
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? batches.filter((b) => (b.name || b.code).toLowerCase().includes(q))
      : batches.slice();
    return filtered.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
  }, [batches, query]);

  // Health polling — every 5s. Null until the first probe resolves.
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    let alive = true;
    const probe = () => api.getHealth().then((h) => { if (alive) setHealth(h); });
    probe();
    const t = window.setInterval(probe, 5000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  const bridgeUp = !!health?.bridge;
  const codexBusy = !!health?.codex?.alive;
  const healthOk = !!health?.ok; // backend reachable = healthy; codex idle is not an error

  return (
    <aside className={styles.sidebar}>
      {/* Wordmark */}
      <div className={styles.brandMark}>
        <span className={styles.mark}>
          <Icon name="sparkles" size={16} />
        </span>
        <span className={styles.wordmark}>NEUEGEN</span>
      </div>

      {/* Workspace — brand switcher */}
      <div className={styles.block}>
        <div className={styles.eyebrow}>Workspace</div>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className={styles.brandSwitch} type="button">
              <span className={styles.brandName}>{brandLabel}</span>
              <Icon name="chevron-down" size={14} className={styles.chevron} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className={styles.menu} align="start" sideOffset={6}>
              {brands.map((b) => (
                <DropdownMenu.Item
                  key={b.id}
                  className={styles.menuItem}
                  data-active={b.id === brand || undefined}
                  onSelect={() => select(b.id, firstBatchCode(b))}
                >
                  {b.name ?? b.id}
                </DropdownMenu.Item>
              ))}
              {brands.length === 0 && <div className={styles.menuEmpty}>No brands</div>}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {/* Batches */}
      <div className={styles.section}>
        <div className={styles.eyebrow}>Batches</div>

        <div className={styles.searchWrap}>
          <Icon name="search" size={14} className={styles.searchIcon} />
          <input
            className={styles.search}
            type="text"
            placeholder="Search batches"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search batches"
          />
        </div>

        <nav className={styles.batchList}>
          {visible.map((bt) => {
            const active = bt.code === batch;
            const kindIcon = bt.kind === 'listicle' ? 'layout-list' : 'layout-grid';
            return (
              <button
                key={bt.code}
                type="button"
                className={styles.batchRow}
                data-active={active || undefined}
                onClick={() => { if (brand) select(brand, bt.code); }}
                title={bt.modifiedAt ? `Updated ${relTime(bt.modifiedAt)}` : undefined}
              >
                <Icon name={kindIcon} size={16} className={styles.batchIcon} />
                <span className={styles.batchName}>{bt.name || bt.code}</span>
                <span className={styles.batchCount}>{bt.count}</span>
              </button>
            );
          })}
          {brand && visible.length === 0 && (
            <div className={styles.batchEmpty}>
              {query.trim() ? 'No matching batches' : 'No batches yet'}
            </div>
          )}
          {!brand && <div className={styles.batchEmpty}>Pick a workspace</div>}
        </nav>
      </div>

      {/* Account */}
      <div className={styles.footer}>
        <div className={styles.eyebrow}>Account</div>

        <button
          type="button"
          className={styles.footRow}
          onClick={() => setUI({ activityOpen: true })}
        >
          <Icon name="activity" size={16} className={styles.footIcon} />
          <span>Activity</span>
        </button>
        <button
          type="button"
          className={styles.footRow}
          onClick={() => setUI({ settingsOpen: true })}
        >
          <Icon name="settings" size={16} className={styles.footIcon} />
          <span>Settings</span>
        </button>

        <div className={styles.health} role="status" aria-live="polite">
          <span className={styles.healthDot} data-state={healthOk ? 'ok' : 'err'} />
          <span className={styles.healthText}>
            {codexBusy ? 'Codex running' : 'Codex ready'} · bridge {bridgeUp ? 'up' : 'down'}
          </span>
        </div>
      </div>
    </aside>
  );
}
