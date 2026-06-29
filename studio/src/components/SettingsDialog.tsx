// SettingsDialog (container) — workspace preferences modal.
// Radix dialog, open when ui.settingsOpen; closes via Esc / backdrop / X → setUI({settingsOpen:false}).
// Single committed dark theme, so there is NO theme control. Holds: density (comfortable/compact),
// a show-archived toggle, and an "About NEUEGEN" section. Blurred backdrop stays.
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from './Icon';
import { useStore } from '../store';
import type { Density } from '../store';
import s from './SettingsDialog.module.css';

export default function SettingsDialog() {
  const settingsOpen = useStore((st) => st.ui.settingsOpen);
  const density = useStore((st) => st.ui.density);
  const showArchived = useStore((st) => st.ui.showArchived);
  const setUI = useStore((st) => st.setUI);
  const codexUsage = useStore((st) => st.state?.codexUsage);

  const close = () => setUI({ settingsOpen: false });

  const usageLine =
    codexUsage?.known && codexUsage.label
      ? `Codex usage · ${codexUsage.label}`
      : 'Codex usage · unknown';

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
            {/* Density */}
            <div className={s.field}>
              <p className={s.label} id="settings-density-label">Density</p>
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

            {/* Show archived */}
            <div className={s.field}>
              <label className={s.toggleRow} htmlFor="settings-archived">
                <span className={s.toggleText}>
                  <span className={s.toggleLabel}>Show archived</span>
                  <span className={s.toggleHint}>Include archived images in the gallery.</span>
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
            </div>

            {/* About NEUEGEN */}
            <div className={s.field}>
              <p className={s.label}>About NEUEGEN</p>
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
                  <span className={s.aboutMeta}>Local workspace · {usageLine}</span>
                </div>
              </div>
            </div>
          </div>

          <div className={s.foot}>
            <span className={s.about}>NEUEGEN · runs entirely on your machine.</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
