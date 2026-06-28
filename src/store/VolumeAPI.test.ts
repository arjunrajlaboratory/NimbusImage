import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TileFrameVolumeSource } from "@/store/VolumeAPI";
import {
  IDataset,
  IDisplayLayer,
  IFrameInfo,
  IImage,
  ILayerStackImage,
} from "@/store/model";
import type { ITileMeta } from "@/store/GirderAPI";

vi.mock("@/utils/log", () => ({
  logWarning: vi.fn(),
  logError: vi.fn(),
}));

function makeImage(frameIndex: number, z: number, positionZ?: number): IImage {
  const tileinfo = {
    IndexRange: {},
    levels: 1,
    magnification: 1,
    mm_x: 0.001,
    mm_y: 0.002,
    sizeX: 8,
    sizeY: 4,
    tileWidth: 8,
    tileHeight: 4,
    frames: [],
    omeinfo: {} as ITileMeta["omeinfo"],
    channels: ["channel"],
  };
  return {
    item: { _id: "item1" } as IImage["item"],
    levels: 1,
    frameIndex,
    key: { z, xy: 0, t: 0, c: 0 },
    keyOffset: 0,
    frame: {
      DeltaT: 0,
      PositionX: 0,
      PositionY: 0,
      IndexZ: z,
      IndexC: 0,
      IndexT: 0,
      IndexXY: 0,
      ...(positionZ === undefined ? {} : { PositionZ: positionZ }),
    } as IFrameInfo,
    sizeX: 8,
    sizeY: 4,
    tileWidth: 8,
    tileHeight: 4,
    mm_x: 0.001,
    mm_y: 0.002,
    tileinfo: tileinfo as ITileMeta,
  };
}

const layer: IDisplayLayer = {
  id: "layer1",
  name: "Layer 1",
  color: "#00ff00",
  channel: 0,
  xy: { type: "current", value: null },
  z: { type: "max-merge", value: null },
  time: { type: "current", value: null },
  visible: true,
  contrast: { mode: "absolute", blackPoint: 11, whitePoint: 44 },
  layerGroup: null,
};

function makeDataset(images: IImage[]): IDataset {
  return {
    id: "dataset",
    name: "Dataset",
    description: "",
    creatorId: "user",
    xy: [0],
    z: images.map((image) => image.key.z),
    time: [0],
    channels: [0],
    channelNames: new Map([[0, "channel"]]),
    width: 8,
    height: 4,
    images: (z: number) => images.filter((image) => image.key.z === z),
    anyImage: () => images[0] ?? null,
    allImages: images,
  };
}

