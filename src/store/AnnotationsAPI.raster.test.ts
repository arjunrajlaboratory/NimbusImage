import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/fetch", () => ({
  fetchAllPages: vi.fn(),
}));

import AnnotationsAPI from "./AnnotationsAPI";
import { AnnotationShape } from "./model";

describe("annotationRasterTemplateUrl", () => {
  it("preserves z/x/y placeholders and serializes render inputs", () => {
    const api = new AnnotationsAPI({
      apiRoot: "http://localhost:8080/api/v1",
    } as any);
    const result = api.annotationRasterTemplateUrl({
      datasetId: "dataset-id",
      xy: 2,
      z: 3,
      time: 4,
      sizeX: 20000,
      sizeY: 18000,
      tileSize: 512,
      maxLevel: 8,
      mode: "shapes",
      color: "#FFD700",
      version: 7,
      tags: ["cell", "positive"],
      shape: AnnotationShape.Polygon,
    });

    const [path, query] = result.split("?");
    expect(path).toBe(
      "http://localhost:8080/api/v1/upenn_annotation/raster/{z}/{x}/{y}",
    );
    const params = new URLSearchParams(query);
    expect(params.get("datasetId")).toBe("dataset-id");
    expect(params.get("XY")).toBe("2");
    expect(params.get("Z")).toBe("3");
    expect(params.get("Time")).toBe("4");
    expect(params.get("sizeX")).toBe("20000");
    expect(params.get("sizeY")).toBe("18000");
    expect(params.get("maxLevel")).toBe("8");
    expect(params.get("mode")).toBe("shapes");
    expect(params.get("v")).toBe("7");
    expect(params.get("tags")).toBe('["cell","positive"]');
    expect(params.get("shape")).toBe("polygon");
  });
});
