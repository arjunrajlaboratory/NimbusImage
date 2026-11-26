import { describe, it, expect, vi } from "vitest";

vi.mock("geojs", () => ({
  default: {
    util: { pixelCoordinateParams: () => ({ layer: {} }) },
  },
}));

import {
  createImageTileOverlayLayer,
  isImageOverlayLayer,
  orderLayersAboveImages,
  registerImageOverlayLayer,
} from "./imageTileOverlayLayer";

/**
 * A map whose layers follow GeoJS's z-index rules (geojs/src/layer.js): a new
 * layer gets max + 1; zIndex(z) bumps any sibling already at z (recursively);
 * moveToTop rotates the z-indices of the layers above into place.
 */
function fakeMap() {
  const layers: any[] = [];
  const sorted = () => [...layers].sort((a, b) => a.zIndex() - b.zIndex());
  function makeLayer(name: string) {
    let z = layers.length
      ? Math.max(...layers.map((layer) => layer.zIndex())) + 1
      : 0;
    const layer: any = {
      name,
      zIndex: (value?: number, allowDuplicate?: boolean) => {
        if (value === undefined) {
          return z;
        }
        if (!allowDuplicate) {
          [...layers].reverse().forEach((other) => {
            if (other !== layer && other.zIndex() === value) {
              other.zIndex(value + 1);
            }
          });
        }
        z = value;
        return layer;
      },
      moveToTop: vi.fn(() => {
        const order = sorted();
        for (let i = order.indexOf(layer) + 1; i < order.length; i++) {
          const mine = layer.zIndex();
          layer.zIndex(order[i].zIndex(), true);
          order[i].zIndex(mine, true);
        }
      }),
      node: () => ({ css: vi.fn() }),
      opacity: vi.fn(),
    };
    layers.push(layer);
    return layer;
  }
  const map: any = {
    node: () => [document.createElement("div")],
    layers: () => [...layers],
    createLayer: vi.fn((_kind: string, params: any) =>
      makeLayer(params?.name ?? "layer"),
    ),
  };
  const order = () => sorted().map((layer) => layer.name);
  return { map, makeLayer, order, layers };
}

function viewer() {
  const parts = fakeMap();
  const images = [parts.makeLayer("image0"), parts.makeLayer("image1")];
  const stack = ["annotation", "text", "interaction"].map(parts.makeLayer);
  return { ...parts, images, stack };
}

function overlay(parts: ReturnType<typeof viewer>, name: string) {
  return createImageTileOverlayLayer({
    map: { ...parts.map, createLayer: () => parts.makeLayer(name) },
    annotationLayer: parts.stack[0],
    sizeX: 100,
    sizeY: 100,
    maxLevel: 2,
    tileSize: 256,
    opacity: 0.7,
  });
}

describe("orderLayersAboveImages", () => {
  it("keeps overlays above display layers added after them", () => {
    const parts = viewer();
    const heatMap = overlay(parts, "heatMap");
    expect(isImageOverlayLayer(heatMap)).toBe(true);
    // Created at the annotation layer's index: under the outlines.
    expect(parts.order()).toEqual([
      "image0",
      "image1",
      "heatMap",
      "annotation",
      "text",
      "interaction",
    ]);
    orderLayersAboveImages(parts.map, 2, parts.stack);

    // A display layer is added: its two image layers are created on top.
    parts.makeLayer("image2");
    parts.makeLayer("image3");
    orderLayersAboveImages(parts.map, 4, parts.stack);
    expect(parts.order()).toEqual([
      "image0",
      "image1",
      "image2",
      "image3",
      "heatMap",
      "annotation",
      "text",
      "interaction",
    ]);
  });

  it("keeps several overlays in their order and any registered layer counts", () => {
    const parts = viewer();
    overlay(parts, "mapA");
    overlay(parts, "mapB");
    registerImageOverlayLayer(parts.makeLayer("points"));
    parts.makeLayer("image2");
    parts.makeLayer("image3");
    orderLayersAboveImages(parts.map, 4, [...parts.stack, null, undefined]);
    expect(parts.order().slice(4)).toEqual([
      "mapA",
      "mapB",
      "points",
      "annotation",
      "text",
      "interaction",
    ]);
  });

  it("does nothing when the order is already right", () => {
    const parts = viewer();
    overlay(parts, "heatMap");
    orderLayersAboveImages(parts.map, 2, parts.stack);
    parts.layers.forEach((layer) => layer.moveToTop.mockClear());
    orderLayersAboveImages(parts.map, 2, parts.stack);
    parts.layers.forEach((layer) =>
      expect(layer.moveToTop).not.toHaveBeenCalled(),
    );
  });

  it("orders the annotation stack above the images as before when there is no overlay", () => {
    const parts = viewer();
    parts.makeLayer("image2");
    parts.makeLayer("image3");
    orderLayersAboveImages(parts.map, 4, parts.stack);
    expect(parts.order()).toEqual([
      "image0",
      "image1",
      "image2",
      "image3",
      "annotation",
      "text",
      "interaction",
    ]);
  });
});
