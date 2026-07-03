# Working indicator (image generation)

Canonical UI for **live Codex / image-queue activity**. When images are generating, waiting, or queued — use this, not one-off spinners or custom keyframes.

**Do not use** in Design mode (layout extraction, design agent, NewCompFlow). That surface is being redesigned separately.

---

## Components

| Export | Use |
|--------|-----|
| `WorkingDot` | Inline status dot only (activity rows, TopBar) |
| `WorkingIndicator` | Dot + label + optional meta (`"Generating"`, `"3/12"`, ETA) |
| `WorkingPill` | Glass pill button wrapper (collapsed ActivityDock) |

Import from `src/components/WorkingIndicator.tsx`.  
Styles live in `WorkingIndicator.module.css` — **do not duplicate** `activityPing` elsewhere.

---

## Tones

| `tone` | Meaning | Dot |
|--------|---------|-----|
| `active` | Codex running / generating | Accent + ping ring |
| `waiting` | Grace window before spend | Muted accent |
| `queued` | In queue | Faint |
| `paused` | Run paused | Warn |
| `failed` | Job failed | Err |

Only `active` gets the expanding-ring animation.

---

## Where it's wired today

- **TopBar** — run progress (`done/total` + ETA) while batch is running
- **ActivityDock** — collapsed pill + per-row status dots
- **SlotCard** — `generating` state (replaces standalone `Spinner` for the status row)

---

## When adding new image-gen UI

```tsx
import { WorkingDot, WorkingIndicator } from './WorkingIndicator';

// Row in a list
<WorkingIndicator label="Generating" meta="1:24" tone="active" muted />

// TopBar-style compact
<span className={progressClass}>
  <WorkingDot tone="active" />
  <span>5/12</span>
</span>
```

**Avoid:** `Spinner` for queue/generation status (Spinner is OK for one-off page loads).  
**Avoid:** copying `@keyframes activityPing` into other CSS modules.

---

## Reduced motion

Ping animation is disabled when `prefers-reduced-motion: reduce` or `[data-reduced-motion="true"]` on `<html>`. Dot stays visible; no ring.
