import geojs from "geojs";
import {
  IGeoJSAnnotationLayer,
  IGeoJSFeatureLayer,
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
  params.layer.tilesMaxBounds = (level: number) => {
    const scale = Math.pow(2, maxLevel - level);
    return {
      x: Math.floor(sizeX / scale),
      y: Math.floor(sizeY / scale),
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
  const layer = map.createLayer("osm", params.layer);
  // Beneath the annotation outlines, which stay legible over the overlay.
  layer.zIndex(options.annotationLayer.zIndex() as number);
  layer.node().css({ "mix-blend-mode": "unset" });
  layer.opacity(options.opacity);
  return layer;
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