describe("TileFrameVolumeSource", () => {
  let getContextSpy: { mockRestore: () => void };

  beforeEach(() => {
    let decodeCall = 0;
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ close: vi.fn() })),
    );
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({
        drawImage: vi.fn(),
        getImageData: (
          _x: number,
          _y: number,
          width: number,
          height: number,
        ) => {
          const data = new Uint8ClampedArray(width * height * 4);
          for (let index = 0; index < width * height; index += 1) {
            data[index * 4] = decodeCall * 10 + index;
          }
          decodeCall += 1;
          return { data };
        },
      } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    getContextSpy.mockRestore();
  });

  it("resolves frames through dataset metadata and builds micrometer-spaced vtkImageData", async () => {
    const z0 = makeImage(7, 0, 0);
    const z1 = makeImage(3, 1, 5);
    const dataset = makeDataset([z0, z1]);
    const layerStackImage: ILayerStackImage = {
      layer,
      images: [z0],
      urls: [],
      fullUrls: [],
      hist: null,
      singleFrame: null,
    };
    const client: { get: any } = {
      get: vi.fn(async () => ({ data: new Blob(["png"]) })),
    };

    const source = new TileFrameVolumeSource(client as any, {
      concurrency: 1,
      maxXYDimension: 4,
      scalarMemoryBudgetBytes: 1024 * 1024,
    });
    const [volume] = await source.buildVolume({
      dataset,
      layers: [layerStackImage],
      xy: 0,
      z: 0,
      time: 0,
      zStepUmOverride: null,
    });

    expect(volume.imageData.getDimensions()).toEqual([4, 2, 2]);
    expect(volume.imageData.getSpacing()).toEqual([2, 4, 5]);
    expect(volume.geometry.sourceSize).toEqual([8, 4]);
    expect(
      Array.from(volume.imageData.getPointData().getScalars().getData()),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 16, 17]);

    const getMock = client.get as ReturnType<typeof vi.fn>;
    expect(getMock).toHaveBeenCalledTimes(2);
    const firstConfig = getMock.mock.calls[0][1];
    const secondConfig = getMock.mock.calls[1][1];
    expect(getMock.mock.calls[0][0]).toBe("item/item1/tiles/region");
    expect(firstConfig.params.frame).toBe(7);
    expect(secondConfig.params.frame).toBe(3);
    expect(firstConfig.params.width).toBe(4);
    expect(firstConfig.params.height).toBe(2);

    const style = JSON.parse(firstConfig.params.style);
    expect(style).toMatchObject({
      min: 11,
      max: 44,
      palette: ["#000000", "#ffffff"],
      frame: 7,
    });
    expect("bands" in style).toBe(false);
  });

  it("uses dataset z dimension labels before missing frame positions or invalid overrides", async () => {
    const z0 = makeImage(0, 0);
    const z1 = makeImage(1, 1);
    const z2 = makeImage(2, 2);
    const dataset: IDataset = {
      ...makeDataset([z0, z1, z2]),
      dimensionLabels: { z: ["-5 µm", "0 nm", "5 µm"] },
    };
    const layerStackImage: ILayerStackImage = {
      layer,
      images: [z0],
      urls: [],
      fullUrls: [],
      hist: null,
      singleFrame: null,
    };
    const client: { get: any } = {
      get: vi.fn(async () => ({ data: new Blob(["png"]) })),
    };

    const source = new TileFrameVolumeSource(client as any, {
      concurrency: 1,
      maxXYDimension: 4,
      scalarMemoryBudgetBytes: 1024 * 1024,
    });
    const [volume] = await source.buildVolume({
      dataset,
      layers: [layerStackImage],
      xy: 0,
      z: 0,
      time: 0,
      zStepUmOverride: 1_000_000,
    });

    expect(volume.imageData.getDimensions()).toEqual([4, 2, 3]);
    expect(volume.imageData.getSpacing()).toEqual([2, 4, 5]);
  });

  it("accepts a valid micrometer z-step override when metadata is unavailable", async () => {
    const z0 = makeImage(0, 0);
    const z1 = makeImage(1, 1);
    const dataset = makeDataset([z0, z1]);
    const layerStackImage: ILayerStackImage = {
      layer,
      images: [z0],
      urls: [],
      fullUrls: [],
      hist: null,
      singleFrame: null,
    };
    const client: { get: any } = {
      get: vi.fn(async () => ({ data: new Blob(["png"]) })),
    };

    const source = new TileFrameVolumeSource(client as any, {
      concurrency: 1,
      maxXYDimension: 4,
      scalarMemoryBudgetBytes: 1024 * 1024,
    });
    const [volume] = await source.buildVolume({
      dataset,
      layers: [layerStackImage],
      xy: 0,
      z: 0,
      time: 0,
      zStepUmOverride: 5,
    });

    expect(volume.imageData.getSpacing()).toEqual([2, 4, 5]);
  });

  it("subsamples the depth axis past the cap and scales depth spacing", async () => {
    // 6 z-planes at 3 µm steps (from PositionZ).
    const images = Array.from({ length: 6 }, (_unused, z) =>
      makeImage(z, z, z * 3),
    );
    const dataset = makeDataset(images);
    const layerStackImage: ILayerStackImage = {
      layer,
      images: [images[0]],
      urls: [],
      fullUrls: [],
      hist: null,
      singleFrame: null,
    };
    const client: { get: any } = {
      get: vi.fn(async () => ({ data: new Blob(["png"]) })),
    };

    const source = new TileFrameVolumeSource(client as any, {
      concurrency: 1,
      maxXYDimension: 8,
      maxDepth: 3,
      scalarMemoryBudgetBytes: 1024 * 1024,
    });
    const [volume] = await source.buildVolume({
      dataset,
      layers: [layerStackImage],
      xy: 0,
      z: 0,
      time: 0,
      zStepUmOverride: null,
    });

    // 6 planes capped at 3 -> stride 2 -> keep z 0, 2, 4.
    expect(volume.imageData.getDimensions()).toEqual([8, 4, 3]);
    expect(volume.geometry.depthStride).toBe(2);
    // Per-plane z step 3 µm × stride 2 = 6 µm.
    expect(volume.imageData.getSpacing()).toEqual([1, 2, 6]);

    const getMock = client.get as ReturnType<typeof vi.fn>;
    expect(getMock).toHaveBeenCalledTimes(3);
    expect(getMock.mock.calls.map((call: any) => call[1].params.frame)).toEqual(
      [0, 2, 4],
    );
  });
});
