import { describe, it, expect } from "vitest";
import {
  collectLeafPaths,
  idsMissingPaths,
  scopedMergePropertyValues,
  histogramBounds,
  uncomputedCountRequest,
  selectUncomputedCount,
  coerceUncomputedCounts,
} from "@/utils/propertyValues";

describe("coerceUncomputedCounts", () => {
  it("returns a clean numeric map for a well-formed response", () => {
    expect(coerceUncomputedCounts({ propA: 3, propB: 0 })).toEqual({
      propA: 3,
      propB: 0,
    });
  });

  it("drops non-numeric entries", () => {
    expect(
      coerceUncomputedCounts({ propA: 3, propB: "x", propC: null }),
    ).toEqual({ propA: 3 });
  });

  it("returns an empty map for non-object input", () => {
    expect(coerceUncomputedCounts(null)).toEqual({});
    expect(coerceUncomputedCounts(undefined)).toEqual({});
    expect(coerceUncomputedCounts("nope")).toEqual({});
    expect(coerceUncomputedCounts([1, 2, 3])).toEqual({});
  });
});
import type {
  IAnnotationProperty,
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

  it("treats an array value as a leaf (does not index into it)", () => {
    // Finding 12: collectLeafPaths stops at an array (array == leaf), so a path
    // that tries to descend INTO an array by index is not a real path. valueAtPath
    // must agree and treat that as missing rather than reading arr["0"].
    const arrCache: IAnnotationPropertyValues = {
      a: { p: { Area: [1, 2, 3] } as unknown as number },
    };
    expect(idsMissingPaths(["a"], arrCache, [["p", "Area", "0"]])).toEqual([
      "a",
    ]);
  });

  it("returns present when a path resolves to an array leaf", () => {
    const arrCache: IAnnotationPropertyValues = {
      a: { p: { Area: [1, 2, 3] } as unknown as number },
    };
    expect(idsMissingPaths(["a"], arrCache, [["p", "Area"]])).toEqual([]);
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

  it("retains nested sibling paths fetched in separate requests", () => {
    const result = scopedMergePropertyValues(
      { a: { spatial: { CD3E: 3 } } },
      [{ annotationId: "a", values: { spatial: { MS4A1: 5 } } }],
      new Set(["a"]),
    );
    expect(result.a).toEqual({ spatial: { CD3E: 3, MS4A1: 5 } });
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

describe("uncomputedCountRequest", () => {
  const makeProperty = (
    id: string,
    shape: string,
    tags: string[],
    exclusive: boolean,
  ): IAnnotationProperty =>
    ({
      id,
      name: id,
      image: "img",
      shape,
      tags: { tags, exclusive },
      workerInterface: {},
    }) as unknown as IAnnotationProperty;

  it("projects each property to id, shape and tags", () => {
    const properties = [
      makeProperty("p1", "point", ["nucleus"], false),
      makeProperty("p2", "polygon", [], true),
    ];
    expect(uncomputedCountRequest(properties)).toEqual([
      {
        id: "p1",
        shape: "point",
        tags: { tags: ["nucleus"], exclusive: false },
      },
      { id: "p2", shape: "polygon", tags: { tags: [], exclusive: true } },
    ]);
  });

  it("keeps the tags object shape (does not flatten it)", () => {
    const [entry] = uncomputedCountRequest([
      makeProperty("p1", "point", ["a", "b"], true),
    ]);
    expect(entry.tags).toEqual({ tags: ["a", "b"], exclusive: true });
  });

  it("returns an empty array for no properties", () => {
    expect(uncomputedCountRequest([])).toEqual([]);
  });
});

describe("selectUncomputedCount", () => {
  it("uses the server count in lazy mode", () => {
    expect(selectUncomputedCount(true, 7, 0)).toBe(7);
  });

  it("falls back to 0 when the server count is missing in lazy mode", () => {
    expect(selectUncomputedCount(true, undefined, 5)).toBe(0);
  });

  it("uses the client count when not in lazy mode", () => {
    expect(selectUncomputedCount(false, 7, 3)).toBe(3);
  });
});
