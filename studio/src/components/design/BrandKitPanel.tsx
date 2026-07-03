// BrandKitPanel — MagicPath-style brand style prompt + per-brand agent skill editor.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import styles from './BrandKitPanel.module.css';

interface BrandKitPanelProps {
  brand: string;
  flash: (m: string) => void;
}

export default function BrandKitPanel({ brand, flash }: BrandKitPanelProps) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [skill, setSkill] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!brand) return;
    const [kitR, skillR] = await Promise.all([
      api.getBrandKit(brand),
      api.getBrandSkill(brand),
    ]);
    if (kitR.ok) setPrompt(kitR.kit.prompt || kitR.kit.notes || '');
    if (skillR.ok) setSkill(skillR.text || '');
  }, [brand]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!brand) return;
    setSaving(true);
    try {
      const kitR = await api.getBrandKit(brand);
      const kit = kitR.ok ? { ...kitR.kit, prompt: prompt.trim() } : { colors: [], fonts: [], notes: '', prompt: prompt.trim() };
      const [k, s] = await Promise.all([
        api.saveBrandKit(brand, kit),
        api.saveBrandSkill(brand, skill),
      ]);
      if (k.ok && s.ok) flash('Brand style saved');
      else flash('Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (!brand) return null;

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.toggle} onClick={() => setOpen((v) => !v)}>
        Brand style {open ? '▾' : '▸'}
      </button>
      {open ? (
        <div className={styles.body}>
          <label className={styles.label}>
            Style prompt
            <textarea
              className={styles.area}
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Matte editorial. Headlines bold green. Left text column ~50%, photo right…"
            />
          </label>
          <label className={styles.label}>
            Agent skill
            <textarea
              className={styles.area}
              rows={4}
              value={skill}
              onChange={(e) => setSkill(e.target.value)}
              placeholder="Always use ig-caption pills. CTA bottom-right. Max 2 fonts…"
            />
          </label>
          <button type="button" className={styles.save} disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save brand style'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
