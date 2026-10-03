import { describe, it, expect, vi } from "vitest";

// AnnotationsAPI transitively imports @/utils/fetch -> @/store/progress, which
// would register a Vuex dynamic module without a test store. Stub the store
// surface so the API class can be imported in isolation.
vi.mock("@/store/progress", () => ({ default: {} }));

import AnnotationsAPI from "@/store/AnnotationsAPI";

describe("getAnnotationCount (Finding 5)", () => {
  it("resolves the count on success", async () => {
    const client = {
      get: vi.fn().mockResolvedValue({ data: { count: 42 } }),
    };
    const api = new AnnotationsAPI(client as any);
    await expect(api.getAnnotationCount("ds1")).resolves.toBe(42);
  });

  it("rejects on failure instead of silently returning 0", async () => {
    // A silent 0 would be <= stubThreshold and route a large dataset into the
    // full-fetch (OOM) branch. The method must surface the failure so the
    // caller can fall back to stub-only mode.
    const client = {
      get: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const api = new AnnotationsAPI(client as any);
    await expect(api.getAnnotationCount("ds1")).rejects.toThrow("network down");
  });
});

// A present-but-empty id constraint means "nothing matches"; the list API
// rejects it with a 400 rather than answering, so the client answers. Guarding
// here rather than in each store action is deliberate: the first attempt
// guarded the two page fetches and missed fetchMatchingIds, the action behind
// "Select all" and "Delete Unselected".
describe("AnnotationsAPI match-nothing short-circuit", () => {
  const nothingFilters = { idConstraints: [["a"], []] };

  it("returns an empty page without issuing a request", async () => {
    const post = vi.fn();
    const api = new AnnotationsAPI({ post } as any);
    const page = await api.fetchAnnotationListPage({
      datasetId: "ds1",
      filters: nothingFilters,
      sort: null,
      propertyPaths: [],
      offset: 0,
      limit: 10,
    } as any);
    expect(post).not.toHaveBeenCalled();
    expect(page).toEqual({ total: 0, rows: [], offset: null });
  });

  it("returns no ids without issuing a request", async () => {
    const post = vi.fn();
    const api = new AnnotationsAPI({ post } as any);
    expect(
      await api.fetchAnnotationListIds("ds1", nothingFilters as any),
    ).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  it("still sends the request when every constraint is non-empty", async () => {
    const post = vi.fn().mockResolvedValue({ data: { ids: ["a"] } });
    const api = new AnnotationsAPI({ post } as any);
    expect(
      await api.fetchAnnotationListIds("ds1", {
        idConstraints: [["a"]],
      } as any),
    ).toEqual(["a"]);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

// Server-side gate resolution (SERVER_GATING.md, Phase 1). Failure returns
// null — never {} — so the caller can keep same-input gate ids on a transient
// error instead of resolving every gate to zero matches.
describe("fetchAnalysisGateIds", () => {
  const plot = {
    id: "plot-1",
    xAxis: { type: "property" as const, path: ["p", "Area"] },
    yAxis: { type: "property" as const, path: ["p", "Mean"] },
    gate: {
      categoryKeyVersion: 1 as const,
      vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      xCategories: null,
      yCategories: null,
    },
  };

  it("posts the plots and returns the gateIds map", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ data: { gateIds: { "plot-1": ["a", "b"] } } });
    const api = new AnnotationsAPI({ post } as any);
    expect(await api.fetchAnalysisGateIds("ds1", [plot])).toEqual({
      "plot-1": ["a", "b"],
    });
    expect(post).toHaveBeenCalledWith("upenn_annotation/analysis/gate_ids", {
      datasetId: "ds1",
      plots: [plot],
    });
  });

  it("short-circuits an empty plots list without a request", async () => {
    const post = vi.fn();
    const api = new AnnotationsAPI({ post } as any);
    expect(await api.fetchAnalysisGateIds("ds1", [])).toEqual({});
    expect(post).not.toHaveBeenCalled();
  });

  it("returns null on failure, not an empty map", async () => {
    const post = vi.fn().mockRejectedValue(new Error("network down"));
    const api = new AnnotationsAPI({ post } as any);
    expect(await api.fetchAnalysisGateIds("ds1", [plot])).toBeNull();
  });
});
