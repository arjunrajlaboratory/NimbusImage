import { describe, expect, it, vi } from "vitest";
import { getLayersDownloadUrls } from "./screenshot";
import { newLayer, type IDataset } from "@/store/model";

const location = { xy: 0, z: 0, time: 0 };
function fixture() {
  const dataset = {
    xy: [0],
    z: [0, 1],
    time: [0],
    channels: [0],
    channelNames: new Map(),
    images: vi.fn(() => []),
  } as unknown as IDataset;
  return {
    dataset,
    layer: newLayer(dataset, []),
    api: { getLayerHistogram: vi.fn().mockResolvedValue(null) },
  };
}

describe("scaled snapshot planes", () => {
  it("rejects missing planes instead of exporting default frame zero", async () => {
    const { dataset, layer, api } = fixture();
    await expect(
      getLayersDownloadUrls(
        new URL("http://localhost/region"),
        "composite",
        [layer],
        dataset,
        location,
        api,
      ),
    ).rejects.toThrow("No image");
    expect(api.getLayerHistogram).not.toHaveBeenCalled();
  });
  it("rejects empty layer selections", async () => {
    const { dataset, layer, api } = fixture();
    layer.visible = false;
    await expect(
      getLayersDownloadUrls(
        new URL("http://localhost/region"),
        "composite",
        [layer],
        dataset,
        location,
        api,
      ),
    ).rejects.toThrow("No layers");
    expect(api.getLayerHistogram).not.toHaveBeenCalled();
  });
  it("rejects offset layers outside the dataset", async () => {
    const { dataset, layer, api } = fixture();
    layer.z = { type: "offset", value: 3 };
    await expect(
      getLayersDownloadUrls(
        new URL("http://localhost/region"),
        layer.id,
        [layer],
        dataset,
        location,
        api,
      ),
    ).rejects.toThrow("No image");
  });
});

describe("snapshot crop validation", () => {
  it.each([
    { left: 0, top: 0, right: 0, bottom: 20 },
    { left: 10, top: 20, right: 20, bottom: 10 },
    { left: NaN, top: 0, right: 20, bottom: 20 },
  ])("rejects an empty or invalid crop: %j", async (bounds) => {
    const { getDownloadParameters } = await import("./screenshot");
    expect(() =>
      getDownloadParameters(bounds, "tiff", 4000000, 95, "channels"),
    ).toThrow("positive width and height");
  });
});
