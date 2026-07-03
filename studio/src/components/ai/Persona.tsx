// Persona — ported from ai-sdk-elements. Elements ships a Rive WebGL avatar; we re-implement the
// same prop surface (state · variant · className) as a lightweight CSS orb so it stays zero-dep
// and on-brand. `state` drives motion (idle/listening/thinking/speaking/asleep); `variant` picks
// a palette. An optional `name`/`label` composes it into an identity row.
import { type ReactNode } from 'react';
import styles from './Persona.module.css';

export type PersonaState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'asleep';
export type PersonaVariant = 'obsidian' | 'mana' | 'opal' | 'halo' | 'glint' | 'command';

export interface PersonaProps {
  state?: PersonaState;
  variant?: PersonaVariant;
  /** Rendered size in px (default 22). */
  size?: number;
  className?: string;
  onReady?: () => void;
}
export function Persona({ state = 'idle', variant = 'obsidian', size = 22, className, onReady }: PersonaProps) {
  return (
    <span
      className={className ? `${styles.orb} ${className}` : styles.orb}
      data-state={state}
      data-variant={variant}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`AI ${state}`}
      ref={onReady ? (() => onReady()) as never : undefined}
    >
      <span className={styles.core} />
      <span className={styles.ring} />
    </span>
  );
}

// PersonaIdentity — a small composed row: the orb + a name / subtitle. Convenience wrapper for
// the agent panel header (not part of the upstream API, kept separate so Persona stays 1:1).
export interface PersonaIdentityProps {
  name: ReactNode;
  subtitle?: ReactNode;
  state?: PersonaState;
  variant?: PersonaVariant;
  size?: number;
  className?: string;
}
export function PersonaIdentity({ name, subtitle, state, variant, size = 22, className }: PersonaIdentityProps) {
  return (
    <span className={className ? `${styles.identity} ${className}` : styles.identity}>
      <Persona state={state} variant={variant} size={size} />
      <span className={styles.idText}>
        <span className={styles.idName}>{name}</span>
        {subtitle ? <span className={styles.idSub}>{subtitle}</span> : null}
      </span>
    </span>
  );
}

export default Persona;
