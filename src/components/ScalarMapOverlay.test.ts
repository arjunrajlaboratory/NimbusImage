import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  store: null as any,
  maps: null as any,
}));

vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  mocks.store = reactive({
    xy: 0,
    z: 0,
    time: 0,
    shareLinkTileToken: "share-token",
    scalarMapAPI: {
      tileTemplateUrl: (o: any) =>
        `tiles/${o.itemId}?location=${o.location}&colormap=${o.colormap}` +
        `&min=${o.min}&max=${o.max}&threshold=${o.threshold}` +
        `&side=${o.thresholdSide}&token=${o.authToken}&size=${o.tileSize}` +
        `&v=${o.version}`,
    },
  });
  return { default: mocks.store };
});

vi.mock("@/store/scalarMaps", async () => {
  const { reactive } = await import("vue");
  mocks.maps = reactive({
    currentMaps: [] as any[],
    display: {} as Record<string, any>,
    tileFailedMapIds: [] as string[],
    tileRetryRequests: 0,
    // The store's contract (scalarMaps.test.ts).
    setScalarMapTilesFailed(payload: { itemId: string; failed: boolean }) {
      const ids = mocks.maps.tileFailedMapIds as string[];
      const listed = ids.includes(payload.itemId);
      if (payload.failed && !listed) {
        ids.push(payload.itemId);
      } else if (!payload.failed && listed) {
        ids.splice(ids.indexOf(payload.itemId), 1);
      }
    },
  });
  return { default: mocks.maps };
});

vi.mock("geojs", () => ({
  default: {
    util: { pixelCoordinateParams: () => ({ layer: {} }) },
  },
}));

import ScalarMapOverlay from "./ScalarMapOverlay.vue";

function scalarMap(itemId: string, locations = ["xy0_z0_t0"], revision = "r1") {
  return {
    itemId,
    updated: "u1",
    revision,
    meta: {
      name: itemId,
      locations: locations.map((key) => {
        const [xy, z, t] = key.match(/\d+/g)!.map(Number);
        return { XY: xy, Z: z, Time: t, key };
      }),
      valueRange: [0, 10],
      percentiles: [],
    },
  };
}

function display(overrides: Record<string, any> = {}) {
  return {
    visible: true,
    opacity: 0.7,
    colormap: "viridis",
    min: 0,
    max: 10,
    thresholdEnabled: false,
    threshold: 5,
    thresholdSide: "above",
    ...overrides,
  };
}

function makeMap() {
  const osmLayers: any[] = [];
  const held: any[] = [];
  const map = {
    node: () => [document.createElement("div")],
    layers: vi.fn(() => [...held]),
    deleteLayer: vi.fn((layer: any) => {
      held.splice(held.indexOf(layer), 1);
    }),
    draw: vi.fn(),
    createLayer: vi.fn((_kind: string, params: Record<string, any>) => {
      // GeoJS's tile factory, create-then-cache: `_getTile` builds a tile,
      // `_getTileCached` adds it to the cache afterwards. Records whether the
      // tile was already cached when a failure hook was attached (attaching
      // one queues the fetch, which GeoJS drops for an uncached tile).
      const cache = new Map<string, any>();
      const layer: any = {
        params,
        _visible: params.visible,
        visible: vi.fn((value?: boolean) => {
          if (value === undefined) {
            return layer._visible;
          }
          layer._visible = value;
          return layer;
        }),
        // GeoJS's url() empties the tile cache.
        url: vi.fn(() => cache.clear()),
        reset: vi.fn(() => cache.clear()),
        cache: { get: (hash: string) => cache.get(hash) ?? null },
        catchAttachedWhileInCache: [] as boolean[],
        failureHandlers: new Map<any, () => void>(),
        _getTile: vi.fn((index: any) => {
          const hash = `${index.level}_${index.y}_${index.x}`;
          const tile: any = {
            toString: () => hash,
            catch: (callback: () => void) => {
              layer.catchAttachedWhileInCache.push(cache.get(hash) === tile);
              layer.failureHandlers.set(tile, callback);
            },
          };
          return tile;
        }),
        _getTileCached: vi.fn((index: any) => {
          const hash = `${index.level}_${index.y}_${index.x}`;
          let tile = cache.get(hash);
          if (!tile) {
            tile = layer._getTile(index);
            cache.set(hash, tile);
          }
          return tile;
        }),
        // Reject a tile's request, as a failed <img> load does.
        failTile: (tile: any) => layer.failureHandlers.get(tile)?.(),
        purge: (tile: any) => cache.delete(tile.toString()),
        opacity: vi.fn(),
        zIndex: vi.fn(),
        node: () => ({ css: vi.fn() }),
      };
      osmLayers.push(layer);
      held.push(layer);
      return layer;
    }),
  };
  return { map, osmLayers, held };
}

