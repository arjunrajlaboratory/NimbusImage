/**
 * Change identities for the large id collections that filter state carries.
 *
 * Several watchers key off "has the query changed?" by comparing a serialized
 * form of filter state. Those filters can hold tens of thousands of annotation
 * ids — a select-all selection filter, an annotation-id filter, a resolved
 * analysis gate — and the getters they read are rebuilt on every reactive
 * touch, including frame changes they read but do not use. `JSON.stringify` on
 * that builds and discards megabytes of string per Z-scrub, so these hash
 * instead.
 *
 * The identity must be EXACT, not sampled. An earlier version compared length
 * plus the first, middle and last id; two same-length sets differing only in an
 * unsampled position collided, and the watchers then skipped a refetch of the
 * server-backed list and — worse — skipped clearing the annotation selection,
 * leaving hidden rows for a later bulk action to operate on. Hashing every id is
 * O(n) but allocates nothing: ~1M character operations for a 50k-id set, well
 * inside a frame, and only paid while a filter of that size is actually active.
 */

/**
 * Incremental cyrb53: a fast, well-distributed 53-bit hash. Two independent
 * 32-bit lanes are mixed at the end, so the result is far past
 * birthday-collision range for the set sizes involved here.
 *
 * Streaming rather than string-building on purpose — the whole point is to
 * derive an identity for tens of thousands of values without allocating.
 */
export function createHasher() {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  let count = 0;
  const feedString = (value: string) => {
    for (let i = 0; i < value.length; i++) {
      const ch = value.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    // Separator, so ("ab","c") and ("a","bc") cannot hash alike.
    h1 = Math.imul(h1 ^ 0x1f, 2246822507);
    h2 = Math.imul(h2 ^ 0x1f, 3266489909);
  };
  return {
    feedString,
    feedNumber(value: number) {
      h1 = Math.imul(h1 ^ (value | 0), 2654435761);
      h2 = Math.imul(h2 ^ (value | 0), 1597334677);
      h1 = Math.imul(h1 ^ 0x1f, 2246822507);
      h2 = Math.imul(h2 ^ 0x1f, 3266489909);
    },
    countItem() {
      count++;
    },
    digest(): string {
      const m1 =
        Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
        Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      const m2 =
        Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
        Math.imul(m1 ^ (m1 >>> 13), 3266489909);
      const value = 4294967296 * (2097151 & m2) + (m1 >>> 0);
      return `${count}:${value.toString(36)}`;
    },
  };
}

function hashIds(length: number, read: (index: number) => string) {
  const hasher = createHasher();
  for (let i = 0; i < length; i++) {
    hasher.feedString(read(i));
    hasher.countItem();
  }
  return hasher.digest();
}

/**
 * Memo keyed by array identity.
 *
 * Safe because every id collection here is replaced WHOLESALE when it changes —
 * `addSelectionAsFilter`, `newAnnotationIdFilter` and `setAnalysisGateIds` all
 * build fresh arrays — so a stable reference means stable contents. It matters
 * because `currentFiltersSignature` is re-evaluated on every frame change
 * (`currentFilters` reads xy/z/time unconditionally) while the underlying id
 * arrays usually have not moved.
 *
 * If you ever mutate one of these arrays in place, this memo goes stale — build
 * a new array instead.
 */
const listCache = new WeakMap<readonly string[], string>();

/** Exact change identity for a list of ids. */
export function idListSignature(ids: readonly string[]): string {
  const cached = listCache.get(ids);
  if (cached !== undefined) {
    return cached;
  }
  const signature = hashIds(ids.length, (i) => ids[i]);
  listCache.set(ids, signature);
  return signature;
}

/**
 * The same identity for a collection of objects keyed by `id`.
 *
 * Not memoized: the populations this is used on are rebuilt as a fresh array on
 * every getter evaluation, so an identity-keyed memo would never hit.
 */
export function idSignatureOf(items: readonly { id: string }[]): string {
  return hashIds(items.length, (i) => items[i].id);
}
