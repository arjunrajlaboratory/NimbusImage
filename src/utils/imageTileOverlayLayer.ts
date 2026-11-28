import { toRaw } from "vue";
import geojs from "geojs";
import {
  IGeoJSAnnotationLayer,
  IGeoJSFeatureLayer,
  IGeoJSLayer,
  IGeoJSMap,
  IGeoJSOsmLayer,
} from "@/store/model";

/**
 * A semi-transparent server-rendered tile layer cut on the IMAGE's tile
 * pyramid (sizeX/sizeY/maxLevel), drawn under the annotation layer. Shared by
 * the transcript density heat map (TranscriptOverlay.vue) and the scalar map
 * layer (ScalarMapOverlay.vue): both ask their route for tiles addressed
 * exactly like the image's.
 */

// A GeoJS tile layer wants a URL from the start; this is a 1x1 transparent
// PNG, replaced by the real template before the layer is shown.
export const BLANK_TILE_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQIHWNgYAAAAAMAAU9ICq8AAAAASUVORK5CYII=";

export interface IImageTileOverlayOptions {
  map: IGeoJSMap;
  annotationLayer: IGeoJSAnnotationLayer;
  sizeX: number;
  sizeY: number;
  maxLevel: number;
  tileSize: number;
  opacity: number;
}

/** Create the layer hidden, with a blank URL. */
export function createImageTileOverlayLayer(
  options: IImageTileOverlayOptions,
): IGeoJSOsmLayer {
  const { map, sizeX, sizeY, maxLevel, tileSize } = options;
  const params = geojs.util.pixelCoordinateParams(
    map.node()[0],
    sizeX,
    sizeY,
    tileSize,
    tileSize,
  );
  params.layer.maxLevel = maxLevel;
  params.layer.tilesAtZoom = (level: number) => {
    const scale = Math.pow(2, maxLevel - level);
    return {
      x: Math.ceil(sizeX / tileSize / scale),
      y: Math.ceil(sizeY / tileSize / scale),
    };
  };
  // Crop each level to the image, rounding a partial last pixel up as the
  // image layer does (ImageViewer's tile bounds use Math.ceil). Rounding
  // down cropped an edge the server rendered, and an edge smaller than one
  // coarse pixel (210 px at 256x) to nothing, so the overlay vanished there.
  params.layer.tilesMaxBounds = (level: number) => {
    const scale = Math.pow(2, maxLevel - level);
    return {
      x: Math.ceil(sizeX / scale),
      y: Math.ceil(sizeY / scale),
    };
  };
  // Tiles arrive through <img> requests: normal sessions use Girder's auth
  // cookie, while shared views put their isolated bearer on the tile URL.
  params.layer.crossDomain = "use-credentials";
  params.layer.autoshareRenderer = false;
  params.layer.nearestPixel = maxLevel;
  // Semi-transparent overlay: keep only the current level, or every coarser
  // level's tiles stay drawn beneath it (GeoJS's keepLower default).
  params.layer.keepLower = false;
  params.layer.url = BLANK_TILE_URL;
  params.layer.visible = false;
  const layer = registerImageOverlayLayer(
    map,
    map.createLayer("osm", params.layer),
    // Before the viewer's first ordering pass: beneath the annotation
    // outlines, which stay legible over the overlay.
    options.annotationLayer,
  );
  layer.node().css({ "mix-blend-mode": "unset" });
  layer.opacity(options.opacity);
  return layer;
}

// Tiles already given a failure hook (cache hits return the same tile).
const hookedTiles = new WeakSet<object>();

/**
 * Report tile requests that fail and stay failed. GeoJS has no tile-error
 * event: a failed fetch leaves the REJECTED tile in the layer's cache, and
 * later draws reuse it, so the hole stays until the cache is reset. The
 * tile's promise interface is the only signal, and attaching a handler
 * queues the tile's fetch, which the queue drops (rejecting the tile) unless
 * the tile is already the cache's entry: so this wraps `_getTileCached`
 * (which returns only after `cache.add`), never `_getTile`, and hooks each
 * tile once (nimbus-geojs skill, "Tile promise handlers queue the fetch";
 * ImageViewer's annotation overview raster does the same).
 *
 * `onFailure` runs only for a tile still in the layer's cache when it
 * rejects. The fetch queue also rejects a queued tile that a pan or zoom
 * purged from the cache, and that one is simply created again when next
 * needed; and a tile from before a `reset()` or a URL change (both empty the
 * cache) that fails late is no longer what the layer draws.
 *
 * Opt-in per layer (the scalar map layer); the transcript density layer does
 * not use it.
 */
export function hookTileFailures(
  layer: IGeoJSOsmLayer,
  onFailure: () => void,
): void {
  const getTileCached = layer._getTileCached;
  if (typeof getTileCached !== "function") {
    return;
  }
  layer._getTileCached = (...args: unknown[]) => {
    const tile = getTileCached.apply(layer, args);
    if (!hookedTiles.has(tile)) {
      hookedTiles.add(tile);
      tile.catch(() => {
        if (layer.cache?.get(tile.toString(), true) === tile) {
          onFailure();
        }
      });
    }
    return tile;
  };
}

