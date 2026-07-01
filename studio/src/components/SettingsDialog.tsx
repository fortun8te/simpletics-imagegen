// SettingsDialog — workspace preferences modal, Linear/Raycast command-palette feel.
// Tall, narrow floating glass panel with a clear header (title + muted subtitle + close),
// a single scrollable column of small-caps grouped sections separated by faint hairlines,
// side-by-side setting rows, and clean key-value system status rows with colored status dots.
// Keeps Radix Dialog primitives, all functionality, and the overlay z-index/isolation fix
// (z 100/101) so no grid/TopBar text bleeds through.
import { useEffect, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from './Icon';
import { useStore } from '../store';
import type { AccentRGB, Density, Theme } from '../store';
import { api } from '../api';
import type { Health } from '../types';
import s from './SettingsDialog.module.css';

// Theme MODE is a superset of the store's resolved Theme ('dark' | 'light'): 'auto' follows
// the OS via prefers-color-scheme and is never written into store.ui.theme directly — it's
// resolved to dark/light here, then handed to setUI({ theme }) so the rest of the app (which
// only knows dark/light, e.g. AppAura's live aurora) keeps working unchanged.
type ThemeMode = 'auto' | Theme;
const THEME_MODE_KEY = 'neuegen.themeMode';
const readThemeMode = (): ThemeMode => {
  try {
    const v = localStorage.getItem(THEME_MODE_KEY);
    if (v === 'auto' || v === 'dark' || v === 'light') return v;
  } catch { /* ignore */ }
  return 'dark';
};
const writeThemeMode = (mode: ThemeMode) => {
  try { localStorage.setItem(THEME_MODE_KEY, mode); } catch { /* ignore */ }
};
const prefersDark = () =>
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true;

// Accent presets — swap --accent/--accent-2 only; the rest of the token system (surfaces,
// ink, status colors) stays put. Blue matches the values already committed in theme.css.
// 'custom' is a 4th slot backed by an arbitrary user-picked hex (see customHex below) instead
// of a fixed entry in ACCENTS.
type AccentId = 'blue' | 'white' | 'red' | 'custom';
const ACCENT_KEY = 'neuegen.accent';
const CUSTOM_HEX_KEY = 'neuegen.accent.custom';
const DEFAULT_CUSTOM_HEX = '#7c5cff';
// `rgb` is the same preset color pre-converted from OKLCH to 0..255 sRGB (computed once, offline)
// for AppAura's WebGL uniforms — the live render loop needs plain numbers, not a CSS string to
// parse every frame. Keep in sync with `accent` by eye if the OKLCH values above ever change.
const ACCENTS: Record<Exclude<AccentId, 'custom'>, { label: string; accent: string; accent2: string; swatch: string; rgb: AccentRGB }> = {
  blue: {
    label: 'Blue',
    accent: 'oklch(0.55 0.245 258)',
    accent2: 'oklch(0.635 0.235 258)',
    swatch: 'oklch(0.55 0.245 258)',
    rgb: { r: 0, g: 100, b: 252 },
  },
  white: {
    label: 'White',
    accent: 'oklch(0.94 0 0)',
    accent2: 'oklch(0.99 0 0)',
    swatch: 'oklch(0.94 0 0)',
    rgb: { r: 235, g: 235, b: 235 },
  },
  red: {
    label: 'Red',
    accent: 'oklch(0.58 0.22 25)',
    accent2: 'oklch(0.65 0.21 25)',
    swatch: 'oklch(0.58 0.22 25)',
    rgb: { r: 223, g: 32, b: 46 },
  },
};
const readAccent = (): AccentId => {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    if (v === 'blue' || v === 'white' || v === 'red' || v === 'custom') return v;
  } catch { /* ignore */ }
  return 'blue';
};
const writeAccent = (id: AccentId) => {
  try { localStorage.setItem(ACCENT_KEY, id); } catch { /* ignore */ }
};
const readCustomHex = (): string => {
  try {
    const v = localStorage.getItem(CUSTOM_HEX_KEY);
    if (v && /^#[0-9a-fA-F]{6}$/.test(v)) return v;
  } catch { /* ignore */ }
  return DEFAULT_CUSTOM_HEX;
};
const writeCustomHex = (hex: string) => {
  try { localStorage.setItem(CUSTOM_HEX_KEY, hex); } catch { /* ignore */ }
};

// #rrggbb -> {r,g,b}. Returns null for anything that isn't a clean 6-digit hex (e.g. the input
// mid-edit) so callers can ignore incomplete typing instead of applying a garbage color.
const hexToRgb = (hex: string): AccentRGB | null => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
const rgbToHex = ({ r, g, b }: AccentRGB): string =>
  `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
// Mix toward white for the "-2"/hover variant, same relationship every existing preset already
// has between its `accent` and brighter `accent2`.
const lighten = ({ r, g, b }: AccentRGB, amt: number): AccentRGB => ({
  r: r + (255 - r) * amt,
  g: g + (255 - g) * amt,
  b: b + (255 - b) * amt,
});

// Relative luminance (WCAG formula) on linearized sRGB channels, used to decide whether dark
// or white text/icons stay legible painted on top of an arbitrary accent fill. Generalizes the
// old hardcoded `[data-accent="white"]` CSS override (which only handled the one near-white
// preset) to any chosen color, preset or custom.
const relLuminance = ({ r, g, b }: AccentRGB): number => {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
// Contrast ratio of a color against black/white; pick whichever ink wins, returned as a CSS color.
const onAccentFor = (rgb: AccentRGB): string => {
  const L = relLuminance(rgb);
  const contrastWithWhite = (1.0 + 0.05) / (L + 0.05);
  const contrastWithBlack = (L + 0.05) / (0.0 + 0.05);
  return contrastWithWhite >= contrastWithBlack ? 'oklch(0.99 0 0)' : 'oklch(0.18 0 0)';
};

// Apply any accent color (preset or custom) to the live CSS custom properties: --accent/--accent-2
// as the picked color + a lightened hover variant, and --on-accent computed live via the contrast
// check above so text/icons painted on top of the fill stay legible for any color, not just the
// 3 presets — replaces the old data-accent="white" CSS-only special case.
const applyAccentColor = (rgb: AccentRGB, presetAccent?: { accent: string; accent2: string }) => {
  try {
    const root = document.documentElement;
    if (presetAccent) {
      root.style.setProperty('--accent', presetAccent.accent);
      root.style.setProperty('--accent-2', presetAccent.accent2);
    } else {
      root.style.setProperty('--accent', rgbToHex(rgb));
      root.style.setProperty('--accent-2', rgbToHex(lighten(rgb, 0.18)));
    }
    const onAccent = onAccentFor(rgb);
    root.style.setProperty('--on-accent', onAccent);
    root.style.setProperty('--accent-contrast', onAccent);
  } catch { /* SSR/no-DOM */ }
};

// Apply the persisted accent immediately on module load, before first paint of accent-driven
// chrome (buttons, focus rings, the avatar gradient) — mirrors store.ts's applyTheme bootstrap.
// Also seed the store's accentRGB synchronously (not via setUI, to avoid touching localStorage
// again for a value SettingsDialog already persists under its own ACCENT_KEY) so AppAura reads
// the correct palette on its very first frame instead of one render late.
{
  const bootId = readAccent();
  const bootRgb = bootId === 'custom' ? (hexToRgb(readCustomHex()) ?? hexToRgb(DEFAULT_CUSTOM_HEX)!) : ACCENTS[bootId].rgb;
  applyAccentColor(bootRgb, bootId === 'custom' ? undefined : ACCENTS[bootId]);
  useStore.setState((st) => ({ ui: { ...st.ui, accentRGB: bootRgb } }));
}

// Left-nav sections — mirrors the three plain-text eyebrows the body already groups its
// cards under, just given icons + a switcher so the dialog reads like a settings app
// instead of one long scroll. The active section is persisted (same localStorage pattern as
// theme/accent above) so reopening Settings returns to wherever the user last left it.
type SectionId = 'appearance' | 'library' | 'system';
const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'library', label: 'Library', icon: 'archive' },
  { id: 'system', label: 'System', icon: 'activity' },
];
const SECTION_KEY = 'neuegen.settingsSection';
const readSection = (): SectionId => {
  try {
    const v = localStorage.getItem(SECTION_KEY);
    if (v === 'appearance' || v === 'library' || v === 'system') return v;
  } catch { /* ignore */ }
  return 'appearance';
};
const writeSection = (id: SectionId) => {
  try { localStorage.setItem(SECTION_KEY, id); } catch { /* ignore */ }
};

export default function SettingsDialog() {
  const settingsOpen = useStore((st) => st.ui.settingsOpen);
  const density = useStore((st) => st.ui.density);
  const showArchived = useStore((st) => st.ui.showArchived);
  const setUI = useStore((st) => st.setUI);
  const codexUsage = useStore((st) => st.state?.codexUsage);

  const [section, setSectionState] = useState<SectionId>(() => readSection());
  const setSection = (id: SectionId) => {
    setSectionState(id);
    writeSection(id);
  };

  const close = () => setUI({ settingsOpen: false });

  // Theme mode (Auto/Light/Dark) — Auto tracks the OS live via matchMedia and resolves to a
  // concrete dark/light written through the existing setUI({ theme }) path, so persistence
  // and AppAura's aurora both keep behaving exactly as before for explicit Light/Dark picks.
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readThemeMode());

  useEffect(() => {
    if (themeMode !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setUI({ theme: mq.matches ? 'dark' : 'light' });
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [themeMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseThemeMode = (mode: ThemeMode) => {
    setThemeMode(mode);
    writeThemeMode(mode);
    if (mode !== 'auto') setUI({ theme: mode });
    else setUI({ theme: prefersDark() ? 'dark' : 'light' });
  };

  // Accent — preset or custom, applied live to the CSS custom properties on pick, persisted the
  // same way. Also pushed into the store's accentRGB so AppAura's live WebGL background (which
  // can't read CSS vars from inside its render loop) re-tints reactively — the same plumbing the
  // dialog already uses for `theme` (setUI -> a store field AppAura subscribes to via useStore).
  // customHex is kept even while a preset is active so the picker/text input has something to
  // show if the user switches back to "Custom" later.
  const [accent, setAccent] = useState<AccentId>(() => readAccent());
  const [customHex, setCustomHexState] = useState<string>(() => readCustomHex());
  // Free-typed hex text, decoupled from customHex so a mid-edit string (e.g. "#7c5") doesn't get
  // clobbered by a re-render before the user finishes typing; only valid 6-digit hex commits.
  const [customHexInput, setCustomHexInput] = useState<string>(() => readCustomHex());

  const choosePreset = (id: Exclude<AccentId, 'custom'>) => {
    setAccent(id);
    writeAccent(id);
    applyAccentColor(ACCENTS[id].rgb, ACCENTS[id]);
    setUI({ accentRGB: ACCENTS[id].rgb });
  };
  const chooseCustom = (hex: string) => {
    const rgb = hexToRgb(hex);
    if (!rgb) return; // ignore incomplete typing — only act on a clean 6-digit hex
    setAccent('custom');
    writeAccent('custom');
    setCustomHexState(hex);
    writeCustomHex(hex);
    applyAccentColor(rgb);
    setUI({ accentRGB: rgb });
  };
  // Color swatch input — always commits a full hex on change/input, so apply immediately.
  const onCustomColorInput = (hex: string) => {
    setCustomHexInput(hex);
    chooseCustom(hex);
  };
  // Text field — let the user type freely, only apply once it parses as a clean hex.
  const onCustomHexTextChange = (value: string) => {
    const v = value.startsWith('#') ? value : `#${value}`;
    setCustomHexInput(v);
    if (hexToRgb(v)) chooseCustom(v);
  };

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

          <div className={s.layout}>
            <nav className={s.nav} aria-label="Settings sections">
              {SECTIONS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={s.navItem}
                  data-active={section === item.id || undefined}
                  onClick={() => setSection(item.id)}
                >
                  <Icon name={item.icon} size={15} />
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>

            <div className={s.body}>
            {section === 'appearance' && (
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

                <div className={s.settingRow}>
                  <div className={s.settingText} id="settings-theme-label">
                    <span className={s.rowLabel}>Theme</span>
                    <span className={s.rowHint}>Auto follows your system; Light/Dark locks it in.</span>
                  </div>
                  <div className={`${s.segmented} ${s.settingControl}`} role="radiogroup" aria-labelledby="settings-theme-label">
                    {(['auto', 'light', 'dark'] as ThemeMode[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={themeMode === m}
                        className={`${s.segment} ${themeMode === m ? s.segmentOn : ''}`}
                        onClick={() => chooseThemeMode(m)}
                      >
                        <span>{m === 'auto' ? 'Auto' : m === 'dark' ? 'Dark' : 'Light'}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className={s.settingRow}>
                  <div className={s.settingText} id="settings-accent-label">
                    <span className={s.rowLabel}>Accent color</span>
                    <span className={s.rowHint}>The highlight color used for actions and active states.</span>
                  </div>
                  <div className={`${s.accentControl} ${s.settingControl}`}>
                    <div className={s.swatches} role="radiogroup" aria-labelledby="settings-accent-label">
                      {(Object.keys(ACCENTS) as Exclude<AccentId, 'custom'>[]).map((id) => (
                        <button
                          key={id}
                          type="button"
                          role="radio"
                          aria-checked={accent === id}
                          aria-label={ACCENTS[id].label}
                          title={ACCENTS[id].label}
                          className={`${s.swatch} ${accent === id ? s.swatchOn : ''}`}
                          style={{ '--swatch-color': ACCENTS[id].swatch } as CSSProperties}
                          onClick={() => choosePreset(id)}
                        >
                          <span className={s.swatchDot} aria-hidden />
                        </button>
                      ))}
                      <label
                        className={`${s.swatch} ${s.customSwatch} ${accent === 'custom' ? s.swatchOn : ''}`}
                        style={{ '--swatch-color': customHex } as CSSProperties}
                        title="Custom"
                      >
                        <span className={s.swatchDot} aria-hidden />
                        <input
                          type="color"
                          aria-label="Custom accent color"
                          className={s.colorInput}
                          value={/^#[0-9a-fA-F]{6}$/.test(customHexInput) ? customHexInput : customHex}
                          onChange={(e) => onCustomColorInput(e.target.value)}
                        />
                      </label>
                    </div>
                    <input
                      type="text"
                      inputMode="text"
                      spellCheck={false}
                      aria-label="Custom accent hex value"
                      className={s.hexInput}
                      value={customHexInput}
                      placeholder="#7c5cff"
                      maxLength={7}
                      onChange={(e) => onCustomHexTextChange(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </section>
            )}

            {section === 'library' && (
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
            )}

            {section === 'system' && (
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
            )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
