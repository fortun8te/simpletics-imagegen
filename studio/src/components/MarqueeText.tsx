// Truncated label that reveals the full string on hover: instantly via a Radix tooltip
// (always available, so reading a truncated name never depends on a possibly-stale overflow
// measurement racing web-font load), plus a gentle horizontal marquee scroll as a bonus when
// the text actually overflows.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import s from './MarqueeText.module.css';

type Props = {
  children: ReactNode;
  className?: string;
  tip?: string;
};

export default function MarqueeText({ children, className, tip }: Props) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [hover, setHover] = useState(false);
  const [scrollPx, setScrollPx] = useState(0);

  const label = tip ?? (typeof children === 'string' ? children : '');

  useEffect(() => {
    const wrap = wrapRef.current;
    const text = textRef.current;
    if (!wrap || !text) return;

    const measure = () => {
      const dist = Math.max(0, text.scrollWidth - wrap.clientWidth);
      setOverflow(dist > 1);
      setScrollPx(dist);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    ro.observe(text);
    // Re-measure once web fonts finish loading — Geist/Fraunces load async, and a measurement
    // taken against the fallback system font (before swap) can under- or over-report overflow;
    // ResizeObserver doesn't reliably refire for a font-swap that doesn't change the box's own
    // dimensions, so without this the marquee scroll can silently stay off after font load.
    document.fonts?.ready?.then(measure).catch(() => {});
    return () => ro.disconnect();
  }, [children]);

  const body = (
    <span
      ref={wrapRef}
      className={`${s.wrap} ${overflow ? s.wrapClip : ''} ${className ?? ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <span
        ref={textRef}
        className={`${s.text} ${overflow && hover ? s.textScroll : ''}`}
        style={
          overflow && hover
            ? ({ '--marquee-dist': `${scrollPx}px` } as CSSProperties)
            : undefined
        }
      >
        {children}
      </span>
    </span>
  );

  // Tooltip is unconditional (not gated on the `overflow` measurement) so hovering ALWAYS
  // reveals the full name immediately — reading a name never depends on JS overflow detection
  // having landed correctly. The marquee scroll above stays conditional (`overflow && hover`);
  // it's a bonus animation, not the primary reveal mechanism.
  if (!label) return body;

  return (
    <Tooltip.Root delayDuration={120}>
      <Tooltip.Trigger asChild>{body}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={s.tip} side="right" align="center" sideOffset={8}>
          {label}
          <Tooltip.Arrow className={s.tipArrow} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
