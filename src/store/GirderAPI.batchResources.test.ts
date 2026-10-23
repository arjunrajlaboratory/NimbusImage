import { describe, expect, it, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import type { RestClientInstance } from "@/girder";

vi.mock("@/utils/fetch", () => ({
  fetchAllPages: vi.fn(),
}));

vi.mock("@/store/progress", () => ({
  default: {},
}));

import GirderAPI from "./GirderAPI";
import { BATCH_RESOURCES_CHUNK_SIZE } from "./constants";

// The server rejects a request over MAX_BATCH_RESOURCE_IDS (10,000 ids).
const SERVER_MAX_IDS = 10000;

function ids(prefix: string, count: number) {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

// Echo each requested id back as a document named after it.
function echoPost() {
  return vi.fn(async (_path: string, body: Record<string, string[]>) => ({
    data: Object.fromEntries(
      Object.entries(body).map(([kind, kindIds]) => [
        kind,
        Object.fromEntries(kindIds.map((id) => [id, { _id: id, name: id }])),
      ]),
    ),
  }));
}

function apiWith(post: ReturnType<typeof vi.fn>) {
  return new GirderAPI({ post } as unknown as RestClientInstance);
}

function idCount(body: Record<string, string[]>) {
  return Object.values(body).reduce((sum, kindIds) => sum + kindIds.length, 0);
}

describe("batchResources", () => {
  it("chunks stay under the server's per-request id cap", () => {
    expect(BATCH_RESOURCES_CHUNK_SIZE).toBeLessThanOrEqual(SERVER_MAX_IDS);
  });

  it("sends a small lookup as one request", async () => {
    const post = echoPost();

    const result = await apiWith(post).batchResources({
      folder: ["f1", "f2"],
      user: ["u1"],
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("resource/batch", {
      folder: ["f1", "f2"],
      user: ["u1"],
    });
    expect(Object.keys(result.folder!)).toEqual(["f1", "f2"]);
    expect(Object.keys(result.user!)).toEqual(["u1"]);
  });

  it("splits a lookup over the cap across requests and merges them", async () => {
    const post = echoPost();
    const folderIds = ids("f", 12000);
    const collectionIds = ids("c", 300);
    const userIds = ids("u", 50);

    const result = await apiWith(post).batchResources({
      folder: folderIds,
      upenn_collection: collectionIds,
      user: userIds,
    });

    expect(post.mock.calls.length).toBe(
      Math.ceil(12350 / BATCH_RESOURCES_CHUNK_SIZE),
    );
    for (const [, body] of post.mock.calls) {
      expect(idCount(body)).toBeLessThanOrEqual(BATCH_RESOURCES_CHUNK_SIZE);
    }
    // Every id is sent exactly once, under its own kind.
    const sent = (kind: string) =>
      post.mock.calls.flatMap(([, body]) => body[kind] ?? []);
    expect(sent("folder")).toEqual(folderIds);
    expect(sent("upenn_collection")).toEqual(collectionIds);
    expect(sent("user")).toEqual(userIds);
    // Results from every chunk are merged per kind.
    expect(Object.keys(result.folder!)).toHaveLength(12000);
    expect(Object.keys(result.upenn_collection!)).toHaveLength(300);
    expect(Object.keys(result.user!)).toHaveLength(50);
  });

  it("keeps at most two chunk requests in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const echo = echoPost();
    const post = vi.fn(async (path: string, body: Record<string, string[]>) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight--;
      return echo(path, body);
    });

    await apiWith(post).batchResources({
      folder: ids("f", BATCH_RESOURCES_CHUNK_SIZE * 5),
    });

    expect(post).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBe(2);
  });

  it("sends each id once when a caller passes duplicates", async () => {
    const post = echoPost();

    await apiWith(post).batchResources({ folder: ["f1", "f1", "f2"] });

    expect(post).toHaveBeenCalledWith("resource/batch", {
      folder: ["f1", "f2"],
    });
  });

  it("makes no request when no ids are requested", async () => {
    const post = echoPost();

    const result = await apiWith(post).batchResources({ folder: [], user: [] });

    expect(post).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it("returns an empty result on 401", async () => {
    const post = vi.fn().mockRejectedValue(
      new AxiosError("Unauthorized", "401", undefined, undefined, {
        status: 401,
        statusText: "Unauthorized",
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: {},
      }),
    );

    await expect(
      apiWith(post).batchResources({ folder: ["f1"] }),
    ).resolves.toEqual({});
  });

  it("propagates other failures, including one chunk failing", async () => {
    const post = echoPost();
    post.mockRejectedValueOnce(new Error("boom"));

    await expect(
      apiWith(post).batchResources({ folder: ids("f", 6000) }),
    ).rejects.toThrow("boom");
  });
});
