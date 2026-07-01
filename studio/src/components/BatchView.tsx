// Batch view — routes between Gallery (images) and Plan (creative spec).
import { useStore } from '../store';
import GridView from './views/GridView';
import PlanView from './views/PlanView';
import { Skeleton } from './Skeleton';
import { EmptyState } from './EmptyState';

export default function BatchView() {
  const state = useStore((s) => s.state);
  const loading = useStore((s) => s.loading);
  const brand = useStore((s) => s.brand);
  const batch = useStore((s) => s.batch);
  const batchViewMode = useStore((s) => s.ui.batchViewMode);

  if (!brand || !batch) {
    return (
      <EmptyState
        icon="layout-grid"
        title="Pick a batch"
        hint="Choose a batch from the sidebar to see its images."
      />
    );
  }

  if (loading && !state) return <Skeleton count={8} />;

  if (batchViewMode === 'plan') return <PlanView />;

  if (!state || state.ads.length === 0) {
    return (
      <EmptyState
        icon="layout-grid"
        title="Nothing to show"
        hint="This batch has no generated images yet."
      />
    );
  }

  return <GridView />;
}
