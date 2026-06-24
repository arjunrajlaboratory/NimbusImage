import { describe, it, expect, vi } from "vitest";
import {
  hashString,
  selectStableSubset,
  selectLargestBySize,
  drawnFeatureUnchanged,
  estimateAnnotationRadius,
  getStubStyleFromBaseStyle,
  annotationTestPoints,
  idsNeedingHydration,
  stubFromAnnotation,
  planHydrationEvictions,
  coordinatesFingerprint,
  geometryKeyForRender,
  shapeNeedsHydration,
  drawnFeatureUsesDotStyle,
} from "../annotation";
import { IAnnotation, TAnnotationOrStub, AnnotationShape } from "@/store/model";

vi.mock("geojs", () => ({
  default: {
    util: {
      convertColor: vi.fn((color: string) => {
        if (color === "red") return { r: 1, g: 0, b: 0 };
        return { r: 0.5, g: 0.5, b: 0.5 };
      }),
    },
  },
}));

describe("hashString", () => {
  it("returns a number", () => {
    expect(typeof hashString("test")).toBe("number");
  });

  it("is deterministic", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
  });

  it("returns unsigned 32-bit integer", () => {
    const hash = hashString("test");
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });

  it("produces different hashes for different strings", () => {
    expect(hashString("a")).not.toBe(hashString("b"));
  });
});

describe("selectStableSubset", () => {
  it("returns all if under limit", () => {
    const ids = ["a", "b", "c"];
    expect(selectStableSubset(ids, 5)).toEqual(ids);
  });

  it("returns exactly maxCount if over limit", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
    expect(selectStableSubset(ids, 10)).toHaveLength(10);
  });

  it("is deterministic", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
    expect(selectStableSubset(ids, 10)).toEqual(selectStableSubset(ids, 10));
  });

  it("selects exactly the maxCount lowest-hash ids", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    const k = 10;
    const expected = [...ids]
      .sort((a, b) => hashString(a) - hashString(b))
      .slice(0, k);
    expect(new Set(selectStableSubset(ids, k))).toEqual(new Set(expected));
  });

  it("selects the same set regardless of input order", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    const shuffled = [...ids].reverse();
    expect(new Set(selectStableSubset(ids, 10))).toEqual(
      new Set(selectStableSubset(shuffled, 10)),
    );
  });
});

describe("selectLargestBySize", () => {
  const sizeMap: Record<string, number> = {
    a: 10,
    b: 30,
    c: 20,
    d: 5,
    e: 30, // tie with b
  };
  const sizeOf = (id: string) => sizeMap[id] ?? 0;

  it("returns all ids when count >= length", () => {
    const ids = ["a", "b", "c"];
    expect(selectLargestBySize(ids, sizeOf, 5)).toEqual(ids);
  });

  it("returns exactly count ids when over the limit", () => {
    expect(
      selectLargestBySize(["a", "b", "c", "d", "e"], sizeOf, 2),
    ).toHaveLength(2);
  });

  it("selects the count largest by size", () => {
    // sizes: b=30, e=30, c=20, a=10, d=5 → top 3 by size are {b, e, c}
    expect(
      new Set(selectLargestBySize(["a", "b", "c", "d", "e"], sizeOf, 3)),
    ).toEqual(new Set(["b", "e", "c"]));
  });

  it("breaks size ties deterministically by ascending hash (pan-stable)", () => {
    // b and e both have size 30. With count=1, the one chosen must be the
    // lower-hash of the two, regardless of input order.
    const lowerHash = hashString("b") < hashString("e") ? "b" : "e";
    expect(selectLargestBySize(["a", "b", "c", "d", "e"], sizeOf, 1)).toEqual([
      lowerHash,
    ]);
    expect(selectLargestBySize(["e", "d", "c", "b", "a"], sizeOf, 1)).toEqual([
      lowerHash,
    ]);
  });

  it("returns an empty array for count 0", () => {
    expect(selectLargestBySize(["a", "b"], sizeOf, 0)).toEqual([]);
  });

  it("matches a brute-force reference on a large tie-heavy input", () => {
    // Sizes drawn from a tiny set ⇒ heavy ties; exercises the tie-break and the
    // selection's eviction path well beyond the toy fixture above.
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    const sizeOf2 = (id: string) => Number(id.slice(3)) % 5;
    const k = 37;
    const reference = [...ids]
      .map((id) => ({ id, s: sizeOf2(id), h: hashString(id) }))
      .sort((a, b) => b.s - a.s || a.h - b.h)
      .slice(0, k)
      .map((x) => x.id);
    expect(new Set(selectLargestBySize(ids, sizeOf2, k))).toEqual(
      new Set(reference),
    );
  });
});

