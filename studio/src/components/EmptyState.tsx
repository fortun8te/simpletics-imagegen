// Centered, muted empty state with an optional verb-first CTA.
// Used for "Pick a batch", "No ads yet", etc.
import { Icon } from './Icon';
import styles from './EmptyState.module.css';

interface EmptyStateProps {
  icon?: string;
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
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
          <Icon name="plus" size={15} />
          {action.label}
        </button>
      )}
    </div>
  );
}
