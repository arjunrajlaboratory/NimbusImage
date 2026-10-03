// Monotonic stale-response guard.
//
// The "increment a counter, capture it before an await, only apply the result
// if the counter hasn't moved" pattern recurs across the async fetch paths
// (annotationListServer.fetchPage, filters.refreshPropertyFilterPassingIds,
// properties.ensureVisiblePropertyValues). Each fires requests that can resolve
// out of order; only the latest may apply its result. This factors that pattern
// into one tested primitive.
//
// Usage:
//   const guard = createSequenceGuard();
//   const token = guard.next();      // a new request begins
//   const result = await fetch();
//   if (guard.isCurrent(token)) {    // a newer request did not supersede us
//     apply(result);
//   }

export interface ISequenceGuard {
  // Begin a new request; returns its token (the latest issued).
  next(): number;
  // True iff `token` is still the most recently issued token.
  isCurrent(token: number): boolean;
}

export function createSequenceGuard(): ISequenceGuard {
  let seq = 0;
  return {
    next() {
      seq += 1;
      return seq;
    },
    isCurrent(token: number) {
      return token === seq;
    },
  };
}
