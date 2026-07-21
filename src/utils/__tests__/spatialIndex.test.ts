import { describe, it, expect, beforeEach } from "vitest";
import { AnnotationSpatialIndex } from "../spatialIndex";

describe("AnnotationSpatialIndex", () => {
  let index: AnnotationSpatialIndex;

  beforeEach(() => {
    index = new AnnotationSpatialIndex();
  });

  describe("bulkLoad", () => {
    it("loads items and allows querying", () => {
      index.bulkLoad([
        { id: "a", x: 10, y: 10 },
        { id: "b", x: 50, y: 50 },
        { id: "c", x: 90, y: 90 },
      ]);
      const result = index.queryBox(0, 0, 20, 20);
      expect(result.has("a")).toBe(true);
      expect(result.has("b")).toBe(false);
    });

    it("clears previous data on re-load", () => {
      index.bulkLoad([{ id: "a", x: 10, y: 10 }]);
      index.bulkLoad([{ id: "b", x: 50, y: 50 }]);
      expect(index.queryBox(0, 0, 20, 20).has("a")).toBe(false);
      expect(index.queryBox(40, 40, 60, 60).has("b")).toBe(true);
    });
  });

  describe("insert and remove", () => {
    it("inserts a single item", () => {
      index.insert("a", 10, 10);
      expect(index.queryBox(0, 0, 20, 20).has("a")).toBe(true);
    });

    it("removes a single item", () => {
      index.insert("a", 10, 10);
      index.remove("a");
      expect(index.queryBox(0, 0, 20, 20).has("a")).toBe(false);
    });

    it("upserts when an id is inserted again (no stale node leak)", () => {
      // Finding 5: re-inserting the same id must replace the old node, not
      // orphan it. Without upsert the old (10,10) node leaks: remove() deletes
      // only the newest node, leaving the stale one queryable forever.
      index.insert("a", 10, 10);
      index.insert("a", 500, 500);

      // The stale location must no longer match; the new one must.
      expect(index.queryBox(0, 0, 20, 20).has("a")).toBe(false);
      expect(index.queryBox(490, 490, 510, 510).has("a")).toBe(true);

      // After removal nothing remains at either location.
      index.remove("a");
      expect(index.queryBox(0, 0, 20, 20).has("a")).toBe(false);
      expect(index.queryBox(490, 490, 510, 510).has("a")).toBe(false);
    });
  });

  describe("splitByViewport", () => {
    it("splits IDs into in-viewport and out-of-viewport", () => {
      index.bulkLoad([
        { id: "a", x: 10, y: 10 },
        { id: "b", x: 50, y: 50 },
        { id: "c", x: 90, y: 90 },
      ]);
      const { inViewportIds, outOfViewportIds } = index.splitByViewport(
        ["a", "b", "c"],
        0,
        0,
        60,
        60,
      );
      expect(inViewportIds).toContain("a");
      expect(inViewportIds).toContain("b");
      expect(outOfViewportIds).toContain("c");
    });

    it("only returns IDs from the provided list", () => {
      index.bulkLoad([
        { id: "a", x: 10, y: 10 },
        { id: "b", x: 50, y: 50 },
      ]);
      const { inViewportIds } = index.splitByViewport(["a"], 0, 0, 100, 100);
      expect(inViewportIds).toEqual(["a"]);
    });
  });

  describe("partitionByViewports", () => {
    it("classifies IDs into viewport / ring / outside in one pass", () => {
      index.bulkLoad([
        { id: "in", x: 50, y: 50 }, // inside inner (0..60)
        { id: "ring", x: 80, y: 80 }, // outside inner, inside outer (0..120)
        { id: "out", x: 200, y: 200 }, // outside outer
      ]);
      const { inViewport, ring, outside } = index.partitionByViewports(
        ["in", "ring", "out"],
        { minX: 0, minY: 0, maxX: 60, maxY: 60 },
        { minX: 0, minY: 0, maxX: 120, maxY: 120 },
      );
      expect(inViewport).toEqual(["in"]);
      expect(ring).toEqual(["ring"]);
      expect(outside).toEqual(["out"]);
    });

    it("only returns IDs from the provided list and preserves order", () => {
      index.bulkLoad([
        { id: "a", x: 10, y: 10 },
        { id: "b", x: 90, y: 90 },
        { id: "unlisted", x: 15, y: 15 },
      ]);
      const { inViewport, ring, outside } = index.partitionByViewports(
        ["b", "a"], // "unlisted" omitted; order preserved
        { minX: 0, minY: 0, maxX: 50, maxY: 50 },
        { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      );
      expect(inViewport).toEqual(["a"]);
      expect(ring).toEqual(["b"]);
      expect(outside).toEqual([]);
    });
  });

  describe("queryBox", () => {
    it("returns empty set for empty tree", () => {
      expect(index.queryBox(0, 0, 100, 100).size).toBe(0);
    });

    it("includes boundary points", () => {
      index.insert("a", 10, 10);
      expect(index.queryBox(10, 10, 10, 10).has("a")).toBe(true);
    });
  });

  describe("clear", () => {
    it("removes all items", () => {
      index.bulkLoad([{ id: "a", x: 10, y: 10 }]);
      index.clear();
      expect(index.queryBox(0, 0, 100, 100).size).toBe(0);
    });
  });
});
