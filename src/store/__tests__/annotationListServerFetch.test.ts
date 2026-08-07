import { describe, it, expect, vi, beforeEach } from "vitest";

// Control the API call and the stores annotationListServer reads, so we can
// exercise the real fetchPage action (and its stale-response guard) in
// isolation. ./root stays real — the dynamic module registers on it.
const fetchAnnotationListPage = vi.fn();

vi.mock("@/store/index", () => ({
  default: {
    dataset: { id: "ds1" },
    xy: 0,
    z: 0,
    time: 0,
    annotationsAPI: {
      fetchAnnotationListPage: (...a: any[]) => fetchAnnotationListPage(...a),
    },
  },
}));

vi.mock("@/store/filters", () => ({
  default: {
    tagFilter: { enabled: false, exclusive: false, tags: [] },
    onlyCurrentFrame: false,
    propertyFilters: [],
    selectionFilter: {
      enabled: false,
      exclusive: true,
      id: "selection",
      annotationIds: [],
    },
    annotationIdFilters: [],
  },
}));

vi.mock("@/store/properties", () => ({
  default: { displayedPropertyPaths: [] },
}));

import annotationListServer from "@/store/annotationListServer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("annotationListServer.fetchPage stale-response guard", () => {
  beforeEach(() => {
    fetchAnnotationListPage.mockReset();
    (annotationListServer as any).setPageResult({ rows: [], total: 0 });
    (annotationListServer as any).setLoading(false);
    (annotationListServer as any).setOptions({
      page: 1,
      pageSize: 10,
      sort: null,
    });
  });

  it("ignores an older response that resolves after a newer one", async () => {
    const d1 = deferred<any>();
    const d2 = deferred<any>();
    fetchAnnotationListPage
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);

    const p1 = annotationListServer.fetchPage();
    const p2 = annotationListServer.fetchPage();

    // The newer (2nd) request resolves first and wins.
    d2.resolve({ total: 2, rows: [{ id: "B" }] });
    await p2;
    expect(annotationListServer.total).toBe(2);

    // The older (1st) request resolves last — it must NOT overwrite the
    // newer result, and must not flip loading back on/off.
    d1.resolve({ total: 1, rows: [{ id: "A" }] });
    await p1;
    expect(annotationListServer.total).toBe(2);
    expect(annotationListServer.rows.map((r: any) => r.id)).toEqual(["B"]);
    expect(annotationListServer.loading).toBe(false);
  });

  it("applies a response that resolves in order", async () => {
    fetchAnnotationListPage.mockResolvedValueOnce({
      total: 5,
      rows: [{ id: "X" }],
    });
    await annotationListServer.fetchPage();
    expect(annotationListServer.total).toBe(5);
    expect(annotationListServer.loading).toBe(false);
  });

  it("loads and applies the page containing an anchor annotation", async () => {
    fetchAnnotationListPage.mockResolvedValueOnce({
      total: 100,
      offset: 40,
      rows: [{ id: "target" }],
    });

    const found = await annotationListServer.fetchPageContaining("target");

    expect(found).toBe(true);
    expect(fetchAnnotationListPage).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorId: "target",
        offset: 0,
        limit: 10,
      }),
    );
    expect(annotationListServer.page).toBe(5);
    expect(annotationListServer.rows.map((r: any) => r.id)).toEqual(["target"]);
    expect(annotationListServer.loading).toBe(false);
  });

  it("preserves the current page when the anchor is filtered out", async () => {
    (annotationListServer as any).setPageResult({
      rows: [{ id: "current" }],
      total: 10,
    });
    fetchAnnotationListPage.mockResolvedValueOnce({
      total: 10,
      offset: null,
      rows: [],
    });

    const found = await annotationListServer.fetchPageContaining("missing");

    expect(found).toBe(false);
    expect(annotationListServer.page).toBe(1);
    expect(annotationListServer.rows.map((r: any) => r.id)).toEqual([
      "current",
    ]);
    expect(annotationListServer.loading).toBe(false);
  });

  it("drops an anchor response canceled by a newer hover", async () => {
    (annotationListServer as any).setPageResult({
      rows: [{ id: "current" }],
      total: 10,
    });
    const request = deferred<any>();
    fetchAnnotationListPage.mockReturnValueOnce(request.promise);

    const pending = annotationListServer.fetchPageContaining("old-target");
    annotationListServer.cancelPendingNavigation();
    request.resolve({
      total: 100,
      offset: 50,
      rows: [{ id: "old-target" }],
    });

    expect(await pending).toBe(false);
    expect(annotationListServer.page).toBe(1);
    expect(annotationListServer.rows.map((r: any) => r.id)).toEqual([
      "current",
    ]);
    expect(annotationListServer.loading).toBe(false);
  });
});
