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
      index.remove("a", 10, 10);
      expect(index.queryBox(0, 0, 20, 20).has("a")).toBe(false);
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
