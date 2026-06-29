// SettingsDialog (container) — workspace preferences modal.
// Radix dialog, centered, wider (~560px), with a blurred/dimmed backdrop. Card on --surface,
// --r-lg, --shadow-lg, generous padding. Closes via Esc / backdrop / X → setUI({settingsOpen:false}).
// Single committed dark theme, so there is NO theme control. Sectioned with .eyebrow labels:
//   Appearance (density), Library (show archived), System (Codex + bridge health from /api/health,
//   polled while the dialog is open, plus the honest Codex usage line), and an About NEUEGEN footer.
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

  // System status — poll /api/health every 5s, but only while the dialog is open
  // (it lives here now, not in the sidebar). Null until the first probe resolves.
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
            <div>
              <Dialog.Title className={s.title}>Settings</Dialog.Title>
              <p className={s.subtitle}>Workspace preferences for this studio.</p>
            </div>
            <Dialog.Close className={s.close} aria-label="Close">
              <Icon name="x" size={16} />
            </Dialog.Close>
          </div>

          <div className={s.body}>
            {/* Appearance */}
            <section className={s.section}>
              <p className={`eyebrow ${s.eyebrow}`}>Appearance</p>
              <div className={s.field}>
                <label className={s.rowHead} id="settings-density-label">
                  <span className={s.rowLabel}>Density</span>
                  <span className={s.rowHint}>Spacing of the gallery and lists.</span>
                </label>
                <div className={s.segmented} role="radiogroup" aria-labelledby="settings-density-label">
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
            </section>

            {/* Library */}
            <section className={s.section}>
              <p className={`eyebrow ${s.eyebrow}`}>Library</p>
              <label className={s.toggleRow} htmlFor="settings-archived">
                <span className={s.toggleText}>
                  <span className={s.rowLabel}>Show archived</span>
                  <span className={s.rowHint}>Include archived images in the gallery.</span>
                </span>
                <button
                  id="settings-archived"
                  type="button"
                  role="switch"
                  aria-checked={showArchived}
                  className={`${s.switch} ${showArchived ? s.switchOn : ''}`}
                  onClick={() => setUI({ showArchived: !showArchived })}
                >
                  <span className={s.knob} aria-hidden />
                </button>
              </label>
            </section>

            {/* System */}
            <section className={s.section}>
              <p className={`eyebrow ${s.eyebrow}`}>System</p>
              <div className={s.systemCard}>
                <div className={s.statusRow} role="status" aria-live="polite">
                  <span className={s.statusSeg}>
                    <span className={s.statusDot} data-state={codexBusy ? 'busy' : 'ok'} />
                    <span className={s.statusText}>
                      {codexBusy ? 'Codex running' : 'Codex ready'}
                    </span>
                  </span>
                  <span className={s.statusDivider} aria-hidden />
                  <span className={s.statusSeg}>
                    <span className={s.statusDot} data-state={bridgeUp ? 'ok' : 'err'} />
                    <span className={s.statusText}>
                      {bridgeUp ? 'Bridge up' : 'Bridge down'}
                    </span>
                  </span>
                </div>
                <div className={s.systemDivider} aria-hidden />
                <div className={s.usageRow}>
                  <span className={s.usageLabel}>Codex usage</span>
                  <span className={s.usageValue} data-known={usageKnown || undefined}>
                    {usageLabel}
                    {sessionCount > 0 && (
                      <span className={s.usageSession}> · {sessionCount} this session</span>
                    )}
                  </span>
                </div>
              </div>
            </section>

            {/* About NEUEGEN */}
            <section className={s.section}>
              <p className={`eyebrow ${s.eyebrow}`}>About NEUEGEN</p>
              <div className={s.aboutCard}>
                <span className={s.aboutMark}>
                  <Icon name="sparkles" size={16} />
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
