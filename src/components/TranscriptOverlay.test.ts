import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";
import { AxiosError, AxiosHeaders } from "axios";
import { encodeTranscriptPoints } from "@/utils/transcriptPoints";
import { decodeTranscriptPoints } from "@/utils/transcriptPoints";

const mocks = vi.hoisted(() => ({
  fetchTranscriptPoints: vi.fn(),
  setStatus: vi.fn(),
  setReadout: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1" },
    shareLinkTileToken: "share-token",
    spatialAPI: {
      fetchTranscriptPoints: mocks.fetchTranscriptPoints,
      transcriptDensityTemplateUrl: (options: any) =>
        `density?genes=${options.genes.join(",")}&color=${options.color}&token=${options.authToken}`,
    },
  },
}));

vi.mock("@/store/transcripts", async () => {
  const { reactive } = await import("vue");
  const state = reactive({
    schema: null as any,
    hasTranscripts: true,
    enabled: true,
    genes: [{ symbol: "CD3E", color: "#FF0000" }],
    minQv: 20,
    mode: "auto",
    pointBudget: 300000,
    opacity: 0.85,
    setStatus: mocks.setStatus,
    setReadout: mocks.setReadout,
    get symbols() {
      return this.genes.map((gene: any) => gene.symbol);
    },
    get requestSignature() {
      return JSON.stringify([
        this.enabled,
        this.symbols,
        this.minQv,
        this.mode,
        this.pointBudget,
      ]);
    },
  });
  return { default: state };
});

vi.mock("geojs", () => ({
  default: {
    util: {
      convertColor: (color: string) => ({ r: 1, g: 0, b: 0, hex: color }),
      pixelCoordinateParams: () => ({ layer: {} }),
    },
    event: { pan: "geo_pan", feature: { mouseclick: "geo_feature_click" } },
  },
}));

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));
vi.mock("@/utils/errors", () => ({
  extractErrorMessage: (error: any) => error?.message ?? String(error),
}));
vi.mock("@/utils/annotationAtPoint", () => ({
  annotationIdAtPoint: (_layer: any, point: { x: number }) =>
    point.x === 1 ? "cell1" : null,
}));

import TranscriptOverlay from "./TranscriptOverlay.vue";
import transcriptsStore from "@/store/transcripts";

// A 4-level pyramid over 2 mm x 1 mm at 0.5 um/px (4000 x 2000 px), with
// 1000 molecules per level-0 tile and halving totals per level.
function schema(levels = 4) {
  const tiles = [];
  for (let level = 0; level < levels; level++) {
    const size = 250 * Math.pow(2, level);
    const keys: string[] = [];
    const counts: number[] = [];
    for (let gx = 0; gx < Math.ceil(2000 / size); gx++) {
      for (let gy = 0; gy < Math.ceil(1000 / size); gy++) {
        keys.push(`${gx},${gy}`);
        counts.push(1000 * Math.pow(2, level));
      }
    }
    tiles.push({
      level,
      tileMicrons: size,
      tilePixels: size * 2,
      keys,
      counts,
    });
  }
  return {
    itemId: "i",
    levels,
    gridSizeMicrons: 250,
    pixelSize: 0.5,
    transform: null,
    genes: 100,
    totalPoints: 32000,
    tiles,
  };
}

function makeMap(bounds = { left: 0, top: 0, right: 600, bottom: 300 }) {
  const feature = {
    style: vi.fn(),
    position: vi.fn(),
    data: vi.fn(),
    draw: vi.fn(),
    geoOn: vi.fn(),
    geoOff: vi.fn(),
  };
  const featureLayer = { createFeature: vi.fn(() => feature) };
  const osmLayers: any[] = [];
  const makeOsm = () => {
    const osmLayer: any = {
      _visible: false,
      visible: vi.fn((value?: boolean) => {
        if (value === undefined) {
          return osmLayer._visible;
        }
        osmLayer._visible = value;
        return osmLayer;
      }),
      url: vi.fn(),
      zIndex: vi.fn(),
      opacity: vi.fn(),
      node: () => ({ css: vi.fn() }),
    };
    osmLayers.push(osmLayer);
    return osmLayer;
  };
  const map = {
    bounds: vi.fn(() => bounds),
    geoOn: vi.fn(),
    geoOff: vi.fn(),
    deleteLayer: vi.fn(),
    node: () => [document.createElement("div")],
    createLayer: vi.fn((kind: string) =>
      kind === "osm" ? makeOsm() : featureLayer,
    ),
  };
  return {
    map,
    feature,
    featureLayer,
    osmLayers,
    get osmLayer() {
      return osmLayers[0];
    },
  };
}

function points(count: number, level0 = true) {
  return decodeTranscriptPoints(
    encodeTranscriptPoints({
      x: Array.from({ length: count }, (_, i) => i),
      y: Array.from({ length: count }, (_, i) => i * 2),
      gene: new Array(count).fill(0),
      quality: level0 ? new Array(count).fill(30) : null,
    }),
  );
}

