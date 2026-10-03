import { describe, it, expect, vi } from "vitest";

// Mock @/utils/fetch to break the AnnotationsAPI -> utils/fetch -> store/progress
// -> store/index circular import that would otherwise instantiate the whole
// store at module load and resolve AnnotationsAPI as undefined.
vi.mock("@/utils/fetch", () => ({
  fetchAllPages: vi.fn(),
}));

import AnnotationsAPI from "./AnnotationsAPI";

function makeApi(postImpl: any) {
  const client = { post: vi.fn(postImpl) } as any;
  return { api: new AnnotationsAPI(client), client };
}

describe("AnnotationsAPI.fetchAnnotationListPage", () => {
  it("posts the query and maps rows to stub-shaped objects", async () => {
    const { api, client } = makeApi(async () => ({
      data: {
        total: 1,
        offset: 0,
        rows: [
          {
            _id: "a1",
            name: "Cell 1",
            tags: ["X"],
            shape: "polygon",
            channel: 0,
            location: { XY: 0, Z: 0, Time: 0 },
            color: null,
            centroid: { x: 1, y: 2 },
            values: { p: { Area: 9 } },
          },
        ],
      },
    }));
    const page = await api.fetchAnnotationListPage({
      datasetId: "ds",
      filters: {},
      sort: null,
      propertyPaths: [["p", "Area"]],
      offset: 0,
      limit: 50,
    });
    expect(client.post).toHaveBeenCalledWith(
      "upenn_annotation/list",
      expect.objectContaining({ datasetId: "ds" }),
    );
    expect(page.total).toBe(1);
    expect(page.offset).toBe(0);
    expect(page.rows[0].id).toBe("a1");
    expect(page.rows[0].name).toBe("Cell 1");
    expect((page.rows[0].values as any).p.Area).toBe(9);
  });

  it("maps a missing name to null", async () => {
    const { api } = makeApi(async () => ({
      data: {
        total: 1,
        rows: [
          {
            _id: "a1",
            tags: [],
            shape: "polygon",
            channel: 0,
            location: { XY: 0, Z: 0, Time: 0 },
            color: null,
            centroid: { x: 1, y: 2 },
          },
        ],
      },
    }));
    const page = await api.fetchAnnotationListPage({
      datasetId: "ds",
      filters: {},
      sort: null,
      propertyPaths: [],
      offset: 0,
      limit: 50,
    });
    expect(page.rows[0].name).toBeNull();
  });

  it("posts anchorId and preserves a null offset when it is filtered out", async () => {
    const { api, client } = makeApi(async () => ({
      data: { total: 12, offset: null, rows: [] },
    }));
    const page = await api.fetchAnnotationListPage({
      datasetId: "ds",
      filters: {},
      sort: null,
      propertyPaths: [],
      offset: 0,
      limit: 10,
      anchorId: "a12",
    });
    expect(client.post).toHaveBeenCalledWith(
      "upenn_annotation/list",
      expect.objectContaining({ anchorId: "a12" }),
    );
    expect(page.offset).toBeNull();
    expect(page.rows).toEqual([]);
  });

  it("does not substitute the request offset when the response lacks one", async () => {
    // A response without `offset` means an outdated backend that ignored
    // anchorId; falling back to the request offset would navigate to page 1.
    const { api } = makeApi(async () => ({
      data: { total: 12, rows: [] },
    }));
    const page = await api.fetchAnnotationListPage({
      datasetId: "ds",
      filters: {},
      sort: null,
      propertyPaths: [],
      offset: 0,
      limit: 10,
      anchorId: "a12",
    });
    expect(page.offset).toBeUndefined();
  });
});

describe("AnnotationsAPI.fetchAnnotationListIds", () => {
  it("returns the id array", async () => {
    const { api } = makeApi(async () => ({
      data: { total: 2, ids: ["a", "b"] },
    }));
    const ids = await api.fetchAnnotationListIds("ds", {});
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("AnnotationsAPI.hydrateAnnotations", () => {
  it("posts the ids and forwards the abort signal", async () => {
    const { api, client } = makeApi(async () => ({ data: [] }));
    const controller = new AbortController();
    await api.hydrateAnnotations(["a", "b"], controller.signal);
    expect(client.post).toHaveBeenCalledWith(
      "upenn_annotation/hydrate",
      ["a", "b"],
      { signal: controller.signal },
    );
  });

  it("returns [] without calling the client for an empty id list", async () => {
    const { api, client } = makeApi(async () => ({ data: [] }));
    const res = await api.hydrateAnnotations([]);
    expect(res).toEqual([]);
    expect(client.post).not.toHaveBeenCalled();
  });
});
