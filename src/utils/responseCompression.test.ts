import axios, { type InternalAxiosRequestConfig } from "axios";
import { describe, expect, it } from "vitest";

import {
  requestCompressedResponses,
  withCompressionOptIn,
} from "./responseCompression";

// Send a request through a real axios instance and return the config its
// adapter received, after the interceptors ran.
async function sentConfig(
  params?: Record<string, unknown> | URLSearchParams,
): Promise<InternalAxiosRequestConfig> {
  const instance = axios.create();
  requestCompressedResponses(instance);
  let captured: InternalAxiosRequestConfig | undefined;
  await instance.get("http://girder.test/api/v1/upenn_annotation", {
    params,
    adapter: async (config) => {
      captured = config;
      return { data: null, status: 200, statusText: "OK", headers: {}, config };
    },
  });
  return captured!;
}

describe("requestCompressedResponses", () => {
  it("opts a request with no params in", async () => {
    expect((await sentConfig()).params).toEqual({ compress: "zstd" });
  });

  it("keeps a request's own params", async () => {
    expect((await sentConfig({ datasetId: "ds1", limit: 0 })).params).toEqual({
      datasetId: "ds1",
      limit: 0,
      compress: "zstd",
    });
  });

  it("opts URLSearchParams in without dropping them", async () => {
    const config = await sentConfig(new URLSearchParams("datasetId=ds1"));
    expect(config.params.toString()).toBe("datasetId=ds1&compress=zstd");
  });

  it("puts the opt-in on the URL axios sends", async () => {
    const config = await sentConfig({ datasetId: "ds1" });
    expect(axios.getUri(config)).toBe(
      "http://girder.test/api/v1/upenn_annotation?datasetId=ds1&compress=zstd",
    );
  });
});

describe("withCompressionOptIn", () => {
  it("starts a query string when there is none", () => {
    expect(withCompressionOptIn("http://girder.test/api/v1/export/csv")).toBe(
      "http://girder.test/api/v1/export/csv?compress=zstd",
    );
  });

  it("appends to an existing query string", () => {
    expect(withCompressionOptIn("http://g.test/api/v1/export/json?a=1")).toBe(
      "http://g.test/api/v1/export/json?a=1&compress=zstd",
    );
  });
});