function axios413() {
  return new AxiosError("Too many", "413", undefined, undefined, {
    status: 413,
    statusText: "Payload Too Large",
    data: { message: "More than N points" },
    headers: {},
    config: { headers: new AxiosHeaders() },
  });
}

const mounted: { unmount: () => void }[] = [];

function mount(mapParts = makeMap(), disabled = false) {
  const wrapper = shallowMount(TranscriptOverlay, {
    props: {
      map: mapParts.map as any,
      annotationLayer: { zIndex: () => 5 } as any,
      sizeX: 4000,
      sizeY: 2000,
      maxLevel: 8,
      disabled,
    },
  });
  mounted.push(wrapper);
  return { wrapper, ...mapParts };
}

describe("TranscriptOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fetchTranscriptPoints.mockReset().mockResolvedValue(points(3));
    mocks.setStatus.mockClear();
    mocks.setReadout.mockClear();
    const state = transcriptsStore as any;
    state.schema = schema();
    state.enabled = true;
    state.mode = "auto";
    state.minQv = 20;
    state.pointBudget = 300000;
    state.genes = [{ symbol: "CD3E", color: "#FF0000" }];
  });

  afterEach(() => {
    // A leaked overlay keeps watching the shared store mock and would fetch
    // on the next test's setup.
    mounted.splice(0).forEach((wrapper) => wrapper.unmount());
    vi.useRealTimers();
  });

  it("fetches the view's tiles at the finest fitting level and draws them", async () => {
    const { feature, map } = mount();
    expect(map.geoOn).toHaveBeenCalledWith("geo_pan", expect.any(Function));
    await vi.advanceTimersByTimeAsync(250);
    // 600 x 300 px = 300 x 150 um: level-0 tiles 0,0 and 1,0.
    expect(mocks.fetchTranscriptPoints).toHaveBeenCalledWith(
      "ds1",
      ["CD3E"],
      0,
      ["0,0", "1,0"],
      20,
    );
    expect(feature.data).toHaveBeenCalledWith([0, 1, 2]);
    expect(feature.draw).toHaveBeenCalled();
    expect(mocks.setStatus).toHaveBeenLastCalledWith({
      rendering: "points",
      level: 0,
      points: 3,
      note: null,
    });
  });

  it("steps one level coarser when the server answers 413", async () => {
    mocks.fetchTranscriptPoints
      .mockRejectedValueOnce(axios413())
      .mockResolvedValueOnce(points(2, false));
    mount();
    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.fetchTranscriptPoints).toHaveBeenCalledTimes(2);
    expect(mocks.fetchTranscriptPoints.mock.calls[1][2]).toBe(1);
    expect(mocks.fetchTranscriptPoints.mock.calls[1][3]).toEqual(["0,0"]);
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ rendering: "points", level: 1 }),
    );
  });

  it.each(["auto", "density"])(
    "clears a previously populated viewport when its tile plan is empty in %s mode",
    async (mode) => {
      const parts = makeMap();
      mount(parts);
      await vi.advanceTimersByTimeAsync(250);
      mocks.fetchTranscriptPoints.mockClear();
      parts.feature.data.mockClear();
      (transcriptsStore as any).mode = mode;
      (transcriptsStore as any).schema.tiles[0].keys = [];
      (transcriptsStore as any).schema.tiles[0].counts = [];
      const pan = parts.map.geoOn.mock.calls.find(
        ([event]) => event === "geo_pan",
      )![1];
      pan();
      await vi.advanceTimersByTimeAsync(250);
      expect(mocks.fetchTranscriptPoints).not.toHaveBeenCalled();
      expect(parts.feature.data).toHaveBeenCalledWith([]);
      expect(mocks.setReadout).toHaveBeenLastCalledWith(null);
      expect(mocks.setStatus).toHaveBeenLastCalledWith({
        rendering: "none",
        level: 0,
        points: 0,
        note: null,
      });
    },
  );

  it("rechecks rendering capabilities when the schema is refreshed", async () => {
    (transcriptsStore as any).mode = "density";
    const parts = makeMap();
    mount(parts);
    await vi.advanceTimersByTimeAsync(250);
    expect(parts.osmLayer.visible()).toBe(true);
    (transcriptsStore as any).schema = {
      ...schema(),
      transform: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    };
    await nextTick();
    await vi.advanceTimersByTimeAsync(250);
    expect(parts.osmLayer.visible()).toBe(false);
    expect(mocks.fetchTranscriptPoints).toHaveBeenCalled();
  });

  it("does not request an empty coarser tile set after a 413", async () => {
    (transcriptsStore as any).schema.tiles[1].keys = [];
    (transcriptsStore as any).schema.tiles[1].counts = [];
    mocks.fetchTranscriptPoints.mockRejectedValueOnce(axios413());
    mount();
    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.fetchTranscriptPoints).toHaveBeenCalledTimes(1);
    expect(mocks.setStatus).toHaveBeenLastCalledWith({
      rendering: "none",
      level: 1,
      points: 0,
      note: null,
    });
  });

  it("shows the density heat map when zoomed far out in auto mode, and when asked", async () => {
    const parts = makeMap({ left: 0, top: 0, right: 4000, bottom: 2000 });
    (transcriptsStore as any).pointBudget = 100;
    mount(parts);
    await vi.advanceTimersByTimeAsync(250);
    const osmLayer = parts.osmLayer;
    expect(mocks.fetchTranscriptPoints).not.toHaveBeenCalled();
    expect(osmLayer.url).toHaveBeenCalledWith(
      "density?genes=CD3E&color=#FF0000&token=share-token",
    );
    expect(osmLayer.visible()).toBe(true);
    expect(osmLayer.opacity).toHaveBeenCalledWith(0.85);
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ rendering: "density" }),
    );
    // Forcing points fetches even though the view is wide.
    (transcriptsStore as any).mode = "points";
    await nextTick();
    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.fetchTranscriptPoints).toHaveBeenCalled();
    expect(osmLayer.visible()).toBe(false);
  });

  it("draws one heat map per gene in its own color and deletes removed ones", async () => {
    const parts = makeMap({ left: 0, top: 0, right: 4000, bottom: 2000 });
    (transcriptsStore as any).mode = "density";
    (transcriptsStore as any).genes = [
      { symbol: "CD3E", color: "#FF0000" },
      { symbol: "MS4A1", color: "#00FF00" },
    ];
    mount(parts);
    await vi.advanceTimersByTimeAsync(250);
    expect(parts.osmLayers).toHaveLength(2);
    expect(parts.osmLayers[1].url).toHaveBeenCalledWith(
      "density?genes=MS4A1&color=#00FF00&token=share-token",
    );
    expect(parts.osmLayers.every((l) => l.visible())).toBe(true);
    (transcriptsStore as any).genes = [{ symbol: "MS4A1", color: "#00FF00" }];
    await nextTick();
    await vi.advanceTimersByTimeAsync(250);
    // The removed gene's layer is deleted, not merely hidden.
    expect(parts.map.deleteLayer).toHaveBeenCalledWith(parts.osmLayers[0]);
    expect(parts.osmLayers[1].visible()).toBe(true);
    // Opacity is a restyle: every layer follows, no refetch.
    (transcriptsStore as any).opacity = 0.4;
    await nextTick();
    expect(parts.osmLayers[1].opacity).toHaveBeenLastCalledWith(0.4);
  });

  it.each(["auto", "density"])(
    "uses points for transformed registrations in %s mode",
    async (mode) => {
      (transcriptsStore as any).schema.transform = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
      (transcriptsStore as any).mode = mode;
      (transcriptsStore as any).pointBudget = 100;
      const parts = makeMap({ left: 0, top: 0, right: 4000, bottom: 2000 });
      mount(parts);
      await vi.advanceTimersByTimeAsync(250);
      expect(mocks.fetchTranscriptPoints).toHaveBeenCalled();
      expect(parts.osmLayers).toHaveLength(0);
      expect(mocks.setStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ rendering: "points" }),
      );
    },
  );

  it("clears everything when disabled, turned off, or without genes", async () => {
    const parts = makeMap();
    const { feature } = mount(parts);
    await vi.advanceTimersByTimeAsync(250);
    feature.data.mockClear();
    (transcriptsStore as any).enabled = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(250);
    expect(feature.data).toHaveBeenCalledWith([]);
    expect(parts.osmLayers.some((l) => l.visible())).toBe(false);
    expect(mocks.setStatus).toHaveBeenLastCalledWith(null);
  });

  it("ignores a fetch that finishes after a newer one started", async () => {
    let resolveFirst!: (value: any) => void;
    mocks.fetchTranscriptPoints
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(points(1));
    const { feature } = mount();
    await vi.advanceTimersByTimeAsync(250);
    (transcriptsStore as any).minQv = 30;
    await nextTick();
    await vi.advanceTimersByTimeAsync(250);
    expect(feature.data).toHaveBeenCalledWith([0]);
    feature.data.mockClear();
    resolveFirst(points(3));
    await nextTick();
    expect(feature.data).not.toHaveBeenCalled();
  });

  it("reports the clicked molecule and tears down on unmount", async () => {
    const parts = makeMap();
    const { wrapper, feature, map } = mount(parts);
    await vi.advanceTimersByTimeAsync(250);
    const onClick = feature.geoOn.mock.calls.find(
      ([event]) => event === "geo_feature_click",
    )![1];
    onClick({ index: 1 });
    expect(mocks.setReadout).toHaveBeenCalledWith({
      symbol: "CD3E",
      x: 1,
      y: 2,
      quality: 30,
      annotationId: "cell1",
    });
    onClick({ index: 2 });
    expect(mocks.setReadout).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 2, annotationId: null }),
    );
    wrapper.unmount();
    expect(map.geoOff).toHaveBeenCalledWith("geo_pan", expect.any(Function));
    // The point layer and every heat-map layer go.
    expect(map.deleteLayer).toHaveBeenCalledTimes(1 + parts.osmLayers.length);
  });

  it("does nothing while unrolled", async () => {
    mount(makeMap(), true);
    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.fetchTranscriptPoints).not.toHaveBeenCalled();
    expect(mocks.setStatus).toHaveBeenLastCalledWith(null);
  });
});