const mounted: { unmount: () => void }[] = [];

function mount(parts = makeMap(), disabled = false) {
  const wrapper = shallowMount(ScalarMapOverlay, {
    props: {
      map: parts.map as any,
      annotationLayer: { zIndex: () => 5 } as any,
      sizeX: 4000,
      sizeY: 2000,
      maxLevel: 4,
      disabled,
    },
  });
  mounted.push(wrapper);
  return { wrapper, ...parts };
}

describe("ScalarMapOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.store.xy = 0;
    mocks.store.z = 0;
    mocks.store.time = 0;
    mocks.maps.currentMaps = [scalarMap("a")];
    mocks.maps.display = { a: display() };
    mocks.maps.tileFailedMapIds = [];
    mocks.maps.tileRetryRequests = 0;
  });

  afterEach(() => {
    mounted.splice(0).forEach((wrapper) => wrapper.unmount());
    vi.useRealTimers();
  });

  it("creates one layer per visible map with the shared heat-map setup", () => {
    mocks.maps.currentMaps = [scalarMap("a"), scalarMap("b")];
    mocks.maps.display = { a: display(), b: display({ visible: false }) };
    const { map, osmLayers } = mount();
    expect(map.createLayer).toHaveBeenCalledTimes(1);
    const layer = osmLayers[0];
    expect(layer.params.keepLower).toBe(false);
    expect(layer.params.crossDomain).toBe("use-credentials");
    expect(layer.zIndex).toHaveBeenCalledWith(5);
    expect(layer.opacity).toHaveBeenCalledWith(0.7);
    expect(layer.url).toHaveBeenCalledWith(
      "tiles/a?location=xy0_z0_t0&colormap=viridis&min=0&max=10&threshold=null&side=above&token=share-token&size=256&v=r1",
    );
    expect(layer._visible).toBe(true);
  });

  it("removes a layer when its map is hidden or deleted, and on unmount", async () => {
    mocks.maps.currentMaps = [scalarMap("a"), scalarMap("b")];
    mocks.maps.display = { a: display(), b: display() };
    const { wrapper, map, osmLayers } = mount();
    expect(osmLayers).toHaveLength(2);
    mocks.maps.display.a = display({ visible: false });
    await nextTick();
    expect(map.deleteLayer).toHaveBeenCalledWith(osmLayers[0]);
    mocks.maps.currentMaps = [];
    await nextTick();
    expect(map.deleteLayer).toHaveBeenCalledWith(osmLayers[1]);
    // Showing it again creates a fresh layer.
    mocks.maps.currentMaps = [scalarMap("a")];
    mocks.maps.display = { a: display() };
    await nextTick();
    expect(osmLayers).toHaveLength(3);
    wrapper.unmount();
    mounted.splice(0);
    expect(map.deleteLayer).toHaveBeenCalledWith(osmLayers[2]);
  });

  it("updates the URL of the same layer on range, colormap and threshold changes, debounced", async () => {
    const { map, osmLayers } = mount();
    const layer = osmLayers[0];
    layer.url.mockClear();
    mocks.maps.display.a = display({ min: 2, max: 8, colormap: "magma" });
    await nextTick();
    expect(layer.url).not.toHaveBeenCalled();
    mocks.maps.display.a = display({
      min: 2,
      max: 8,
      colormap: "magma",
      thresholdEnabled: true,
      threshold: 6,
      thresholdSide: "below",
    });
    await nextTick();
    vi.advanceTimersByTime(200);
    expect(layer.url).toHaveBeenCalledTimes(1);
    expect(layer.url).toHaveBeenCalledWith(
      "tiles/a?location=xy0_z0_t0&colormap=magma&min=2&max=8&threshold=6&side=below&token=share-token&size=256&v=r1",
    );
    expect(map.createLayer).toHaveBeenCalledTimes(1);
  });

  it("follows the viewer's location and requests nothing where the map has no data", async () => {
    mocks.maps.currentMaps = [scalarMap("a", ["xy0_z0_t0", "xy0_z1_t0"])];
    const { map, osmLayers } = mount();
    const layer = osmLayers[0];
    layer.url.mockClear();
    mocks.store.z = 1;
    await nextTick();
    expect(layer.url).toHaveBeenCalledWith(
      expect.stringContaining("location=xy0_z1_t0"),
    );
    layer.url.mockClear();
    mocks.store.z = 2;
    await nextTick();
    vi.advanceTimersByTime(200);
    expect(layer._visible).toBe(false);
    expect(layer.url).not.toHaveBeenCalled();
    expect(map.createLayer).toHaveBeenCalledTimes(1);
  });

  it("never creates a layer for a map with no data at the current location", () => {
    mocks.store.xy = 3;
    const { map } = mount();
    vi.advanceTimersByTime(200);
    expect(map.createLayer).not.toHaveBeenCalled();
  });

  it("re-syncs at once when the file's revision or the share-view token changes", async () => {
    const { map, osmLayers } = mount();
    const layer = osmLayers[0];
    layer.url.mockClear();
    mocks.maps.currentMaps = [scalarMap("a", ["xy0_z0_t0"], "r2")];
    await nextTick();
    expect(layer.url).toHaveBeenLastCalledWith(expect.stringContaining("v=r2"));
    mocks.store.shareLinkTileToken = "new-token";
    await nextTick();
    expect(layer.url).toHaveBeenLastCalledWith(
      expect.stringContaining("token=new-token"),
    );
    expect(map.createLayer).toHaveBeenCalledTimes(1);
    mocks.store.shareLinkTileToken = "share-token";
  });

  it("shows a worker re-run's replacement map without user action", async () => {
    const { map, osmLayers } = mount();
    expect(osmLayers).toHaveLength(1);
    // The store re-listed: "a" was replaced by "b", whose display carried
    // over (scalarMaps.test.ts), so "b" is visible from the start.
    mocks.maps.currentMaps = [scalarMap("b")];
    mocks.maps.display = { b: display() };
    await nextTick();
    expect(map.deleteLayer).toHaveBeenCalledWith(osmLayers[0]);
    expect(osmLayers).toHaveLength(2);
    expect(osmLayers[1].url).toHaveBeenCalledWith(
      expect.stringContaining("tiles/b?location=xy0_z0_t0"),
    );
    expect(osmLayers[1]._visible).toBe(true);
  });

  it("hides the layer and requests nothing when a metadata edit removes the current location", async () => {
    mocks.store.z = 1;
    mocks.maps.currentMaps = [scalarMap("a", ["xy0_z0_t0", "xy0_z1_t0"])];
    const { map, osmLayers } = mount();
    const layer = osmLayers[0];
    expect(layer._visible).toBe(true);
    layer.url.mockClear();
    // New revision, and the current location is gone from the metadata.
    mocks.maps.currentMaps = [scalarMap("a", ["xy0_z0_t0"], "r2")];
    await nextTick();
    vi.advanceTimersByTime(200);
    expect(layer._visible).toBe(false);
    expect(layer.url).not.toHaveBeenCalled();
    expect(map.createLayer).toHaveBeenCalledTimes(1);
  });

  it("only restyles on an opacity change", async () => {
    const { map, osmLayers } = mount();
    const layer = osmLayers[0];
    layer.url.mockClear();
    layer.opacity.mockClear();
    mocks.maps.display.a = display({ opacity: 0.3 });
    await nextTick();
    vi.advanceTimersByTime(200);
    expect(layer.opacity).toHaveBeenCalledWith(0.3);
    expect(layer.url).not.toHaveBeenCalled();
    expect(map.createLayer).toHaveBeenCalledTimes(1);
  });

  it("draws nothing while unrolled", () => {
    const { map } = mount(makeMap(), true);
    expect(map.createLayer).not.toHaveBeenCalled();
  });

  it("deletes its layers as soon as it is disabled, and a pending slider update cannot redraw them", async () => {
    const { wrapper, map, osmLayers } = mount();
    expect(osmLayers).toHaveLength(1);
    // A slider change schedules a debounced URL update...
    mocks.maps.display.a = display({ min: 2 });
    await nextTick();
    // ...then a dataset view starts loading (ImageViewer disables us).
    await wrapper.setProps({ disabled: true });
    expect(map.deleteLayer).toHaveBeenCalledWith(osmLayers[0]);
    vi.advanceTimersByTime(200);
    expect(map.createLayer).toHaveBeenCalledTimes(1);
    expect(osmLayers[0].url).not.toHaveBeenCalledWith(
      expect.stringContaining("min=2"),
    );
  });

  it("does not delete layers again from a map that already exited them", () => {
    const parts = makeMap();
    const { wrapper } = mount(parts);
    // ImageViewer replaced the map: it no longer holds the layer.
    parts.held.splice(0);
    wrapper.unmount();
    mounted.splice(0);
    expect(parts.map.deleteLayer).not.toHaveBeenCalled();
  });
  describe("failed tiles", () => {
    const TILE = { x: 0, y: 0, level: 0 };

    it("marks a map whose tile fails to load, and a retry request makes that tile load again", async () => {
      const { map, osmLayers } = mount();
      const layer = osmLayers[0];
      const tile = layer._getTileCached(TILE);
      // Hooked once, and only after GeoJS cached the tile.
      layer._getTileCached(TILE);
      expect(layer.catchAttachedWhileInCache).toEqual([true]);
      layer.failTile(tile);
      expect(mocks.maps.tileFailedMapIds).toEqual(["a"]);

      // The palette's Refresh.
      mocks.maps.tileRetryRequests++;
      await nextTick();
      expect(layer.reset).toHaveBeenCalledTimes(1);
      expect(map.draw).toHaveBeenCalledTimes(1);
      expect(mocks.maps.tileFailedMapIds).toEqual([]);
      // The next draw asks for the tile again: a new request.
      const retried = layer._getTileCached(TILE);
      expect(retried).not.toBe(tile);
      expect(layer._getTile).toHaveBeenCalledTimes(2);
      expect(map.createLayer).toHaveBeenCalledTimes(1);
      // ...and a late failure of the old tile does not mark the map again.
      layer.failTile(tile);
      expect(mocks.maps.tileFailedMapIds).toEqual([]);
      layer.failTile(retried);
      expect(mocks.maps.tileFailedMapIds).toEqual(["a"]);
    });

    it("never marks a map whose tiles load, and a retry request leaves its layer alone", async () => {
      const { map, osmLayers } = mount();
      const layer = osmLayers[0];
      layer._getTileCached(TILE);
      layer._getTileCached({ x: 1, y: 0, level: 0 });
      expect(mocks.maps.tileFailedMapIds).toEqual([]);
      mocks.maps.tileRetryRequests++;
      await nextTick();
      expect(layer.reset).not.toHaveBeenCalled();
      expect(map.draw).not.toHaveBeenCalled();
    });

    it("ignores a failure from a tile the cache no longer holds (a new URL, or a purge)", async () => {
      const { osmLayers } = mount();
      const layer = osmLayers[0];
      // The fetch queue rejects a queued tile a pan purged from the cache.
      const purged = layer._getTileCached(TILE);
      layer.purge(purged);
      layer.failTile(purged);
      expect(mocks.maps.tileFailedMapIds).toEqual([]);
      // A tile of the previous URL that fails after a slider change.
      const old = layer._getTileCached(TILE);
      mocks.maps.display.a = display({ min: 2 });
      await nextTick();
      vi.advanceTimersByTime(200);
      layer.failTile(old);
      expect(mocks.maps.tileFailedMapIds).toEqual([]);
    });

    it("clears the mark with a new URL, and when the map is hidden or the overlay unmounts", async () => {
      const { wrapper, osmLayers } = mount();
      const failOne = (layer: any) =>
        layer.failTile(layer._getTileCached(TILE));
      failOne(osmLayers[0]);
      expect(mocks.maps.tileFailedMapIds).toEqual(["a"]);
      // A new tile URL is a new set of tiles.
      mocks.maps.display.a = display({ colormap: "magma" });
      await nextTick();
      vi.advanceTimersByTime(200);
      expect(mocks.maps.tileFailedMapIds).toEqual([]);
      failOne(osmLayers[0]);
      const pending = osmLayers[0]._getTileCached({ x: 1, y: 0, level: 0 });
      // Hidden: the layer and its failed tiles are deleted; shown again, a
      // fresh layer requests everything.
      mocks.maps.display.a = display({ visible: false, colormap: "magma" });
      await nextTick();
      expect(mocks.maps.tileFailedMapIds).toEqual([]);
      // A request of the deleted layer failing late marks nothing.
      osmLayers[0].failTile(pending);
      expect(mocks.maps.tileFailedMapIds).toEqual([]);
      mocks.maps.display.a = display({ colormap: "magma" });
      await nextTick();
      expect(osmLayers).toHaveLength(2);
      failOne(osmLayers[1]);
      expect(mocks.maps.tileFailedMapIds).toEqual(["a"]);
      wrapper.unmount();
      mounted.splice(0);
      expect(mocks.maps.tileFailedMapIds).toEqual([]);
    });
  });
});
