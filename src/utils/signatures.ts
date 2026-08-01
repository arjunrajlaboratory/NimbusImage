/**
 * Cheap identities for the large id collections that filter state carries.
 *
 * Several watchers key off "has the query changed?" by serializing filter
 * state. Those filters can hold tens of thousands of annotation ids — a
 * select-all selection filter, an annotation-id filter, a resolved analysis
 * gate — and the getters they read are rebuilt on every reactive touch,
 * including frame changes they read but do not use. Serializing the ids
 * wholesale therefore builds and discards megabytes of JSON on every Z-scrub.
 *
 * Sampling instead is constant-cost. Length alone is NOT enough: scrubbing a
 * frame under "current frame only" routinely swaps a set for a different one of
 * the same size, so fixed positions come along too.
 */

/** Length plus the first, middle and last id. */
export function idListSignature(ids: readonly string[]): string {
  const n = ids.length;
  if (n === 0) {
    return "0";
  }
  return `${n}:${ids[0]},${ids[n >> 1]},${ids[n - 1]}`;
}

/** The same identity for a collection of objects keyed by `id`. */
export function idSignatureOf(items: readonly { id: string }[]): string {
  const n = items.length;
  if (n === 0) {
    return "0";
  }
  return `${n}:${items[0].id},${items[n >> 1].id},${items[n - 1].id}`;
}
