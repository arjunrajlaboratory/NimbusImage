import { describe, it, expect, beforeEach } from "vitest";
import { AnnotationSpatialIndex } from "../spatialIndex";

describe("AnnotationSpatialIndex", () => {
  let index: AnnotationSpatialIndex;

  beforeEach(() => {
    index = new AnnotationSpatialIndex();
  });

  describe("bulkLoad", () => {
    it("loads items and allows search", () => {
      index.bulkLoad([
        { id: "a", x: 10, y: 10 },
        { id: "b", x: 50, y: 50 },
        { id: "c", x: 90, y: 90 },
      ]);

      const result = index.splitByViewport(["a", "b", "c"], 0, 0, 60, 60);
      expect(result.inViewportIds).toContain("a");
      expect(result.inViewportIds).toContain("b");
      expect(result.outOfViewportIds).toContain("c");
    });

    it("clears existing data on reload", () => {
      index.bulkLoad([{ id: "a", x: 10, y: 10 }]);
      index.bulkLoad([{ id: "b", x: 50, y: 50 }]);

      // "a" should no longer exist
      const result = index.splitByViewport(["a", "b"], 0, 0, 100, 100);
      expect(result.inViewportIds).toEqual(["b"]);
      expect(result.outOfViewportIds).toEqual(["a"]);
    });

    it("handles empty input", () => {
      index.bulkLoad([]);
      const result = index.splitByViewport([], 0, 0, 100, 100);
      expect(result.inViewportIds).toEqual([]);
      expect(result.outOfViewportIds).toEqual([]);
    });
  });

  describe("insert and remove", () => {
    it("insert adds a point that can be queried", () => {
      index.insert("a", 25, 25);

      const result = index.splitByViewport(["a"], 0, 0, 50, 50);
      expect(result.inViewportIds).toEqual(["a"]);
    });

    it("remove prevents a point from being found", () => {
      index.insert("a", 25, 25);
      index.remove("a", 25, 25);

      const result = index.splitByViewport(["a"], 0, 0, 50, 50);
      expect(result.inViewportIds).toEqual([]);
      expect(result.outOfViewportIds).toEqual(["a"]);
    });

    it("insert after bulkLoad adds to existing tree", () => {
      index.bulkLoad([{ id: "a", x: 10, y: 10 }]);
      index.insert("b", 20, 20);

      const result = index.splitByViewport(["a", "b"], 0, 0, 50, 50);
      expect(result.inViewportIds).toContain("a");
      expect(result.inViewportIds).toContain("b");
    });

    it("remove after bulkLoad works correctly", () => {
      index.bulkLoad([
        { id: "a", x: 10, y: 10 },
        { id: "b", x: 20, y: 20 },
      ]);
      index.remove("a", 10, 10);

      const result = index.splitByViewport(["a", "b"], 0, 0, 50, 50);
      expect(result.inViewportIds).toEqual(["b"]);
      expect(result.outOfViewportIds).toEqual(["a"]);
    });
  });

  describe("splitByViewport", () => {
    beforeEach(() => {
      index.bulkLoad([
        { id: "inside1", x: 25, y: 25 },
        { id: "inside2", x: 75, y: 75 },
        { id: "outside1", x: 150, y: 150 },
        { id: "outside2", x: -50, y: -50 },
        { id: "boundary", x: 100, y: 100 }, // on the boundary
      ]);
    });

    it("partitions IDs correctly", () => {
      const allIds = [
        "inside1",
        "inside2",
        "outside1",
        "outside2",
        "boundary",
      ];
      const result = index.splitByViewport(allIds, 0, 0, 100, 100);

      expect(result.inViewportIds).toContain("inside1");
      expect(result.inViewportIds).toContain("inside2");
      expect(result.inViewportIds).toContain("boundary"); // boundary is inclusive
      expect(result.outOfViewportIds).toContain("outside1");
      expect(result.outOfViewportIds).toContain("outside2");
    });

    it("only returns IDs from the input set", () => {
      // Only ask about a subset
      const result = index.splitByViewport(["inside1", "outside1"], 0, 0, 100, 100);

      expect(result.inViewportIds).toEqual(["inside1"]);
      expect(result.outOfViewportIds).toEqual(["outside1"]);
    });

    it("IDs not in tree go to outOfViewport", () => {
      const result = index.splitByViewport(["nonexistent"], 0, 0, 100, 100);

      expect(result.inViewportIds).toEqual([]);
      expect(result.outOfViewportIds).toEqual(["nonexistent"]);
    });

    it("handles empty currentFrameIds", () => {
      const result = index.splitByViewport([], 0, 0, 100, 100);

      expect(result.inViewportIds).toEqual([]);
      expect(result.outOfViewportIds).toEqual([]);
    });

    it("preserves order from currentFrameIds", () => {
      const ids = ["outside2", "inside2", "outside1", "inside1", "boundary"];
      const result = index.splitByViewport(ids, 0, 0, 100, 100);

      // In-viewport should maintain relative order from input
      expect(result.inViewportIds.indexOf("inside2")).toBeLessThan(
        result.inViewportIds.indexOf("inside1"),
      );
      // Out-of-viewport should maintain relative order from input
      expect(result.outOfViewportIds.indexOf("outside2")).toBeLessThan(
        result.outOfViewportIds.indexOf("outside1"),
      );
    });
  });

  describe("clear", () => {
    it("empties the tree", () => {
      index.bulkLoad([
        { id: "a", x: 10, y: 10 },
        { id: "b", x: 20, y: 20 },
      ]);
      index.clear();

      const result = index.splitByViewport(["a", "b"], 0, 0, 100, 100);
      expect(result.inViewportIds).toEqual([]);
      expect(result.outOfViewportIds).toEqual(["a", "b"]);
    });
  });

  describe("performance", () => {
    it("handles 100K points without error", () => {
      const items = Array.from({ length: 100_000 }, (_, i) => ({
        id: `pt-${i}`,
        x: Math.random() * 10000,
        y: Math.random() * 10000,
      }));

      const start = performance.now();
      index.bulkLoad(items);
      const loadTime = performance.now() - start;

      // Bulk load should complete in reasonable time (< 1s)
      expect(loadTime).toBeLessThan(1000);

      // Query a small viewport
      const allIds = items.map((item) => item.id);
      const queryStart = performance.now();
      const result = index.splitByViewport(allIds, 0, 0, 100, 100);
      const queryTime = performance.now() - queryStart;

      // Query + partition should be fast
      expect(queryTime).toBeLessThan(1000);

      // Total should account for all items
      expect(result.inViewportIds.length + result.outOfViewportIds.length).toBe(
        100_000,
      );
    });
  });
});
