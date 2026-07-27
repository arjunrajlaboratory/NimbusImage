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
