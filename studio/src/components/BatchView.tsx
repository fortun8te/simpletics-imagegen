// Batch view — hosts the three top-level panes (Images / Plan / Design).
//
// STATE-2: all three panes stay MOUNTED for the life of the app and are toggled with CSS
// `display:none` (the codebase's Radix `Dialog.Root open={…}` pattern applied to panes). The old
// implementation early-returned exactly one of Design / Plan / Images, so every top-level tab
// switch fully unmounted the other two — throwing away PlannerRail's brief draft + proposal
// (STATE-3), the Plan/Grid scroll position, and any in-flight local state, and forcing a refetch
// on return. Keeping them mounted means Plan→Images→Plan preserves the draft with zero refetch.
//
// Each pane receives an `active` flag so its scroll-tracking IntersectionObserver + adCursor writes
// only run while it is the visible pane (STATE-24) — a hidden (`display:none`) subtree has zero-size
// rects and would otherwise fight the visible pane over the single shared adCursor.
import { useStore } from '../store';
import GridView from './views/GridView';
import PlanView from './views/PlanView';
import DesignView from './views/DesignView';
import BatchHero from './BatchHero';
import { Skeleton } from './Skeleton';
import { EmptyState } from './EmptyState';

// A mounted-but-hidden pane. `display:none` unmounts nothing (state persists) but drops the subtree
// from layout/hit-testing so only the active pane is interactive and measurable.
function Pane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div style={active ? undefined : { display: 'none' }}>{children}</div>;
}

export default function BatchView() {
  const state = useStore((s) => s.state);
  const loading = useStore((s) => s.loading);
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const batchViewMode = useStore((s) => s.ui.batchViewMode);

  const hasSelection = !!brand && !!batch;
  const showDesign = batchViewMode === 'design';
  const showPlan = batchViewMode === 'plan';
  const showImages = batchViewMode === 'gallery';

  // Images-pane inner state: skeleton while the first load is in flight, empty state when the batch
  // has no images. Computed here so the pane stays mounted (only its contents swap).
  const imagesEmpty = hasSelection && (!state || state.ads.length === 0);
  const imagesLoading = loading && !state;

  return (
    <>
      {/* Design mode is independent of batch selection. */}
      <Pane active={showDesign}>
        <DesignView />
      </Pane>

      {/* Plan — always mounted so PlannerRail's brief draft + proposal survive tab switches. */}
      <Pane active={showPlan}>
        {hasSelection ? (
          <>
            <BatchHero />
            <PlanView active={showPlan} />
          </>
        ) : (
          <EmptyState
            icon="layout-grid"
            title="Pick a batch"
            hint="Choose a batch from the sidebar to see its plan."
          />
        )}
      </Pane>

      {/* Images (gallery grid). */}
      <Pane active={showImages}>
        {!hasSelection ? (
          <EmptyState
            icon="layout-grid"
            title="Pick a batch"
            hint="Choose a batch from the sidebar to see its images."
          />
        ) : imagesLoading ? (
          <Skeleton count={8} />
        ) : imagesEmpty ? (
          <EmptyState
            icon="photo"
            title="Nothing to show"
            hint="This batch has no generated images yet."
          />
        ) : (
          <>
            <BatchHero />
            <GridView active={showImages} />
          </>
        )}
      </Pane>
    </>
  );
}
