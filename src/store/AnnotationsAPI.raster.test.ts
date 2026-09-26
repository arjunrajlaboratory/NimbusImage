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

describe("overview filter", () => {
  const base = {
    datasetId: "dataset-id",
    selectors: [{ channel: 0, XY: 0, Z: 0, Time: 0 }],
    sizeX: 100,
    sizeY: 100,
    tileSize: 512,
    maxLevel: 1,
    mode: "shapes" as const,
    color: "#FFD700",
    version: 3,
  };

  it("adds the registered filter and its version to tile URLs", () => {
    const api = new AnnotationsAPI({
      apiRoot: "http://localhost:8080/api/v1",
    } as any);
    const params = new URLSearchParams(
      api
        .annotationRasterTemplateUrl({
          ...base,
          filterKey: "k".repeat(64),
          filterVersion: "2-abc",
        })
        .split("?")[1],
    );
    expect(params.get("filter")).toBe("k".repeat(64));
    // The client version moves with the filter's resolved membership.
    expect(params.get("v")).toBe("3.2-abc");
    const unfiltered = new URLSearchParams(
      api.annotationRasterTemplateUrl(base).split("?")[1],
    );
    expect(unfiltered.has("filter")).toBe(false);
    expect(unfiltered.get("v")).toBe("3");
  });

  it("registers filters, and a spec matching nothing for no match", async () => {
    const post = vi.fn(async () => ({ data: { key: "the-key" } }));
    const api = new AnnotationsAPI({ post } as any);
    const tags = { tags: { values: ["B"], exclusive: false } };
    expect(await api.registerRasterFilter("ds", tags)).toBe("the-key");
    expect(post).toHaveBeenLastCalledWith("upenn_annotation/raster/filter", {
      datasetId: "ds",
      filters: tags,
    });
    // An empty id constraint (a gate matching nothing) is rejected by the
    // API; a well-formed id no annotation has means the same thing.
    await api.registerRasterFilter("ds", { idConstraints: [[]] });
    expect(post).toHaveBeenLastCalledWith("upenn_annotation/raster/filter", {
      datasetId: "ds",
      filters: { idConstraints: [["000000000000000000000000"]] },
    });
  });
});
