// Sidebar (container). NEUEGEN wordmark, a brand switcher (Radix dropdown over config.brands),
// a live batch list fetched from api.getBatches(brand) with client-side search + recency sort, and a
// clean footer with brand identity + direct settings access — no theme item (the app is a single committed dark theme).
// System status (Codex + bridge health) and Codex usage have MOVED to the Settings dialog,
// so the sidebar no longer polls /api/health.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useStore } from '../store';
import { api } from '../api';
import type { BrandRef, BatchMeta } from '../types';
import { Icon } from './Icon';
import { BrandMark } from './BrandMark';
import UsageChip from './UsageChip';
import MarqueeText from './MarqueeText';
import { pollIntervalMs } from '../lib/activity';
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

// Platform-correct modifier label/hint for the search shortcut.
const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');


interface SidebarProps {
  /** Folded to a slim icon rail (persisted + toggled by AppShell). */
  collapsed?: boolean;
  /** Toggle the fold state. */
  onToggle?: () => void;
}

export default function Sidebar({ collapsed = false, onToggle }: SidebarProps) {
  const config = useStore((s) => s.config);
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const select = useStore((s) => s.select);
  const setUI = useStore((s) => s.setUI);

  // Mock account — no real auth/account system yet, placeholder for the eventual one.
  const userName = 'Michael';

  const brands = config.brands ?? [];
  const currentBrand = brands.find((b) => b.id === brand);
  const brandLabel = currentBrand?.name ?? currentBrand?.id ?? 'Select brand';

  // Batches — fetched from the server for the active brand, refetched when brand
  // changes and refreshed periodically (every 10s) so the list stays current.
  const [batches, setBatches] = useState<BatchMeta[]>([]);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!brand) { setBatches([]); return; }
    let alive = true;
    let timer: number | undefined;
    const load = () => api.getBatches(brand).then((b) => { if (alive) setBatches(b); });
    const schedule = () => {
      if (!alive) return;
      if (document.hidden) {
        timer = window.setTimeout(schedule, 30_000);
        return;
      }
      load().finally(() => {
        if (!alive) return;
        timer = window.setTimeout(schedule, pollIntervalMs('batches'));
      });
    };
    load().finally(schedule);
    const onVis = () => { if (!document.hidden) schedule(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [brand]);

  // ⌘+K (mac) / Ctrl+K (other) focuses the batch search — the hint badge mirrors the real binding.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Filter by name (client-side), then sort by modifiedAt desc (most-recent first).
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? batches.filter((b) => (b.name || b.code).toLowerCase().includes(q))
      : batches.slice();
    return filtered.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
  }, [batches, query]);

  // ── Collapsed rail ──────────────────────────────────────────────────────
  // A slim ~52px column: logo, an expand toggle, icon-only batch dots (kind glyph, active state,
  // full label as a tooltip), and a settings icon. Everything stays keyboard reachable.
  if (collapsed) {
    return (
      <aside className={styles.sidebar} data-collapsed>
        <div className={styles.railTop}>
          <span className={styles.mark} aria-hidden="true">
            <BrandMark size={22} />
          </span>
          <button
            type="button"
            className={styles.railToggle}
            onClick={onToggle}
            aria-label="Expand sidebar"
            aria-expanded={false}
            title="Expand sidebar"
          >
            <Icon name="chevron-right" size={16} className={styles.chevGlyph} />
          </button>
        </div>

        <div className={styles.divider} aria-hidden="true" />

        <nav className={styles.railBatches} aria-label="Batches">
          {visible.map((bt) => {
            const active = bt.code === batch;
            const kindIcon = bt.kind === 'listicle' ? 'layout-list' : 'layout-grid';
            const label = bt.name || bt.code;
            return (
              <button
                key={bt.code}
                type="button"
                className={styles.railDot}
                data-active={active || undefined}
                onClick={() => { if (brand) select(brand, bt.code); }}
                aria-label={label}
                aria-current={active || undefined}
                title={label}
              >
                <Icon name={kindIcon} size={16} />
              </button>
            );
          })}
        </nav>

        <div className={styles.railFooter}>
          <button
            className={styles.railIconBtn}
            type="button"
            onClick={() => setUI({ settingsOpen: true })}
            aria-label="Settings"
            title="Settings"
          >
            <Icon name="settings" size={16} />
          </button>
          <span className={styles.userAvatar} aria-hidden="true" title={userName}>
            {userName.charAt(0).toUpperCase()}
          </span>
        </div>
      </aside>
    );
  }

  return (
    <aside className={styles.sidebar}>
      {/* Wordmark + fold toggle */}
      <div className={styles.brandMark}>
        <span className={styles.mark}>
          <BrandMark size={22} />
        </span>
        <span className={styles.wordmark}>NEUEGEN</span>
        <button
          type="button"
          className={styles.foldToggle}
          onClick={onToggle}
          aria-label="Collapse sidebar"
          aria-expanded={true}
          title="Collapse sidebar"
        >
          <Icon name="chevron-right" size={16} className={styles.chevFlip} />
        </button>
      </div>

      {/* Workspace — brand switcher */}
      <div className={styles.block}>
        <div className={styles.sectionLabel}>
          <span className={styles.eyebrow}>Workspace</span>
        </div>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className={styles.brandSwitch} type="button">
              <span className={styles.brandSwitchInner}>
                <span className={styles.brandGlyph}>
                  {(brandLabel || '?').charAt(0).toUpperCase()}
                </span>
                <span className={styles.brandName}>{brandLabel}</span>
              </span>
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
                  <span className={styles.brandGlyph}>
                    {(b.name ?? b.id ?? '?').charAt(0).toUpperCase()}
                  </span>
                  <span className={styles.menuLabel}>{b.name ?? b.id}</span>
                </DropdownMenu.Item>
              ))}
              {brands.length === 0 && <div className={styles.menuEmpty}>No brands</div>}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <div className={styles.divider} aria-hidden="true" />

      {/* Batches */}
      <div className={styles.section}>
        <div className={styles.sectionLabel}>
          <span className={styles.eyebrow}>Batches</span>
          {batches.length > 0 && (
            <span className={styles.sectionCount}>{batches.length}</span>
          )}
        </div>

        <div className={styles.searchWrap}>
          <Icon name="search" size={14} className={styles.searchIcon} />
          <input
            ref={searchRef}
            className={styles.search}
            type="text"
            placeholder="Search batches"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search batches"
          />
          <kbd className={styles.searchHint} aria-hidden="true">
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </div>

        <nav className={styles.batchList}>
          {visible.map((bt) => {
            const active = bt.code === batch;
            const kindIcon = bt.kind === 'listicle' ? 'layout-list' : 'layout-grid';
            const label = bt.name || bt.code;
            const tip = bt.modifiedAt
              ? `${label} · updated ${relTime(bt.modifiedAt)}`
              : label;
            return (
              <button
                key={bt.code}
                type="button"
                className={styles.batchRow}
                data-active={active || undefined}
                onClick={() => { if (brand) select(brand, bt.code); }}
              >
                <Icon name={kindIcon} size={16} className={styles.batchIcon} />
                <MarqueeText className={styles.batchName} tip={tip}>
                  {label}
                </MarqueeText>
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

      {/* Footer — Settings + a (mock) account row with the Codex usage ring inline on the right */}
      <div className={styles.footer}>
        <button
          className={styles.settingsBtn}
          type="button"
          onClick={() => setUI({ settingsOpen: true })}
        >
          <Icon name="settings" size={16} />
          <span>Settings</span>
        </button>
        {/* Mock account row — no real auth/account system yet, placeholder for the eventual one. */}
        <div className={styles.userRow}>
          <button className={styles.userRowMain} type="button">
            <span className={styles.userAvatar} aria-hidden="true">
              {userName.charAt(0).toUpperCase()}
            </span>
            <span className={styles.userText}>
              <span className={styles.userName}>{userName}</span>
              <span className={styles.userTier}>MAX</span>
            </span>
          </button>
          <UsageChip />
        </div>
      </div>
    </aside>
  );
}
