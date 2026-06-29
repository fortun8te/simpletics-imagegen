// Batch view (container). The main scroll area's content. Reads `state`, `ui.view`, and `loading`.
// Three states before the views: first load (skeleton), no batch / empty batch (empty state), and
// then it dispatches to the active view (grid / board / table). Views read the store themselves.
import { useStore } from '../store';
import GridView from './views/GridView';
import BoardView from './views/BoardView';
import TableView from './views/TableView';
import { Skeleton } from './Skeleton';
import { EmptyState } from './EmptyState';

export default function BatchView() {
  const state = useStore((s) => s.state);
  const view = useStore((s) => s.ui.view);
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

  switch (view) {
    case 'board':
      return <BoardView />;
    case 'table':
      return <TableView />;
    case 'grid':
    default:
      return <GridView />;
  }
}
