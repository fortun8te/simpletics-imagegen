// SettingsDialog — workspace preferences modal, Linear/Raycast command-palette feel.
// Tall, narrow floating glass panel with a clear header (title + muted subtitle + close),
// a single scrollable column of small-caps grouped sections separated by faint hairlines,
// side-by-side setting rows, clean key-value system status rows with colored status dots,
// and a bordered glass About card. Keeps Radix Dialog primitives, all functionality, and
// the overlay z-index/isolation fix (z 100/101) so no grid/TopBar text bleeds through.
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from './Icon';
import { useStore } from '../store';
import type { Density } from '../store';
import { api } from '../api';
import type { Health } from '../types';
import s from './SettingsDialog.module.css';

export default function SettingsDialog() {
  const settingsOpen = useStore((st) => st.ui.settingsOpen);
  const density = useStore((st) => st.ui.density);
  const showArchived = useStore((st) => st.ui.showArchived);
  const setUI = useStore((st) => st.setUI);
  const codexUsage = useStore((st) => st.state?.codexUsage);

  const close = () => setUI({ settingsOpen: false });

  // System status — poll /api/health every 5s, but only while the dialog is open.
  // Null until the first probe resolves.
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    if (!settingsOpen) { setHealth(null); return; }
    let alive = true;
    const probe = () => api.getHealth().then((h) => { if (alive) setHealth(h); });
    probe();
    const t = window.setInterval(probe, 5000);
    return () => { alive = false; window.clearInterval(t); };
  }, [settingsOpen]);

  const bridgeUp = !!health?.bridge;
  const codexBusy = !!health?.codex?.alive;

  // Honest usage line — never invent a number when codexUsage says unknown.
  const usageKnown = !!codexUsage?.known;
  const usageLabel = usageKnown
    ? (codexUsage?.label ?? 'active')
    : 'unknown';
  const sessionCount = codexUsage?.sessionGenerated ?? 0;

  return (
    <Dialog.Root open={settingsOpen} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.content} aria-describedby={undefined}>
          <div className={s.head}>
            <div className={s.headText}>
              <Dialog.Title className={s.title}>Settings</Dialog.Title>
              <p className={s.subtitle}>Workspace preferences</p>
            </div>
            <Dialog.Close className={s.close} aria-label="Close">
              <Icon name="x" size={16} />
            </Dialog.Close>
          </div>

          <div className={s.body}>
            {/* Appearance */}
            <section className={s.section}>
              <p className={`eyebrow ${s.eyebrow}`}>Appearance</p>
              <div className={s.rows}>
                <div className={s.settingRow}>
                  <div className={s.settingText} id="settings-density-label">
                    <span className={s.rowLabel}>Density</span>
                    <span className={s.rowHint}>Spacing of the gallery and lists.</span>
                  </div>
                  <div className={`${s.segmented} ${s.settingControl}`} role="radiogroup" aria-labelledby="settings-density-label">
                    {(['comfortable', 'compact'] as Density[]).map((d) => (
                      <button
                        key={d}
                        type="button"
                        role="radio"
                        aria-checked={density === d}
                        className={`${s.segment} ${density === d ? s.segmentOn : ''}`}
                        onClick={() => setUI({ density: d })}
                      >
                        <span>{d === 'compact' ? 'Compact' : 'Comfortable'}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <div className={s.groupDivider} aria-hidden />

            {/* Library */}
            <section className={s.section}>
              <p className={`eyebrow ${s.eyebrow}`}>Library</p>
              <div className={s.rows}>
                <label className={`${s.settingRow} ${s.toggleRow}`} htmlFor="settings-archived">
                  <span className={s.settingText}>
                    <span className={s.rowLabel}>Show archived</span>
                    <span className={s.rowHint}>Include archived images in the gallery.</span>
                  </span>
                  <button
                    id="settings-archived"
                    type="button"
                    role="switch"
                    aria-checked={showArchived}
                    className={`${s.switch} ${s.settingControl} ${showArchived ? s.switchOn : ''}`}
                    onClick={() => setUI({ showArchived: !showArchived })}
                  >
                    <span className={s.knob} aria-hidden />
                  </button>
                </label>
              </div>
            </section>

            <div className={s.groupDivider} aria-hidden />

            {/* System */}
            <section className={s.section}>
              <p className={`eyebrow ${s.eyebrow}`}>System</p>
              <div className={s.rows}>
                <div className={s.kvRow} role="status" aria-live="polite">
                  <span className={s.kvLabel}>Codex</span>
                  <span className={s.kvValue}>
                    <span className={s.statusDot} data-state={codexBusy ? 'busy' : 'ok'} />
                    {codexBusy ? 'Running' : 'Ready'}
                  </span>
                </div>
                <div className={s.kvRow} role="status" aria-live="polite">
                  <span className={s.kvLabel}>Bridge</span>
                  <span className={s.kvValue}>
                    <span className={s.statusDot} data-state={bridgeUp ? 'ok' : 'err'} />
                    {bridgeUp ? 'Up' : 'Down'}
                  </span>
                </div>
                <div className={s.kvRow}>
                  <span className={s.kvLabel}>Codex usage</span>
                  <span className={s.kvValue} data-known={usageKnown || undefined}>
                    {usageLabel}
                    {sessionCount > 0 && (
                      <span className={s.usageSession}> · {sessionCount} this session</span>
                    )}
                  </span>
                </div>
              </div>
            </section>

            <div className={s.groupDivider} aria-hidden />

            {/* About NEUEGEN */}
            <section className={s.section}>
              <p className={`eyebrow ${s.eyebrow}`}>About NEUEGEN</p>
              <div className={s.aboutCard}>
                <span className={s.aboutMark} aria-hidden>
                  <Icon name="brand" size={16} />
                </span>
                <div className={s.aboutText}>
                  <span className={s.aboutName}>NEUEGEN</span>
                  <span className={s.aboutDesc}>
                    A premium local image studio — generate, regenerate and curate
                    ad batches through your own Codex bridge.
                  </span>
                  <span className={s.aboutMeta}>Local workspace · runs entirely on your machine.</span>
                </div>
              </div>
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
