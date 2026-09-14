import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/fetch", () => ({
  fetchAllPages: vi.fn(),
}));

import AnnotationsAPI from "./AnnotationsAPI";

describe("annotationRasterTemplateUrl", () => {
  it("preserves z/x/y placeholders and serializes render inputs", () => {
    const api = new AnnotationsAPI({
      apiRoot: "http://localhost:8080/api/v1",
    } as any);
    const result = api.annotationRasterTemplateUrl({
      datasetId: "dataset-id",
      selectors: [
        { channel: 0, XY: 2, Z: 3, Time: 4 },
        { channel: 2, XY: 2 },
      ],
      sizeX: 20000,
      sizeY: 18000,
      tileSize: 512,
      maxLevel: 8,
      mode: "shapes",
      color: "#FFD700",
      version: 7,
      authToken: "share-token",
    });

    const [path, query] = result.split("?");
    expect(path).toBe(
      "http://localhost:8080/api/v1/upenn_annotation/raster/{z}/{x}/{y}",
    );
    const params = new URLSearchParams(query);
    expect(params.get("datasetId")).toBe("dataset-id");
    expect(params.get("selectors")).toBe(
      '[{"channel":0,"XY":2,"Z":3,"Time":4},{"channel":2,"XY":2}]',
    );
    expect(params.get("sizeX")).toBe("20000");
    expect(params.get("sizeY")).toBe("18000");
    expect(params.get("maxLevel")).toBe("8");
    expect(params.get("mode")).toBe("shapes");
    expect(params.get("v")).toBe("7");
    expect(params.get("token")).toBe("share-token");
    expect(params.has("XY")).toBe(false);
    expect(params.has("Z")).toBe(false);
    expect(params.has("Time")).toBe(false);
    expect(params.has("tags")).toBe(false);
    expect(params.has("shape")).toBe(false);
  });
});
