import { describe, it, expect, vi } from "vitest";

vi.mock("geojs", () => ({
  default: {
    util: { pixelCoordinateParams: () => ({ layer: {} }) },
  },
}));

import {
  createImageTileOverlayLayer,
  deleteLayerIfHeld,
  isImageOverlayLayer,
  orderLayersAboveImages,
  registerImageOverlayLayer,
} from "./imageTileOverlayLayer";

/**
 * A map whose layers follow GeoJS's z-index rules (geojs/src/layer.js,
 * map.js): a new layer gets max + 1; zIndex(z) bumps any sibling already at
 * z (recursively); moveToTop rotates the z-indices of the layers above into
 * place; deleteLayer removes the layer and leaves its z-index as a gap.
 */
function fakeMap() {
  const layers: any[] = [];
  let nextName = "layer";
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
    createLayer: vi.fn(() => makeLayer(nextName)),
    deleteLayer: vi.fn((layer: any) => {
      layers.splice(layers.indexOf(layer), 1);
    }),
  };
  const order = () => sorted().map((layer) => layer.name);
  const named = (name: string) => {
    nextName = name;
  };
  const moves = () =>
    layers.reduce((sum, layer) => sum + layer.moveToTop.mock.calls.length, 0);
  const clearMoves = () =>
    layers.forEach((layer) => layer.moveToTop.mockClear());
  return { map, makeLayer, order, layers, named, moves, clearMoves };
}

function viewer() {
  const parts = fakeMap();
  const images = [parts.makeLayer("image0"), parts.makeLayer("image1")];
  const stack = ["overview", "workerPreview", "annotation", "text"].map(
    parts.makeLayer,
  );
  // The viewer's draw: orders the map and records its stack.
  const draw = () => orderLayersAboveImages(parts.map, stack);
  return { ...parts, images, stack, draw };
}

function overlay(parts: ReturnType<typeof viewer>, name: string) {
  parts.named(name);
  return createImageTileOverlayLayer({
    map: parts.map,
    annotationLayer: parts.stack[2],
    sizeX: 100,
    sizeY: 100,
    maxLevel: 2,
    tileSize: 256,
    opacity: 0.7,
  });
}

const STACK = ["overview", "workerPreview", "annotation", "text"];

describe("orderLayersAboveImages", () => {
  it("keeps overlays above display layers added after them", () => {
    const parts = viewer();
    parts.draw();
    const heatMap = overlay(parts, "heatMap");
    expect(isImageOverlayLayer(heatMap)).toBe(true);

    // A display layer is added: its two image layers are created on top.
    parts.makeLayer("image2");
    parts.makeLayer("image3");
    parts.draw();
    expect(parts.order()).toEqual([
      "image0",
      "image1",
      "image2",
      "image3",
      "heatMap",
      ...STACK,
    ]);
  });

  it("places a new overlay below the overview raster at once, without a viewer draw", () => {
    const parts = viewer();
    parts.draw();
    overlay(parts, "heatMap");
    expect(parts.order()).toEqual(["image0", "image1", "heatMap", ...STACK]);
    // A layer registered by a component (the transcript points) too.
    parts.named("points");
    registerImageOverlayLayer(parts.map, parts.map.createLayer());
    expect(parts.order()).toEqual([
      "image0",
      "image1",
      "heatMap",
      "points",
      ...STACK,
    ]);
    // And the next draw agrees: nothing moves.
    parts.clearMoves();
    parts.draw();
    expect(parts.moves()).toBe(0);
  });

  it("goes under the annotation layer before the viewer has ordered the map", () => {
    const parts = viewer();
    overlay(parts, "heatMap");
    expect(parts.order()).toEqual([
      "image0",
      "image1",
      "overview",
      "workerPreview",
      "heatMap",
      "annotation",
      "text",
    ]);
  });

  it("stops moving layers after an overlay is shown, hidden and drawn twice", () => {
    const parts = viewer();
    parts.draw();
    const heatMap = overlay(parts, "heatMap");
    parts.draw();
    // Hiding a map deletes its layer, leaving a gap in the z-indices.
    deleteLayerIfHeld(parts.map, heatMap);
    parts.draw();
    parts.clearMoves();
    parts.draw();
    expect(parts.moves()).toBe(0);
    expect(parts.order()).toEqual(["image0", "image1", ...STACK]);
  });

  it("keeps several overlays in their order and any registered layer counts", () => {
    const parts = viewer();
    parts.draw();
    overlay(parts, "mapA");
    overlay(parts, "mapB");
    parts.makeLayer("image2");
    parts.makeLayer("image3");
    orderLayersAboveImages(parts.map, [...parts.stack, null, undefined]);
    expect(parts.order().slice(4)).toEqual(["mapA", "mapB", ...STACK]);
  });

  it("does nothing when the order is already right", () => {
    const parts = viewer();
    parts.draw();
    overlay(parts, "heatMap");
    parts.clearMoves();
    parts.draw();
    expect(parts.moves()).toBe(0);
  });

  it("orders the annotation stack above the images as before when there is no overlay", () => {
    const parts = viewer();
    parts.makeLayer("image2");
    parts.makeLayer("image3");
    parts.draw();
    expect(parts.order()).toEqual([
      "image0",
      "image1",
      "image2",
      "image3",
      ...STACK,
    ]);
  });
});
