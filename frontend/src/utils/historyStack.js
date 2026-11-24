const HISTORY_LIMIT = 60;

export function createHistoryStack(limit = HISTORY_LIMIT) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : HISTORY_LIMIT;
  const past = [];
  const future = [];
  return {
    push(snap) {
      past.push(snap);
      if (past.length > max) past.shift();
      future.length = 0;
    },
    undo(current) {
      if (!past.length) return null;
      if (typeof current === 'string') {
        future.push(current);
        if (future.length > max) future.shift();
      }
      return past.pop();
    },
    redo(current) {
      if (!future.length) return null;
      if (typeof current === 'string') {
        past.push(current);
        if (past.length > max) past.shift();
      }
      return future.pop();
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    sizes: () => ({ past: past.length, future: future.length }),
    reset() {
      past.length = 0;
      future.length = 0;
    },
  };
}
