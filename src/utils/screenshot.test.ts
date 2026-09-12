import { describe, expect, it, vi } from "vitest";
import { getChannelsDownloadUrls, getLayersDownloadUrls } from "./screenshot";
import { newLayer, type IDataset, type IFrameInfo } from "@/store/model";
import { parseTiles, type ITileMeta } from "@/store/GirderAPI";
import type { IGirderItem } from "@/girder";
import { getBandOption } from "@/store/images";
import { snapshotLayers, snapshotLocations } from "./snapshotDimensions";

vi.mock("@/store/progress", () => ({ default: {} }));

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

describe("snapshot coordinate translation", () => {
  function sparseFixture() {
    const frames: IFrameInfo[] = [];
    for (const IndexXY of [3, 8]) {
      for (const IndexT of [4, 9]) {
        for (const PositionZ of [10, 20]) {
          for (const IndexC of [2, 7]) {
            frames.push({
              IndexXY,
              IndexT,
              PositionZ,
              IndexC,
              PositionX: 0,
              PositionY: 0,
              DeltaT: 0,
            });
          }
        }
      }
    }
    // Use the actual metadata parser so tests cannot silently accept slider
    // indices as image keys. PositionZ is used when IndexZ is absent.
    const dataset = parseTiles(
      { _id: "image" } as IGirderItem,
      { frames, sizeX: 128, sizeY: 96 } as ITileMeta,
      false,
      false,
      false,
    ) as IDataset;
    const layer = newLayer(dataset, []);
    layer.channel = 1;
    return {
      dataset,
      layer,
      api: { getLayerHistogram: vi.fn().mockResolvedValue(null) },
    };
  }

  it.each(
    Array.from({ length: 8 }, (_, mask) =>
      (["raw", "scaled"] as const).map((mode) => ({ mask, mode })),
    ).flat(),
  )(
    "resolves $mode frame IDs for sparse coordinates with axis mask $mask",
    async ({ mask, mode: exportMode }) => {
      const { dataset, layer, api } = sparseFixture();
      const across = { xy: !!(mask & 1), time: !!(mask & 2), z: !!(mask & 4) };
      const layers = snapshotLayers([layer], across);
      for (const at of snapshotLocations(
        dataset,
        { xy: 1, time: 1, z: 1 },
        across,
      )) {
        const firstFrame = at.xy * 8 + at.time * 4 + at.z * 2;
        const base = new URL("http://localhost/region");
        if (exportMode === "raw") {
          for (const channel of ["all", 7] as const) {
            const urls = getChannelsDownloadUrls(base, channel, dataset, at);
            expect(
              urls.map(({ channel, url }) => [
                channel,
                Number(url.searchParams.get("frame")),
              ]),
            ).toEqual(
              channel === "all"
                ? [
                    [2, firstFrame],
                    [7, firstFrame + 1],
                  ]
                : [[7, firstFrame + 1]],
            );
          }
        } else {
          for (const mode of ["all", "composite", layer.id]) {
            const [{ url }] = await getLayersDownloadUrls(
              base,
              mode,
              layers,
              dataset,
              at,
              api,
            );
            const style = JSON.parse(url.searchParams.get("style")!);
            expect(mode === "all" ? style.frame : style.bands[0].frame).toBe(
              firstFrame + 1,
            );
          }
        }
      }
    },
  );

  it("resolves sparse coordinates in standalone layer styles and unchecked projections", async () => {
    const { dataset, layer, api } = sparseFixture();
    layer.xy = { type: "constant", value: 0 };
    layer.time = { type: "offset", value: -1 };
    layer.z = { type: "max-merge", value: null };
    const style = await getBandOption(
      dataset,
      layer,
      { xy: 1, time: 1, z: 1 },
      api,
    );
    expect("bands" in style && style.bands.map((band) => band.frame)).toEqual([
      1, 3,
    ]);
    expect(api.getLayerHistogram.mock.calls[0][0][0].frameIndex).toBe(3);
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
