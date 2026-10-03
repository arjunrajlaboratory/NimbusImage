import { describe, it, expect } from "vitest";
import { findUmapAxes } from "@/utils/analysisAxes";

const names: Record<string, string> = {
  umap: "UMAP",
  area: "Blob metrics",
  emb: "umap embedding",
  pca: "PCA",
};
const nameOf = (path: string[]) => names[path[0]] ?? "";

describe("findUmapAxes", () => {
  it("finds the x / y sub-values of a property named like a UMAP", () => {
    expect(
      findUmapAxes(
        [
          ["area", "Area"],
          ["umap", "y"],
          ["umap", "x"],
        ],
        nameOf,
      ),
    ).toEqual({
      xAxis: { type: "property", path: ["umap", "x"] },
      yAxis: { type: "property", path: ["umap", "y"] },
    });
  });

  it("orders _1 / _2 sub-values and matches names case-insensitively", () => {
    expect(
      findUmapAxes(
        [
          ["emb", "UMAP_2"],
          ["emb", "UMAP_1"],
        ],
        nameOf,
      ),
    ).toEqual({
      xAxis: { type: "property", path: ["emb", "UMAP_1"] },
      yAxis: { type: "property", path: ["emb", "UMAP_2"] },
    });
  });

  it.each([
    [["1", "0"], "0", "1"],
    [["UMAP_1", "UMAP_0"], "UMAP_0", "UMAP_1"],
    [["2", "1"], "1", "2"],
    [["umap_1", "umap_2", "umap_0"], "umap_0", "umap_1"],
  ])("puts the lowest-numbered component on x (%j)", (leaves, xLeaf, yLeaf) => {
    expect(
      findUmapAxes(
        leaves.map((leaf) => ["emb", leaf]),
        nameOf,
      ),
    ).toEqual({
      xAxis: { type: "property", path: ["emb", xLeaf] },
      yAxis: { type: "property", path: ["emb", yLeaf] },
    });
  });

  it("is null without a UMAP-named property with two values", () => {
    expect(
      findUmapAxes(
        [
          ["pca", "x"],
          ["pca", "y"],
        ],
        nameOf,
      ),
    ).toBeNull();
    expect(findUmapAxes([["umap", "x"]], nameOf)).toBeNull();
    expect(findUmapAxes([], nameOf)).toBeNull();
  });
});
