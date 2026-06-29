// Sidebar (container). App mark, a brand switcher (Radix dropdown), the current brand's batch list,
// and a footer with Activity / Settings rows + a live health line polled from /api/health every 5s.
import { useEffect, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useStore } from '../store';
import { api } from '../api';
import type { Health, BrandRef } from '../types';
import { Icon } from './Icon';
import styles from './Sidebar.module.css';

// First batch code of a brand, used as the landing batch when switching brands.
function firstBatchCode(brand: BrandRef | undefined): string {
  return brand?.batches?.[0]?.code ?? '';
}

export default function Sidebar() {
  const config = useStore((s) => s.config);
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const select = useStore((s) => s.select);

  const brands = config.brands ?? [];
  const currentBrand = brands.find((b) => b.id === brand);
  const batches = currentBrand?.batches ?? [];
  const brandLabel = currentBrand?.name ?? currentBrand?.id ?? 'Select brand';

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
      {/* App mark */}
      <div className={styles.brandMark}>
        <span className={styles.mark}>
          <Icon name="sparkles" size={16} />
        </span>
        <span className={styles.wordmark}>ImageGen Studio</span>
      </div>

      {/* Brand switcher */}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className={styles.brandSwitch} type="button">
            <span className={styles.brandName}>{brandLabel}</span>
            <Icon name="chevron-down" size={14} className={styles.chevron} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className={styles.menu}
            align="start"
            sideOffset={6}
          >
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
            {brands.length === 0 && (
              <div className={styles.menuEmpty}>No brands</div>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* Batches */}
      <div className={styles.section}>
        <div className={styles.eyebrow}>Batches</div>
        <nav className={styles.batchList}>
          {batches.map((bt) => {
            const active = bt.code === batch;
            return (
              <button
                key={bt.code}
                type="button"
                className={styles.batchRow}
                data-active={active || undefined}
                onClick={() => { if (brand) select(brand, bt.code); }}
              >
                <Icon name="layout-grid" size={16} className={styles.batchIcon} />
                <span className={styles.batchName}>{bt.name || bt.code}</span>
              </button>
            );
          })}
          {batches.length === 0 && (
            <div className={styles.batchEmpty}>No batches</div>
          )}
        </nav>
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        <button type="button" className={styles.footRow}>
          <Icon name="activity" size={16} className={styles.footIcon} />
          <span>Activity</span>
        </button>
        <button type="button" className={styles.footRow}>
          <Icon name="settings" size={16} className={styles.footIcon} />
          <span>Settings</span>
        </button>

        <div className={styles.health} role="status" aria-live="polite">
          <span
            className={styles.healthDot}
            data-state={healthOk ? 'ok' : 'err'}
          />
          <span className={styles.healthText}>
            {codexBusy ? 'Codex running' : 'Codex ready'} · bridge {bridgeUp ? 'up' : 'down'}
          </span>
        </div>
      </div>
    </aside>
  );
}
