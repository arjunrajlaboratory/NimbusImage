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

describe("SpatialAPI transcripts", () => {
  it("fetchTranscriptsSchema returns null for 404 and rethrows other errors", async () => {
    const { api } = makeApi({ get: async () => Promise.reject(axios404()) });
    expect(await api.fetchTranscriptsSchema("ds")).toBeNull();
    const { api: failing } = makeApi({
      get: async () => Promise.reject(new Error("network")),
    });
    await expect(failing.fetchTranscriptsSchema("ds")).rejects.toThrow(
      "network",
    );
  });

  it("decodes the binary points body and passes the request as JSON", async () => {
    const { encodeTranscriptPoints } = await import("@/utils/transcriptPoints");
    const body = encodeTranscriptPoints({
      x: [1],
      y: [2],
      gene: [0],
      quality: [30],
    });
    const { api, client } = makeApi({ post: async () => ({ data: body }) });
    const points = await api.fetchTranscriptPoints(
      "ds",
      ["CD3E"],
      0,
      ["0,0", "1,0"],
      20,
    );
    expect(client.post).toHaveBeenCalledWith(
      "spatial/ds/transcripts/points",
      { genes: ["CD3E"], level: 0, tiles: ["0,0", "1,0"], minQv: 20 },
      { responseType: "arraybuffer" },
    );
    expect(points.count).toBe(1);
    expect(points.quality![0]).toBe(30);
  });

  it("gene search uses the documented route", async () => {
    const { api, client } = makeApi({ get: async () => ({ data: ["CD3E"] }) });
    expect(await api.searchTranscriptGenes("ds", "cd", 5)).toEqual(["CD3E"]);
    expect(client.get).toHaveBeenCalledWith("spatial/ds/transcripts/genes", {
      params: { search: "cd", limit: 5 },
    });
  });

  it("builds a density template on the overview pyramid", () => {
    const client = { apiRoot: "http://h/api/v1" } as any;
    const template = new SpatialAPI(client).transcriptDensityTemplateUrl({
      datasetId: "ds",
      genes: ["CD3E", "MS4A1"],
      sizeX: 100,
      sizeY: 50,
      tileSize: 512,
      maxLevel: 7,
      color: "#FF0000",
    });
    expect(template).toBe(
      "http://h/api/v1/spatial/ds/transcripts/density/{z}/{x}/{y}?genes=CD3E%2CMS4A1&sizeX=100&sizeY=50&tileSize=512&maxLevel=7&color=%23FF0000",
    );
  });
});
