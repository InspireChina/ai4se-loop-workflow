export type PageInvalidationAdapter = (path: string, type?: 'page' | 'layout') => void;

type InvalidationGlobal = typeof globalThis & { __loopworkPageInvalidation?: PageInvalidationAdapter };
const runtime = globalThis as InvalidationGlobal;

/** Web composition installs cache invalidation; CLI and recovery hosts need no Web runtime. */
export function installPageInvalidationAdapter(adapter: PageInvalidationAdapter) {
  const previous = runtime.__loopworkPageInvalidation;
  runtime.__loopworkPageInvalidation = adapter;
  return () => {
    if (runtime.__loopworkPageInvalidation === adapter) runtime.__loopworkPageInvalidation = previous;
  };
}

export function invalidatePage(path: string, type?: 'page' | 'layout') {
  try { runtime.__loopworkPageInvalidation?.(path, type); } catch {
    // Cache failure or a call outside a request cannot undo persisted business state.
  }
}
