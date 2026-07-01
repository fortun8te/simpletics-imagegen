// Truncated label that reveals the full string on hover via a gentle horizontal scroll.
// Falls back to ellipsis + Radix tooltip when text overflows; no-op when it fits.
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

  if (!overflow || !label) return body;

  return (
    <Tooltip.Root delayDuration={500}>
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