describe("coordinatesFingerprint", () => {
  it("is stable for identical coordinates", () => {
    const a = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ];
    const b = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ];
    expect(coordinatesFingerprint(a)).toBe(coordinatesFingerprint(b));
  });

  it("changes when a vertex moves", () => {
    const before = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ];
    const after = [
      { x: 1, y: 2 },
      { x: 3, y: 5 },
    ];
    expect(coordinatesFingerprint(before)).not.toBe(
      coordinatesFingerprint(after),
    );
  });

  it("changes when the vertex count changes", () => {
    const fewer = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ];
    const more = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
    ];
    expect(coordinatesFingerprint(fewer)).not.toBe(
      coordinatesFingerprint(more),
    );
  });

  it("detects sub-integer (fractional) vertex moves", () => {
    const before = [{ x: 100.001, y: 200 }];
    const after = [{ x: 100.002, y: 200 }];
    expect(coordinatesFingerprint(before)).not.toBe(
      coordinatesFingerprint(after),
    );
  });
});

describe("geometryKeyForRender", () => {
  it("keys a hydrated annotation off its coordinates", () => {
    const before = {
      id: "a",
      color: "red",
      coordinates: [{ x: 0, y: 0 }],
    } as any;
    const after = {
      id: "a",
      color: "red",
      coordinates: [{ x: 9, y: 9 }],
    } as any;
    expect(geometryKeyForRender(before)).not.toBe(geometryKeyForRender(after));
  });

  it("keys a stub off its centroid", () => {
    const before = { id: "a", color: "red", centroid: { x: 0, y: 0 } } as any;
    const after = { id: "a", color: "red", centroid: { x: 9, y: 9 } } as any;
    expect(geometryKeyForRender(before)).not.toBe(geometryKeyForRender(after));
  });
});

describe("drawnFeatureUnchanged", () => {
  // Stub renders as a dot at its centroid; hydrated renders its coordinates.
  const stub = { id: "a", color: "red", centroid: { x: 0, y: 0 } } as any;
  const hydrated = {
    id: "a",
    color: "red",
    coordinates: [{ x: 0, y: 0 }],
  } as any;
  const stubKey = geometryKeyForRender(stub);
  const hydratedKey = geometryKeyForRender(hydrated);

  it("returns false when the layer no longer exists", () => {
    expect(drawnFeatureUnchanged(false, stub, "red", true, stubKey)).toBe(
      false,
    );
  });

  it("returns false when the annotation is no longer displayed (no layerData)", () => {
    expect(drawnFeatureUnchanged(true, undefined, "red", true, stubKey)).toBe(
      false,
    );
  });

  it("returns false when the color changed", () => {
    expect(drawnFeatureUnchanged(true, stub, "blue", true, stubKey)).toBe(
      false,
    );
  });

  it("returns false when a stub became hydrated (dot → shape)", () => {
    // drawn as a stub (drawnIsStub=true) but layerData is now hydrated
    expect(
      drawnFeatureUnchanged(true, hydrated, "red", true, hydratedKey),
    ).toBe(false);
  });

  it("returns false when a hydrated annotation became a stub (shape → dot)", () => {
    expect(drawnFeatureUnchanged(true, stub, "red", false, stubKey)).toBe(
      false,
    );
  });

  it("returns false when the geometry changed (in-place coordinate edit)", () => {
    const edited = {
      id: "a",
      color: "red",
      coordinates: [{ x: 50, y: 50 }],
    } as any;
    // Feature was drawn with the old hydratedKey; layerData now has new coords.
    expect(drawnFeatureUnchanged(true, edited, "red", false, hydratedKey)).toBe(
      false,
    );
  });

  it("keeps an unchanged stub (the stub-only-mode case the old code dropped)", () => {
    expect(drawnFeatureUnchanged(true, stub, "red", true, stubKey)).toBe(true);
  });

  it("keeps an unchanged hydrated annotation", () => {
    expect(
      drawnFeatureUnchanged(true, hydrated, "red", false, hydratedKey),
    ).toBe(true);
  });
});

describe("estimateAnnotationRadius", () => {
  it("returns default for single point", () => {
    expect(estimateAnnotationRadius([{ x: 10, y: 20 }])).toBe(5);
  });

  it("computes max bbox half-extent for polygon", () => {
    const coords = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    // max(width, height) / 2 = max(10, 10) / 2 = 5
    expect(estimateAnnotationRadius(coords)).toBe(5);
  });

  it("uses the larger dimension for non-square bbox", () => {
    const coords = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 0, y: 10 },
    ];
    // max(20, 10) / 2 = 10
    expect(estimateAnnotationRadius(coords)).toBe(10);
  });
});

