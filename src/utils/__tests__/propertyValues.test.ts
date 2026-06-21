import { describe, it, expect } from "vitest";
import {
  collectLeafPaths,
  idsMissingPaths,
  scopedMergePropertyValues,
  histogramBounds,
} from "@/utils/propertyValues";
import type {
  IAnnotationPropertyValues,
  TPropertyHistogram,
} from "@/store/model";

describe("histogramBounds", () => {
  it("returns the first bin min and last bin max", () => {
    const hist: TPropertyHistogram = [
      { count: 3, min: 11.7, max: 50 },
      { count: 9, min: 50, max: 100 },
      { count: 1, min: 100, max: 7697 },
    ];
    expect(histogramBounds(hist)).toEqual({ min: 11.7, max: 7697 });
  });

  it("returns null for an empty histogram", () => {
    expect(histogramBounds([])).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(histogramBounds(null)).toBeNull();
    expect(histogramBounds(undefined)).toBeNull();
  });
});

describe("collectLeafPaths", () => {
  it("returns one path per flat property", () => {
    expect(collectLeafPaths([{ a: 1, b: 2 }])).toEqual(
      expect.arrayContaining([["a"], ["b"]]),
    );
    expect(collectLeafPaths([{ a: 1, b: 2 }])).toHaveLength(2);
  });

  it("descends into nested values to leaf paths", () => {
    const paths = collectLeafPaths([{ a: { x: 1, y: 2 } }]);
    expect(paths).toEqual(
      expect.arrayContaining([
        ["a", "x"],
        ["a", "y"],
      ]),
    );
    expect(paths).toHaveLength(2);
  });

  it("deduplicates paths across annotations", () => {
    const paths = collectLeafPaths([{ a: 1 }, { a: 2, b: 3 }]);
    expect(paths).toEqual(expect.arrayContaining([["a"], ["b"]]));
    expect(paths).toHaveLength(2);
  });

  it("treats null as a leaf, not a branch", () => {
    expect(collectLeafPaths([{ a: null }])).toEqual([["a"]]);
  });

  it("ignores empty value objects", () => {
    expect(collectLeafPaths([{}])).toEqual([]);
  });
});

describe("idsMissingPaths", () => {
  const cache: IAnnotationPropertyValues = {
    a: { p: 1 },
    b: { p: { sub: 2 } },
  };

  it("flags ids absent from the cache", () => {
    expect(idsMissingPaths(["a", "z"], cache, [["p"]])).toEqual(["z"]);
  });

  it("flags ids missing one of the requested paths", () => {
    expect(idsMissingPaths(["a"], cache, [["p"], ["q"]])).toEqual(["a"]);
  });

  it("returns nothing when all paths are present", () => {
    expect(idsMissingPaths(["a"], cache, [["p"]])).toEqual([]);
    expect(idsMissingPaths(["b"], cache, [["p", "sub"]])).toEqual([]);
  });

  it("returns nothing when there are no paths to satisfy", () => {
    expect(idsMissingPaths(["a", "z"], cache, [])).toEqual([]);
  });
});

describe("scopedMergePropertyValues", () => {
  const prev: IAnnotationPropertyValues = {
    a: { p: 1 },
    b: { p: 2 },
  };

  it("keeps only ids in the keep set", () => {
    const result = scopedMergePropertyValues(prev, [], new Set(["a"]));
    expect(Object.keys(result)).toEqual(["a"]);
    expect(result.a).toEqual({ p: 1 });
  });

  it("overlays new values onto kept ids, merging per id", () => {
    const result = scopedMergePropertyValues(
      prev,
      [{ annotationId: "a", values: { q: 9 } }],
      new Set(["a"]),
    );
    expect(result.a).toEqual({ p: 1, q: 9 });
  });

  it("drops new entries whose id is not in the keep set", () => {
    const result = scopedMergePropertyValues(
      prev,
      [{ annotationId: "c", values: { p: 3 } }],
      new Set(["a"]),
    );
    expect(result).toEqual({ a: { p: 1 } });
  });

  it("does not mutate the previous cache", () => {
    scopedMergePropertyValues(
      prev,
      [{ annotationId: "a", values: { q: 9 } }],
      new Set(["a"]),
    );
    expect(prev.a).toEqual({ p: 1 });
  });
});