// Layers drawn over the image and under the annotation stack (heat maps,
// transcript points). ImageViewer keeps them there whenever it adds image
// layers; see orderLayersAboveImages.
const imageOverlayLayers = new WeakSet<object>();
// Each viewer map's annotation stack, as ImageViewer last ordered it, so an
// overlay created between viewer draws is placed by the same rule at once.
const viewerStacks = new WeakMap<object, (IGeoJSLayer | null | undefined)[]>();

/**
 * Mark a layer as an overlay that must stay above every image layer, and
 * place it there now: below the whole annotation stack (overview raster,
 * worker preview, outlines, ...), exactly where ImageViewer's next draw would
 * put it. Creating it at the annotation layer's index instead left a new
 * overlay above the overview raster until the next draw, tinting the cells.
 * Before the viewer has ordered this map once, it goes just under
 * `fallbackBelow` (the annotation layer).
 */
export function registerImageOverlayLayer<T extends IGeoJSLayer>(
  map: IGeoJSMap,
  layer: T,
  fallbackBelow?: IGeoJSLayer,
): T {
  imageOverlayLayers.add(layer);
  const stack = viewerStacks.get(toRaw(map));
  if (stack) {
    orderLayers(map, stack);
  } else if (fallbackBelow) {
    layer.zIndex(fallbackBelow.zIndex() as number);
  }
  return layer;
}

export function isImageOverlayLayer(layer: object): boolean {
  return imageOverlayLayers.has(layer);
}

const byZ = (a: IGeoJSLayer, b: IGeoJSLayer) =>
  (a.zIndex() as number) - (b.zIndex() as number);

function orderLayers(
  map: IGeoJSMap,
  stack: (IGeoJSLayer | null | undefined)[],
): void {
  const layers = map.layers();
  const overlays = layers.filter(isImageOverlayLayer).sort(byZ);
  const expected = [
    ...overlays,
    ...stack.filter(
      (layer): layer is IGeoJSLayer => !!layer && layers.includes(layer),
    ),
  ];
  // Relative order, not absolute indices: GeoJS's deleteLayer leaves a gap in
  // the z-indices that moveToTop (which only rotates existing values) never
  // closes, so after any overlay was deleted an index comparison failed on
  // every draw and re-raised every layer for the life of the viewer.
  const top = [...layers].sort(byZ).slice(layers.length - expected.length);
  if (top.every((layer, index) => layer === expected[index])) {
    return;
  }
  expected.forEach((layer) => layer.moveToTop());
}

/**
 * Order a viewer map's layers: the image layers (and anything else not
 * named) at the bottom, then every registered overlay in its current order,
 * then `stack` (the annotation-related layers, bottom to top). Also records
 * the stack, so registerImageOverlayLayer can place a new overlay the same
 * way without waiting for a draw.
 *
 * GeoJS gives a new layer the top z-index, so the image layers that
 * `_setupTileLayers` adds for a new display layer land above everything.
 * Raising only the annotation stack afterwards left the overlays beneath the
 * new image layers, hidden in the Normal blend. Raising the overlays first,
 * then the stack, restores the intended order. Nothing moves when the top of
 * the map is already exactly overlays then stack.
 */
export function orderLayersAboveImages(
  map: IGeoJSMap,
  stack: (IGeoJSLayer | null | undefined)[],
): void {
  viewerStacks.set(toRaw(map), stack);
  orderLayers(map, stack);
}

/**
 * Stack some overlays among themselves, bottom to top as given, by handing
 * them the z-indices they already hold, sorted ascending. Their slots stay
 * where they were relative to every other layer (other overlays such as the
 * transcript layers, the image layers and the annotation stack), so
 * orderLayersAboveImages, which keeps overlays in their current relative
 * order, keeps this order too. Each set passes `allowDuplicate`: without it
 * GeoJS shifts a sibling that holds the value up, moving layers outside this
 * group. Sets nothing when the order is already right (steady-state draws
 * move no layers) or there are fewer than two layers.
 */
export function orderOverlayLayersAmongThemselves(
  layersBottomToTop: IGeoJSLayer[],
): void {
  if (layersBottomToTop.length < 2) {
    return;
  }
  const slots = layersBottomToTop
    .map((layer) => layer.zIndex() as number)
    .sort((a, b) => a - b);
  layersBottomToTop.forEach((layer, index) => {
    if (layer.zIndex() !== slots[index]) {
      layer.zIndex(slots[index], true);
    }
  });
}

/**
 * Delete a layer only while the map still holds it: when ImageViewer
 * replaces the map (an unroll toggle), the old map has already exited its
 * layers, and GeoJS's deleteLayer would exit them a second time.
 */
export function deleteLayerIfHeld(
  map: IGeoJSMap,
  layer: IGeoJSFeatureLayer | IGeoJSOsmLayer,
) {
  if (map.layers().includes(layer)) {
    map.deleteLayer(layer);
  }
}