describe("getStubStyleFromBaseStyle", () => {
  it("matches the full-annotation edge stroke (width and opacity)", () => {
    // The stub circle should read like the real annotation's outline, not a
    // thinner/lighter variant — only its shape (circle) and fill distinguish it.
    const style = getStubStyleFromBaseStyle();
    expect(style.strokeWidth).toBe(4);
    expect(style.strokeOpacity).toBe(1);
  });

  it("thickens the stroke when selected, matching full annotations", () => {
    const style = getStubStyleFromBaseStyle(undefined, false, true);
    expect(style.strokeWidth).toBe(6);
  });

  it("thickens the stroke when hovered, matching full annotations", () => {
    const style = getStubStyleFromBaseStyle(undefined, true, false);
    expect(style.strokeWidth).toBe(5);
  });

  it("matches the full-annotation fill opacity (defaults to 0.5, honors the passed value)", () => {
    // The stub fill should equal the real annotation's (store.annotationOpacity,
    // threaded in by the caller); the default mirrors the full-annotation default.
    expect(getStubStyleFromBaseStyle().fillOpacity).toBe(0.5);
    expect(
      getStubStyleFromBaseStyle(undefined, false, false, 5, 1, 0.3).fillOpacity,
    ).toBe(0.3);
  });

  it("uses default radius of 5 when no estimatedRadius provided", () => {
    const style = getStubStyleFromBaseStyle();
    expect(style.radius).toBe(5);
  });

  it("uses estimatedRadius when provided", () => {
    const style = getStubStyleFromBaseStyle(undefined, false, false, 20);
    expect(style.radius).toBe(20);
  });

  it("uses estimatedRadius as-is without minimum", () => {
    const style = getStubStyleFromBaseStyle(undefined, false, false, 1);
    expect(style.radius).toBe(1);
  });

  it("applies annotation color when provided", () => {
    const style = getStubStyleFromBaseStyle("red");
    expect(style.fillColor).toBe("red");
  });

  it("defaults scaled to 1 when not provided", () => {
    expect(getStubStyleFromBaseStyle().scaled).toBe(1);
  });

  it("applies the provided scaled value so stubs track world size", () => {
    // estimatedRadius is in world units; a GeoJS point with scaled=N renders
    // radius * 2^(zoom - N), which matches the annotation's true footprint only
    // when N = log2(unitsPerPixel(0)) (e.g. 5 for a unitsPerPixel(0)=32 pyramid).
    const style = getStubStyleFromBaseStyle(undefined, false, false, 20, 5);
    expect(style.scaled).toBe(5);
    expect(style.radius).toBe(20);
  });
});

describe("annotationTestPoints", () => {
  // Minimal fixtures: annotationTestPoints only reads `coordinates` and uses
  // isHydratedAnnotation ("coordinates" in obj) to distinguish hydrated vs stub.
  const hydrated = (coordinates: { x: number; y: number }[]) =>
    ({ coordinates }) as unknown as TAnnotationOrStub;
  const stub = () => ({}) as unknown as TAnnotationOrStub;

  it("returns the annotation coordinates when present", () => {
    const coords = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ];
    expect(annotationTestPoints(hydrated(coords), undefined)).toBe(coords);
  });

  it("falls back to the centroid when coordinates are absent (stub)", () => {
    const centroid = { x: 5, y: 6 };
    expect(annotationTestPoints(stub(), centroid)).toEqual([centroid]);
  });

  it("falls back to the centroid when coordinates is an empty array", () => {
    const centroid = { x: 7, y: 8 };
    expect(annotationTestPoints(hydrated([]), centroid)).toEqual([centroid]);
  });

  it("returns an empty array when neither coordinates nor centroid exist", () => {
    expect(annotationTestPoints(stub(), undefined)).toEqual([]);
  });
});

describe("idsNeedingHydration", () => {
  const stubs = new Map([
    ["a", {}],
    ["b", {}],
    ["c", {}],
  ]);

  it("returns known stubs that are not already hydrated", () => {
    const hydrated = new Map([["a", {}]]);
    expect(idsNeedingHydration(["a", "b", "c"], hydrated, stubs)).toEqual([
      "b",
      "c",
    ]);
  });

  it("skips ids already in the hydration cache", () => {
    const hydrated = new Map([
      ["a", {}],
      ["b", {}],
      ["c", {}],
    ]);
    expect(idsNeedingHydration(["a", "b", "c"], hydrated, stubs)).toEqual([]);
  });

  it("skips ids that are not known stubs", () => {
    const hydrated = new Map<string, unknown>();
    expect(idsNeedingHydration(["a", "unknown"], hydrated, stubs)).toEqual([
      "a",
    ]);
  });

  it("deduplicates repeated ids", () => {
    const hydrated = new Map<string, unknown>();
    expect(idsNeedingHydration(["a", "a", "b"], hydrated, stubs)).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(idsNeedingHydration([], new Map(), stubs)).toEqual([]);
  });

  it("accepts any has-only collection (e.g. a Set) for the lookups", () => {
    // The params only use .has(); a Set satisfies the contract.
    const hydratedSet = new Set<string>(["a"]);
    const stubSet = new Set<string>(["a", "b", "c"]);
    expect(idsNeedingHydration(["a", "b"], hydratedSet, stubSet)).toEqual([
      "b",
    ]);
  });
});

