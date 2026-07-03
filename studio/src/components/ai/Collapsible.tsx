// Collapsible — a tiny local disclosure primitive (no @radix-ui/react-collapsible dependency).
// Mirrors the Radix Collapsible composable shape (Root / Trigger / Content) so the ported
// AI-SDK-elements components read familiarly, but stays zero-dep and theme-token driven.
//
// Root owns open state (controlled `open` or uncontrolled `defaultOpen`). Content animates its
// height via a CSS grid-rows trick (0fr → 1fr) which degrades to an instant toggle under
// prefers-reduced-motion. Context lets Trigger/Content read state without prop drilling.
import {
  createContext, useContext, useState, useCallback, useMemo,
  type ReactNode, type ButtonHTMLAttributes, type HTMLAttributes,
} from 'react';
import styles from './Collapsible.module.css';

interface Ctx { open: boolean; setOpen: (v: boolean) => void; toggle: () => void }
const CollapsibleCtx = createContext<Ctx | null>(null);
export const useCollapsible = () => {
  const c = useContext(CollapsibleCtx);
  if (!c) throw new Error('Collapsible parts must be used within <Collapsible>');
  return c;
};

interface RootProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}
export function Collapsible({ open: controlled, defaultOpen = false, onOpenChange, children, className, ...rest }: RootProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const open = controlled ?? uncontrolled;
  const setOpen = useCallback((v: boolean) => {
    if (controlled === undefined) setUncontrolled(v);
    onOpenChange?.(v);
  }, [controlled, onOpenChange]);
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  const ctx = useMemo(() => ({ open, setOpen, toggle }), [open, setOpen, toggle]);
  return (
    <CollapsibleCtx.Provider value={ctx}>
      <div className={className} data-state={open ? 'open' : 'closed'} {...rest}>{children}</div>
    </CollapsibleCtx.Provider>
  );
}

interface TriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> { children: ReactNode }
export function CollapsibleTrigger({ children, onClick, className, ...rest }: TriggerProps) {
  const { open, toggle } = useCollapsible();
  return (
    <button
      type="button"
      aria-expanded={open}
      data-state={open ? 'open' : 'closed'}
      className={className}
      onClick={(e) => { onClick?.(e); if (!e.defaultPrevented) toggle(); }}
      {...rest}
    >
      {children}
    </button>
  );
}

interface ContentProps extends HTMLAttributes<HTMLDivElement> { children: ReactNode }
export function CollapsibleContent({ children, className, ...rest }: ContentProps) {
  const { open } = useCollapsible();
  return (
    <div className={styles.wrap} data-state={open ? 'open' : 'closed'} aria-hidden={!open} {...rest}>
      <div className={styles.inner}>
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}
