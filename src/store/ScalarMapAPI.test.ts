import { describe, it, expect, vi } from "vitest";
import ScalarMapAPI from "./ScalarMapAPI";

const BASE = {
  itemId: "item1",
  location: "xy0_z1_t2",
  sizeX: 4000,
  sizeY: 2000,
  tileSize: 256,
  maxLevel: 4,
  colormap: "magma" as const,
  min: 0.5,
  max: 12,
  threshold: null,
  thresholdSide: "above" as const,
};

function params(template: string) {
  return new URL(template.replace("{z}/{x}/{y}", "0/0/0")).searchParams;
}

describe("ScalarMapAPI", () => {
  it("uses the documented list and delete routes", async () => {
    const client = {
      get: vi.fn(async () => ({ data: [{ itemId: "a" }] })),
      delete: vi.fn(async () => ({ data: {} })),
    } as any;
    const api = new ScalarMapAPI(client);
    expect(await api.listMaps("ds1")).toEqual([{ itemId: "a" }]);
    expect(client.get).toHaveBeenCalledWith("scalar_map", {
      params: { datasetId: "ds1" },
    });
    await api.deleteMap("a");
    expect(client.delete).toHaveBeenCalledWith("scalar_map/a");
  });

  it("builds a tile template on the image pyramid", () => {
    const api = new ScalarMapAPI({ apiRoot: "http://h/api/v1" } as any);
    expect(api.tileTemplateUrl(BASE)).toBe(
      "http://h/api/v1/scalar_map/item1/tiles/{z}/{x}/{y}?location=xy0_z1_t2&sizeX=4000&sizeY=2000&maxLevel=4&tileSize=256&colormap=magma&min=0.5&max=12",
    );
  });

  it("adds the threshold, version and share-view token only when set", () => {
    const api = new ScalarMapAPI({ apiRoot: "http://h/api/v1" } as any);
    const search = params(
      api.tileTemplateUrl({
        ...BASE,
        threshold: 7.25,
        thresholdSide: "below",
        authToken: "share-token",
        version: "2026-11-01T00:00:00",
      }),
    );
    expect(search.get("threshold")).toBe("7.25");
    expect(search.get("thresholdSide")).toBe("below");
    expect(search.get("token")).toBe("share-token");
    expect(search.get("v")).toBe("2026-11-01T00:00:00");
    const plain = params(api.tileTemplateUrl(BASE));
    expect(plain.has("threshold")).toBe(false);
    expect(plain.has("thresholdSide")).toBe(false);
    expect(plain.has("token")).toBe(false);
  });
});
