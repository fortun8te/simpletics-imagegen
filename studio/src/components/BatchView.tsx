// Batch view (container). The main scroll area's content. Three states: first load (skeleton),
// no batch / empty batch (empty state), then the grid gallery. (Board/Table views were removed.)
import { useStore } from '../store';
import GridView from './views/GridView';
import { Skeleton } from './Skeleton';
import { EmptyState } from './EmptyState';

export default function BatchView() {
  const state = useStore((s) => s.state);
  const loading = useStore((s) => s.loading);

  // First load (no state yet) → shimmer placeholders, not a spinner.
  if (loading && !state) return <Skeleton count={8} />;

  // No batch loaded, or a batch with no ads → an inviting, verb-first empty state.
  if (!state || state.ads.length === 0) {
    return (
      <EmptyState
        icon="layout-grid"
        title="Pick a batch"
        hint="Choose a batch from the sidebar to see its images."
      />
    );
  }

  return <GridView />;
}
