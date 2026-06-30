// Refetch the current batch state and push it into the store. Called after mutating actions
// (cancel/reset) AND by the SSE/poll loop in App, so the UI reflects backend state immediately
// rather than waiting for an SSE tick that may never fire if the store is unchanged.
import { useStore } from './store';
import { api } from './api';

export function refreshState() {
  const { brand, batch, setState } = useStore.getState();
  if (brand && batch) return api.getState(brand, batch).then(setState);
}
