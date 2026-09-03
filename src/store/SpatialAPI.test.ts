import { describe, it, expect, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";

import SpatialAPI from "./SpatialAPI";

function makeApi(impl: { get?: any; post?: any }) {
  const client = {
    get: vi.fn(impl.get),
    post: vi.fn(impl.post),
  } as any;
  return { api: new SpatialAPI(client), client };
}

function axios404() {
  return new AxiosError("Not found", "404", undefined, undefined, {
    status: 404,
    statusText: "Not Found",
    data: { message: "No spatial table is registered for this dataset." },
    headers: {},
    config: { headers: new AxiosHeaders() },
  });
}

describe("SpatialAPI", () => {
  it("fetchInfo returns null for 404 and rethrows anything else", async () => {
    const { api } = makeApi({ get: async () => Promise.reject(axios404()) });
    expect(await api.fetchInfo("ds")).toBeNull();

    const { api: failing } = makeApi({
      get: async () => Promise.reject(new Error("network")),
    });
    await expect(failing.fetchInfo("ds")).rejects.toThrow("network");
  });

  it("searchFeatures passes search and limit as query params", async () => {
    const { api, client } = makeApi({
      get: async () => ({ data: [{ symbol: "CD3E", featureType: "gene" }] }),
    });
    const result = await api.searchFeatures("ds", "cd", 5);
    expect(client.get).toHaveBeenCalledWith("spatial/ds/features", {
      params: { search: "cd", limit: 5 },
    });
    expect(result[0].symbol).toBe("CD3E");
  });

  it("aggregate and materialize post the documented bodies", async () => {
    const { api, client } = makeApi({
      post: async () => ({ data: { ok: 1 } }),
    });
    const filters = { tags: { values: ["B"], exclusive: false } };
    await api.aggregate("ds", filters, ["CD3E"]);
    expect(client.post).toHaveBeenCalledWith("spatial/ds/aggregate", {
      filters,
      features: ["CD3E"],
    });
    await api.materialize("ds", ["CD3E", "MS4A1"], "Panel");
    expect(client.post).toHaveBeenCalledWith("spatial/ds/materialize", {
      features: ["CD3E", "MS4A1"],
      propertyName: "Panel",
    });
  });

  it("score, differential and fetchJob use the documented routes", async () => {
    const { api, client } = makeApi({
      post: async () => ({ data: { jobId: "j1", nA: 3 } }),
      get: async () => ({ data: { _id: "j1", status: 3, spatialResult: {} } }),
    });
    await api.score("ds", ["CD3E"], "T", "mean", "Gene set scores");
    expect(client.post).toHaveBeenCalledWith("spatial/ds/score", {
      features: ["CD3E"],
      name: "T",
      method: "mean",
      propertyName: "Gene set scores",
    });
    const filtersA = { tags: { values: ["B"], exclusive: false } };
    expect(await api.differential("ds", filtersA, null, 50)).toEqual({
      jobId: "j1",
      nA: 3,
    });
    expect(client.post).toHaveBeenCalledWith("spatial/ds/differential", {
      filtersA,
      filtersB: null,
      maxFeatures: 50,
    });
    expect((await api.fetchJob("j1")).status).toBe(3);
    expect(client.get).toHaveBeenCalledWith("job/j1");
  });
});
