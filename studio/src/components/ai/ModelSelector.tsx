// ModelSelector — ported from ai-sdk-elements. Elements ships a cmdk command-palette; we
// re-implement the same idea (searchable, grouped-by-provider model picker with keyboard nav)
// on the already-installed @radix-ui/react-dropdown-menu + a filter input, so no cmdk/lucide dep.
//
// Two ways to use it:
//  • Convenience API — pass `models`, `value`, `onValueChange` and it renders the whole picker.
//  • Composable API — <ModelSelector><ModelSelectorTrigger/><ModelSelectorContent> …items… —
//    kept for familiarity with the upstream component names.
import { useMemo, useState, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Icon } from '../Icon';
import styles from './ModelSelector.module.css';

export interface ModelOption {
  id: string;
  name: string;
  provider?: string;
  /** Optional short hint (e.g. "fast", "local"). */
  hint?: string;
}

export interface ModelSelectorProps {
  models: ModelOption[];
  value?: string; // selected model id
  onValueChange?: (m: ModelOption) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Footer action row (e.g. a "Custom…" entry). */
  footer?: ReactNode;
  /** Label shown on the trigger when nothing matches value. */
  triggerLabel?: string;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
}

/** Group a flat model list by provider, preserving order. */
function group(models: ModelOption[]): [string, ModelOption[]][] {
  const map = new Map<string, ModelOption[]>();
  for (const m of models) {
    const k = m.provider || '';
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(m);
  }
  return [...map.entries()];
}

export function ModelSelector({
  models, value, onValueChange, placeholder = 'Search models…', disabled,
  footer, triggerLabel, align = 'start', side = 'top',
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = models.find((m) => m.id === value);
  const label = triggerLabel || current?.name || value || 'Select model';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) =>
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      (m.provider || '').toLowerCase().includes(q));
  }, [models, query]);
  const groups = useMemo(() => group(filtered), [filtered]);

  return (
    <DropdownMenu.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={styles.trigger} disabled={disabled} title="Switch the agent model">
          <span className={styles.triggerLabel}>{label}</span>
          <Icon name="chevron-down" size={9} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={styles.content} align={align} side={side} sideOffset={6}>
          <div className={styles.searchRow}>
            <Icon name="search" size={12} />
            <input
              className={styles.search}
              placeholder={placeholder}
              value={query}
              autoFocus
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation(); }}
            />
          </div>
          <div className={styles.list}>
            {groups.length === 0 ? (
              <div className={styles.empty}>No models found</div>
            ) : groups.map(([provider, opts]) => (
              <div key={provider || '_'} className={styles.group}>
                {provider ? <div className={styles.groupHead}>{provider}</div> : null}
                {opts.map((m) => (
                  <DropdownMenu.Item
                    key={m.id}
                    className={styles.item}
                    data-selected={m.id === value || undefined}
                    onSelect={() => onValueChange?.(m)}
                  >
                    <span className={styles.check}>{m.id === value ? <Icon name="check" size={12} /> : null}</span>
                    <span className={styles.name}>{m.name}</span>
                    {m.hint ? <span className={styles.hint}>{m.hint}</span> : null}
                  </DropdownMenu.Item>
                ))}
              </div>
            ))}
          </div>
          {footer ? (
            <>
              <DropdownMenu.Separator className={styles.sep} />
              {footer}
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ── composable re-exports (upstream-familiar names) ──
export const ModelSelectorItem = DropdownMenu.Item;
export const ModelSelectorSeparator = DropdownMenu.Separator;

export default ModelSelector;
