/**
 * These signatures decide whether a watcher treats the query as changed, so a
 * collision is not a performance detail — it silently skips a refetch of the
 * server-backed annotation list and, worse, skips clearing the annotation
 * selection, leaving hidden rows for a later bulk action to operate on.
 *
 * An earlier version compared length plus the first, middle and last id. Every
 * "differs only at an unsampled position" case below collided under it.
 */
import { describe, it, expect } from "vitest";
import { idListSignature, idSignatureOf } from "@/utils/signatures";

const ids = (...values: string[]) => values;

describe("idListSignature", () => {
  it("differs when a same-length list changes at an unsampled position", () => {
    // first (0), middle (2) and last (4) are identical in both.
    expect(idListSignature(ids("a", "X", "c", "d", "e"))).not.toBe(
      idListSignature(ids("a", "Y", "c", "d", "e")),
    );
  });

  it("differs when only the second-to-last id changes", () => {
    expect(idListSignature(ids("a", "b", "c", "X", "e"))).not.toBe(
      idListSignature(ids("a", "b", "c", "Y", "e")),
    );
  });

  it("differs for realistic ObjectIds varying only in the middle", () => {
    const base = [
      "6a628ed5505f0ded1b025063",
      "6a628ed5505f0ded1b025064",
      "6a628ed5505f0ded1b025065",
      "6a628ed5505f0ded1b025066",
      "6a628ed5505f0ded1b025067",
    ];
    const swapped = [...base];
    swapped[1] = "6a628ed5505f0ded1b0250ff";
    expect(idListSignature(base)).not.toBe(idListSignature(swapped));
  });

  it("distinguishes a reordering", () => {
    expect(idListSignature(ids("a", "b", "c"))).not.toBe(
      idListSignature(ids("a", "c", "b")),
    );
  });

  it("cannot be fooled by moving a boundary between ids", () => {
    // Without a separator in the hash, ["ab","c"] and ["a","bc"] hash alike.
    expect(idListSignature(ids("ab", "c"))).not.toBe(
      idListSignature(ids("a", "bc")),
    );
  });

  it("is stable for equal contents and distinguishes length", () => {
    expect(idListSignature(ids("a", "b"))).toBe(idListSignature(ids("a", "b")));
    expect(idListSignature(ids("a", "b"))).not.toBe(
      idListSignature(ids("a", "b", "c")),
    );
    expect(idListSignature([])).toBe(idListSignature([]));
  });

  it("gives every member of a large set influence over the result", () => {
    // Sampling made all but three positions invisible; this fails loudly if a
    // future "optimization" reintroduces it.
    const base = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    const signatures = new Set<string>();
    for (let i = 0; i < base.length; i++) {
      const variant = [...base];
      variant[i] = "changed";
      signatures.add(idListSignature(variant));
    }
    expect(signatures.size).toBe(base.length);
  });
});

describe("idSignatureOf", () => {
  const objs = (...values: string[]) => values.map((id) => ({ id }));

  it("differs when a same-length population changes at an unsampled position", () => {
    expect(idSignatureOf(objs("a", "X", "c", "d", "e"))).not.toBe(
      idSignatureOf(objs("a", "Y", "c", "d", "e")),
    );
  });

  it("is stable for equal contents and handles empty", () => {
    expect(idSignatureOf(objs("a", "b"))).toBe(idSignatureOf(objs("a", "b")));
    expect(idSignatureOf([])).toBe(idSignatureOf([]));
  });

  it("agrees with idListSignature for the same ids", () => {
    // The two must not drift: they feed watchers compared against each other's
    // outputs only indirectly, but a divergence would be very confusing.
    expect(idSignatureOf(objs("a", "b", "c"))).toBe(
      idListSignature(ids("a", "b", "c")),
    );
  });
});
