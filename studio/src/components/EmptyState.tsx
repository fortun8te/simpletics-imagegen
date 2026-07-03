// Centered, muted empty state with an optional verb-first CTA.
// Used for "Pick a batch", "No ads yet", etc.
import { Icon } from './Icon';
import styles from './EmptyState.module.css';

interface EmptyStateProps {
  icon?: string;
  title: string;
  hint?: string;
  /** Verb-first CTA; icon defaults to "plus" (e.g. "x" for clear-filter actions). */
  action?: { label: string; onClick: () => void; icon?: string };
}

export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className={styles.wrap}>
      {icon && (
        <span className={styles.icon}>
          <Icon name={icon} size={22} />
        </span>
      )}
      <div className={styles.text}>
        <span className={styles.title}>{title}</span>
        {hint && <span className={styles.hint}>{hint}</span>}
      </div>
      {action && (
        <button type="button" className={styles.action} onClick={action.onClick}>
          <Icon name={action.icon ?? 'plus'} size={15} />
          {action.label}
        </button>
      )}
    </div>
  );
}