describe("planHydrationEvictions", () => {
  // orderedIds = LRU order (head = oldest / first to evict).
  it("evicts nothing when at or under the cap", () => {
    const plan = planHydrationEvictions(["a", "b", "c"], new Set(), 5);
    expect(plan.evict).toEqual([]);
    expect(plan.protectedSkipped).toBe(0);
  });

  it("evicts the oldest (LRU) entries to reach the cap", () => {
    const plan = planHydrationEvictions(["a", "b", "c", "d"], new Set(), 2);
    expect(plan.evict).toEqual(["a", "b"]);
  });

  it("protects selected ids, evicting non-selected LRU instead", () => {
    // cap 2, 4 entries → evict 2; "a" is selected so skip it and evict the
    // next non-selected (b, c).
    const plan = planHydrationEvictions(
      ["a", "b", "c", "d"],
      new Set(["a"]),
      2,
    );
    expect(plan.evict).toEqual(["b", "c"]);
    expect(plan.protectedSkipped).toBe(1);
  });

  it("enforces a HARD cap by evicting selected LRU when the protected set alone exceeds the cap (select-all)", () => {
    // Everything selected, cap 2, 4 entries → must still evict 2 (the LRU
    // ones) so the cache can't grow unbounded.
    const plan = planHydrationEvictions(
      ["a", "b", "c", "d"],
      new Set(["a", "b", "c", "d"]),
      2,
    );
    expect(plan.evict).toEqual(["a", "b"]);
    // c and d are selected and survived → 2 protected survivors.
    expect(plan.protectedSkipped).toBe(2);
  });

  it("treats cap <= 0 as no cap", () => {
    expect(planHydrationEvictions(["a", "b"], new Set(), 0).evict).toEqual([]);
  });
});

describe("stubFromAnnotation", () => {
  const annotation = {
    id: "ann-1",
    location: { XY: 2, Z: 1, Time: 0 },
    shape: "polygon",
    channel: 3,
    tags: ["nucleus"],
    color: "#ff0000",
    coordinates: [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 4, z: 0 },
      { x: 0, y: 4, z: 0 },
    ],
  } as unknown as IAnnotation;

  it("builds a stub carrying the centroid and the annotation's stub fields", () => {
    const centroid = { x: 5, y: 2, z: 0 };
    expect(stubFromAnnotation(annotation, centroid)).toEqual({
      id: "ann-1",
      centroid,
      location: { XY: 2, Z: 1, Time: 0 },
      shape: "polygon",
      channel: 3,
      tags: ["nucleus"],
      color: "#ff0000",
      estimatedRadius: estimateAnnotationRadius(annotation.coordinates),
    });
  });

  it("derives estimatedRadius from the annotation coordinates (max extent / 2)", () => {
    // bbox is 10 wide x 4 tall → max(10,4)/2 = 5
    expect(
      stubFromAnnotation(annotation, { x: 5, y: 2, z: 0 }).estimatedRadius,
    ).toBe(5);
  });
});

describe("shapeNeedsHydration", () => {
  it("returns false for points (a point's centroid is its only coordinate)", () => {
    expect(shapeNeedsHydration(AnnotationShape.Point)).toBe(false);
  });

  it("returns true for polygon, line, and rectangle", () => {
    expect(shapeNeedsHydration(AnnotationShape.Polygon)).toBe(true);
    expect(shapeNeedsHydration(AnnotationShape.Line)).toBe(true);
    expect(shapeNeedsHydration(AnnotationShape.Rectangle)).toBe(true);
  });
});

describe("drawnFeatureUsesDotStyle", () => {
  it("uses the dot style for an unhydrated non-point stub", () => {
    expect(drawnFeatureUsesDotStyle(true, AnnotationShape.Polygon)).toBe(true);
  });

  it("does NOT use the dot style for a point stub (regular point style)", () => {
    expect(drawnFeatureUsesDotStyle(true, AnnotationShape.Point)).toBe(false);
  });

  it("does NOT use the dot style for a hydrated annotation", () => {
    expect(drawnFeatureUsesDotStyle(false, AnnotationShape.Polygon)).toBe(false);
    expect(drawnFeatureUsesDotStyle(false, AnnotationShape.Point)).toBe(false);
  });
});
