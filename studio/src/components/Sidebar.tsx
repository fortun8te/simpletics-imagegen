// Sidebar (container). NEUEGEN wordmark, a brand switcher (Radix dropdown over config.brands),
// a live batch list fetched from api.getBatches(brand) with client-side search + recency sort, and a
// redesigned footer: a status chip (Codex + bridge health from /api/health), a Codex usage meter
// (from state.codexUsage), and a clean workspace/account row whose menu offers workspace switching,
// Settings and About — no theme item (the app is a single committed dark theme).
import { useEffect, useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useStore } from '../store';
import { api } from '../api';
import type { Health, BrandRef, BatchMeta, CodexUsage } from '../types';
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

// Remaining-quota percent for the usage meter (clamped 0-100), derived from whichever
// signal codexUsage carries. Returns null when nothing usable is present.
function usagePercent(u: CodexUsage | undefined): number | null {
  if (!u || !u.known) return null;
  if (typeof u.percent === 'number') return Math.max(0, Math.min(100, u.percent));
  if (typeof u.remaining === 'number' && typeof u.total === 'number' && u.total > 0) {
    return Math.max(0, Math.min(100, Math.round((u.remaining / u.total) * 100)));
  }
  return null;
}

export default function Sidebar() {
  const config = useStore((s) => s.config);
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const select = useStore((s) => s.select);
  const setUI = useStore((s) => s.setUI);
  // Codex usage rides on the batch state (server-derived); read it straight from the store.
  const codexUsage = useStore((s) => s.state?.codexUsage);

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

  const pct = usagePercent(codexUsage);
  const usageLabel =
    pct != null ? `Codex · ${pct}% left` : (codexUsage?.label ?? 'unknown');
  const sessionCount = codexUsage?.sessionGenerated ?? 0;

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

      {/* Footer — status chip + usage meter + account row */}
      <div className={styles.footer}>
        {/* Status chip: codex state dot + bridge dot */}
        <div className={styles.statusChip} role="status" aria-live="polite">
          <span className={styles.statusSeg}>
            <span
              className={styles.statusDot}
              data-state={codexBusy ? 'busy' : 'ok'}
            />
            <span className={styles.statusText}>
              {codexBusy ? 'Codex running' : 'Codex ready'}
            </span>
          </span>
          <span className={styles.statusDivider} aria-hidden />
          <span className={styles.statusSeg}>
            <span
              className={styles.statusDot}
              data-state={bridgeUp ? 'ok' : 'err'}
            />
            <span className={styles.statusText}>
              {bridgeUp ? 'Bridge up' : 'Bridge down'}
            </span>
          </span>
        </div>

        {/* Codex usage meter */}
        <div className={styles.usage} aria-live="polite">
          {pct != null ? (
            <>
              <div className={styles.usageBarTrack}>
                <div className={styles.usageBarFill} style={{ width: `${pct}%` }} />
              </div>
              <span className={styles.usageLabel}>{usageLabel}</span>
            </>
          ) : (
            <span className={styles.usageUnknown}>
              Usage · unknown
              {sessionCount > 0 && (
                <span className={styles.usageSession}> · {sessionCount} this session</span>
              )}
            </span>
          )}
        </div>

        {/* Account / workspace row */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className={styles.account} type="button" aria-label="Workspace menu">
              <span className={styles.accountMark}>
                <Icon name="sparkles" size={15} />
              </span>
              <span className={styles.accountText}>
                <span className={styles.accountName}>NEUEGEN</span>
                <span className={styles.accountSub}>Local</span>
              </span>
              <Icon name="chevron-down" size={14} className={styles.accountChevron} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className={styles.accountMenu}
              align="end"
              side="top"
              sideOffset={8}
            >
              <div className={styles.menuLabel}>Workspace</div>
              {brands.map((b) => (
                <DropdownMenu.Item
                  key={b.id}
                  className={styles.accountItem}
                  data-active={b.id === brand || undefined}
                  onSelect={() => select(b.id, firstBatchCode(b))}
                >
                  <Icon name="layout-grid" size={15} className={styles.accountItemIcon} />
                  <span className={styles.accountItemLabel}>{b.name ?? b.id}</span>
                  {b.id === brand && (
                    <Icon name="check" size={15} className={styles.accountItemCheck} />
                  )}
                </DropdownMenu.Item>
              ))}
              {brands.length === 0 && <div className={styles.menuEmpty}>No brands</div>}

              <DropdownMenu.Separator className={styles.menuSeparator} />

              <DropdownMenu.Item
                className={styles.accountItem}
                onSelect={() => setUI({ settingsOpen: true })}
              >
                <Icon name="settings" size={15} className={styles.accountItemIcon} />
                <span className={styles.accountItemLabel}>Settings</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={styles.accountItem}
                onSelect={() => setUI({ settingsOpen: true })}
              >
                <Icon name="sparkles" size={15} className={styles.accountItemIcon} />
                <span className={styles.accountItemLabel}>About NEUEGEN</span>
              </DropdownMenu.Item>

              <DropdownMenu.Separator className={styles.menuSeparator} />

              <div className={styles.menuAbout}>NEUEGEN · local · single workspace</div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </aside>
  );
}
