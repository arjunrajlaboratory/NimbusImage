import { describe, it, expect, vi, beforeEach } from "vitest";

// Control the API call and the stores the filters module reads, so we can
// exercise the real refreshPropertyFilterPassingIds action and the
// filteredAnnotations getter in isolation. ./root stays real — the dynamic
// module registers on it.
const { fetchAnnotationListIds, annotationMock, propertiesMock } = vi.hoisted(
  () => ({
    fetchAnnotationListIds: vi.fn(),
    annotationMock: {
      stubOnlyMode: false,
      annotationsForIteration: [] as any[],
      annotationCentroids: {} as Record<string, { x: number; y: number }>,
    },
    propertiesMock: {
      propertyValues: {} as Record<string, any>,
      propertiesAPI: { getPropertyHistogram: vi.fn() },
    },
  }),
);

vi.mock("@/store/index", () => ({
  default: {
    dataset: { id: "ds1" },
    xy: 0,
    z: 0,
    time: 0,
    annotationsAPI: {
      fetchAnnotationListIds: (...a: any[]) => fetchAnnotationListIds(...a),
    },
    scheduleAnnotationBrowserSave: () => {},
  },
}));

vi.mock("@/store/annotation", () => ({
  default: annotationMock,
}));

vi.mock("@/store/properties", () => ({
  default: propertiesMock,
}));

vi.mock("geojs", () => ({
  default: { util: { pointInPolygon: vi.fn().mockReturnValue(false) } },
}));

import filters from "@/store/filters";
import { PropertyFilterMode } from "@/store/model";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeStub(id: string) {
  return { id, location: { XY: 0, Z: 0, Time: 0 }, tags: [] as string[] };
}

function addAreaRangeFilter(min: number, max: number) {
  filters.updatePropertyFilter({
    id: "pf-area",
    exclusive: false,
    enabled: true,
    propertyPath: ["p", "Area"],
    range: { min, max },
    valuesOrRange: PropertyFilterMode.Range,
    values: [],
  });
}

describe("filters property-filter server membership (D Stage 2)", () => {
  beforeEach(() => {
    fetchAnnotationListIds.mockReset();
    annotationMock.stubOnlyMode = false;
    annotationMock.annotationsForIteration = [];
    annotationMock.annotationCentroids = {};
    propertiesMock.propertyValues = {};
    // Reset the filters module state touched by these tests. updatePropertyFilter
    // replaces by path, so disabling the lone Area filter clears the active set.
    filters.updatePropertyFilter({
      id: "pf-area",
      exclusive: false,
      enabled: false,
      propertyPath: ["p", "Area"],
      range: { min: 0, max: 0 },
      valuesOrRange: PropertyFilterMode.Range,
      values: [],
    });
    (filters as any).setPropertyFilterPassingIds(null);
  });

  describe("refreshPropertyFilterPassingIds", () => {
    it("fetches property-only ids and stores them as a set in lazy mode", async () => {
      annotationMock.stubOnlyMode = true;
      addAreaRangeFilter(1, 5);
      fetchAnnotationListIds.mockResolvedValueOnce(["a", "b"]);

      await filters.refreshPropertyFilterPassingIds();

      expect(fetchAnnotationListIds).toHaveBeenCalledWith("ds1", {
        propertyFilters: [
          { path: ["p", "Area"], mode: "range", min: 1, max: 5 },
        ],
      });
      expect(filters.propertyFilterPassingIds).toBeInstanceOf(Set);
      expect([...(filters.propertyFilterPassingIds as Set<string>)]).toEqual([
        "a",
        "b",
      ]);
    });

    it("sets null and does not fetch when no property filter is active", async () => {
      annotationMock.stubOnlyMode = true;
      await filters.refreshPropertyFilterPassingIds();
      expect(fetchAnnotationListIds).not.toHaveBeenCalled();
      expect(filters.propertyFilterPassingIds).toBeNull();
    });

    it("sets null and does not fetch when not in lazy mode", async () => {
      annotationMock.stubOnlyMode = false;
      addAreaRangeFilter(1, 5);
      await filters.refreshPropertyFilterPassingIds();
      expect(fetchAnnotationListIds).not.toHaveBeenCalled();
      expect(filters.propertyFilterPassingIds).toBeNull();
    });

    it("ignores an older response that resolves after a newer one", async () => {
      annotationMock.stubOnlyMode = true;
      addAreaRangeFilter(1, 5);
      const d1 = deferred<string[]>();
      const d2 = deferred<string[]>();
      fetchAnnotationListIds
        .mockReturnValueOnce(d1.promise)
        .mockReturnValueOnce(d2.promise);

      const p1 = filters.refreshPropertyFilterPassingIds();
      const p2 = filters.refreshPropertyFilterPassingIds();

      d2.resolve(["new"]);
      await p2;
      d1.resolve(["old"]);
      await p1;

      expect([...(filters.propertyFilterPassingIds as Set<string>)]).toEqual([
        "new",
      ]);
    });
  });

  describe("filteredAnnotations property predicate", () => {
    it("keeps only annotations in the passing set (lazy mode, active filter)", () => {
      annotationMock.stubOnlyMode = true;
      annotationMock.annotationsForIteration = [makeStub("a"), makeStub("b")];
      addAreaRangeFilter(1, 5);
      (filters as any).setPropertyFilterPassingIds(["a"]);

      expect(filters.filteredAnnotations.map((a: any) => a.id)).toEqual(["a"]);
    });

    it("passes all while the passing set is not yet loaded (interim null)", () => {
      annotationMock.stubOnlyMode = true;
      annotationMock.annotationsForIteration = [makeStub("a"), makeStub("b")];
      addAreaRangeFilter(1, 5);
      (filters as any).setPropertyFilterPassingIds(null);

      expect(filters.filteredAnnotations.map((a: any) => a.id)).toEqual([
        "a",
        "b",
      ]);
    });

    it("filters by property values client-side in full (non-lazy) mode", () => {
      annotationMock.stubOnlyMode = false;
      annotationMock.annotationsForIteration = [makeStub("a"), makeStub("b")];
      propertiesMock.propertyValues = {
        a: { p: { Area: 3 } },
        b: { p: { Area: 99 } },
      };
      addAreaRangeFilter(0, 5);

      expect(filters.filteredAnnotations.map((a: any) => a.id)).toEqual(["a"]);
    });
  });
});
