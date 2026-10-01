import { describe, it, expect, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";

import SpatialAPI from "./SpatialAPI";

// `get` answers system/loaded_plugins itself (with `plugins`), so a test's
// `impl.get` only ever sees the spatial routes it is about.
function makeApi(impl: {
  get?: any;
  post?: any;
  plugins?: string[] | (() => Promise<any>);
}) {
  const plugins = impl.plugins ?? [
    "upenncontrast_annotation",
    "upenncontrast_spatial",
  ];
  const client = {
    apiRoot: "http://a/api/v1",
    get: vi.fn((path: string, ...rest: any[]) => {
      if (path === "system/loaded_plugins") {
        return typeof plugins === "function"
          ? plugins()
          : Promise.resolve({ data: plugins });
      }
      return impl.get(path, ...rest);
    }),
    post: vi.fn(impl.post),
  } as any;
  return { api: new SpatialAPI(client), client };
}

function spatialCalls(client: any) {
  return client.get.mock.calls.filter(
    ([path]: [string]) => path !== "system/loaded_plugins",
  );
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

  it("answers 'no table' without asking when the plugin is not loaded", async () => {
    // Without the plugin the spatial routes are unregistered and reach a
    // cross-origin client as a network error, so they must never be asked.
    const { api, client } = makeApi({
      plugins: ["upenncontrast_annotation"],
      get: async () => Promise.reject(new Error("network")),
    });
    expect(await api.fetchInfo("ds")).toBeNull();
    expect(await api.fetchTranscriptsSchema("ds")).toBeNull();
    expect(spatialCalls(client)).toEqual([]);
  });

  it("asks for the plugin list once and retries only after a failure", async () => {
    let fail = true;
    const { api, client } = makeApi({
      plugins: async () => {
        if (fail) {
          throw new Error("offline");
        }
        return { data: ["upenncontrast_spatial"] };
      },
      get: async () => ({ data: { features: 1 } }),
    });
    await expect(api.fetchInfo("ds")).rejects.toThrow("offline");
    fail = false;
    await api.fetchInfo("ds");
    await api.fetchTranscriptsSchema("ds");
    const lookups = client.get.mock.calls.filter(
      ([path]: [string]) => path === "system/loaded_plugins",
    );
    expect(lookups).toHaveLength(2);
    expect(spatialCalls(client)).toHaveLength(2);
  });

  it("asks again after the client moves to another server", async () => {
    const { api, client } = makeApi({ get: async () => ({ data: {} }) });
    await api.fetchInfo("ds");
    client.apiRoot = "http://b/api/v1";
    await api.fetchInfo("ds");
    const lookups = client.get.mock.calls.filter(
      ([path]: [string]) => path === "system/loaded_plugins",
    );
    expect(lookups).toHaveLength(2);
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
      method: "welch",
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

  it("decodes a points error body so its message reaches the caller", async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ message: "unknown gene 'LYZ'", type: "rest" }),
    ).buffer;
    const error = new AxiosError("Bad request", "400", undefined, undefined, {
      status: 400,
      statusText: "Bad Request",
      data: body,
      headers: {},
      config: { headers: new AxiosHeaders() },
    });
    const { api } = makeApi({ post: async () => Promise.reject(error) });
    const caught = await api
      .fetchTranscriptPoints("ds", ["LYZ"], 0, ["0,0"], 20)
      .catch((e) => e);
    expect(caught.response.status).toBe(400);
    expect(caught.response.data.message).toBe("unknown gene 'LYZ'");
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
      authToken: "share-token",
    });
    expect(template).toBe(
      "http://h/api/v1/spatial/ds/transcripts/density/{z}/{x}/{y}?genes=CD3E%2CMS4A1&sizeX=100&sizeY=50&tileSize=512&maxLevel=7&color=%23FF0000&token=share-token",
    );
    // A re-registered store gets a new URL (tiles are cached an hour).
    const versioned = new SpatialAPI(client).transcriptDensityTemplateUrl({
      datasetId: "ds",
      genes: ["CD3E"],
      sizeX: 100,
      sizeY: 50,
      tileSize: 512,
      maxLevel: 7,
      color: "#FF0000",
      registration: "item2:0.2125:",
    });
    expect(
      new URL(versioned.replace("{z}/{x}/{y}", "0/0/0")).searchParams.get("v"),
    ).toBe("item2:0.2125:");
  });
});

describe("SpatialAPI table versions", () => {
  it("uses the documented routes", async () => {
    const client = {
      get: vi.fn(async () => ({ data: { ok: 1 } })),
      post: vi.fn(async () => ({ data: { ok: 2 } })),
      delete: vi.fn(async () => ({ data: { ok: 3 } })),
    } as any;
    const api = new SpatialAPI(client);
    await api.fetchVersions("ds");
    expect(client.get).toHaveBeenCalledWith("spatial/ds/versions");
    await api.fetchStaleness("ds");
    expect(client.get).toHaveBeenCalledWith("spatial/ds/staleness");
    await api.activateVersion("ds", "i1");
    expect(client.post).toHaveBeenCalledWith("spatial/ds/versions/i1/activate");
    await api.forgetVersion("ds", "i1");
    expect(client.delete).toHaveBeenCalledWith("spatial/ds/versions/i1");
    const request = {
      label: "v2",
      scope: "dirty" as const,
      minQv: 20,
      tags: ["cell"],
      recomputeEmbeddings: false,
    };
    expect(await api.recompute("ds", request)).toEqual({ ok: 2 });
    expect(client.post).toHaveBeenCalledWith("spatial/ds/recompute", request);
  });
});

describe("SpatialAPI neighborhood and regions", () => {
  it("uses the documented routes and maps 404 to null", async () => {
    const client = {
      get: vi.fn(async () => Promise.reject(axios404())),
      post: vi.fn(async () => ({ data: { jobId: "j1", propertyId: "p1" } })),
    } as any;
    const api = new SpatialAPI(client);
    expect(await api.fetchNeighborhood("ds")).toBeNull();
    await api.computeNeighborhood("ds", 60, ["cell"], "Neighborhood");
    expect(client.post).toHaveBeenCalledWith("spatial/ds/neighborhood", {
      radius: 60,
      excludeTags: ["cell"],
      propertyName: "Neighborhood",
    });
    await api.regionSummary("ds", { regionTag: "region" }, ["CD3E"]);
    expect(client.post).toHaveBeenCalledWith("spatial/ds/regions/summary", {
      regionTag: "region",
      features: ["CD3E"],
    });
    await api.regionSummary("ds", { regionIds: ["r1"] }, []);
    expect(client.post).toHaveBeenCalledWith("spatial/ds/regions/summary", {
      regionIds: ["r1"],
      features: [],
    });
  });
});
