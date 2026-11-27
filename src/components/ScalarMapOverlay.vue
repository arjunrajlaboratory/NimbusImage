<template>
  <!-- Renderless: draws into the GeoJS map it is given. -->
  <span class="scalar-map-overlay" hidden />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { debounce } from "lodash";
import store from "@/store";
import scalarMapsStore from "@/store/scalarMaps";
import {
  IGeoJSAnnotationLayer,
  IGeoJSMap,
  IGeoJSOsmLayer,
  IScalarMap,
} from "@/store/model";
import {
  createImageTileOverlayLayer,
  deleteLayerIfHeld,
  hookTileFailures,
} from "@/utils/imageTileOverlayLayer";
import { scalarMapLocationKey } from "@/utils/scalarMap";

/**
 * The scalar map layer (HOTSPOT_REGIONS_WORKER.md §8.3): one server-rendered
 * heat-map tile layer per visible saved map, on the image's tile pyramid and
 * under the annotation layer (the same layer setup as the transcript density
 * heat map). It follows the viewer's XY/Z/Time through the map's `location`
 * key; a map with no array for the current location shows nothing and
 * requests nothing.
 *
 * Opacity is a restyle. Range, colormap, threshold and location change the
 * tile URL of the existing layer; slider-driven URL changes are debounced.
 *
 * A tile that fails to load stays failed in GeoJS's cache, so the map is
 * marked in the store (`tileFailedMapIds`, shown on its palette card) and
 * the palette's Refresh (`requestScalarMapTileRetry`) resets the cache of
 * every marked layer, which requests those tiles again. Hiding and showing
 * the map does too: hiding deletes the layer.
 */

const props = defineProps<{
  map: IGeoJSMap;
  annotationLayer: IGeoJSAnnotationLayer;
  sizeX: number;
  sizeY: number;
  maxLevel: number;
  // Unrolled views place frames on a grid the map knows nothing about; a
  // loading dataset view pairs the incoming location with the outgoing
  // dataset (and its listed maps). ImageViewer sets this in both cases.
  disabled: boolean;
}>();

const TILE_SIZE = 256;
const URL_DEBOUNCE_MS = 150;

const layers = new Map<string, { layer: IGeoJSOsmLayer; url: string }>();

function clearTilesFailed(itemId: string) {
  if (scalarMapsStore.tileFailedMapIds.includes(itemId)) {
    scalarMapsStore.setScalarMapTilesFailed({ itemId, failed: false });
  }
}

/** The tile URL a map should show now, or null to show nothing. */
function desiredUrl(map: IScalarMap): string | null {
  const display = scalarMapsStore.display[map.itemId];
  if (props.disabled || !display?.visible) {
    return null;
  }
  const location = scalarMapLocationKey(
    map.meta,
    store.xy,
    store.z,
    store.time,
  );
  if (location === null) {
    return null;
  }
  return store.scalarMapAPI.tileTemplateUrl({
    itemId: map.itemId,
    location,
    sizeX: props.sizeX,
    sizeY: props.sizeY,
    tileSize: TILE_SIZE,
    maxLevel: props.maxLevel,
    colormap: display.colormap,
    min: display.min,
    max: display.max,
    threshold: display.thresholdEnabled ? display.threshold : null,
    thresholdSide: display.thresholdSide,
    authToken: store.shareLinkTileToken,
    version: map.revision,
  });
}

function dropLayer(itemId: string) {
  const entry = layers.get(itemId);
  if (entry) {
    deleteLayerIfHeld(props.map, entry.layer);
    layers.delete(itemId);
  }
  // Its failed tiles went with the layer; a new layer requests them again.
  clearTilesFailed(itemId);
}

function dropAllLayers() {
  [...layers.keys()].forEach(dropLayer);
}

/**
 * Bring the layers in line with the store. Idempotent: an immediate call
 * and a later debounced one leave the same result.
 */
function sync() {
  const maps = scalarMapsStore.currentMaps;
  const listed = new Set(maps.map((map) => map.itemId));
  for (const map of maps) {
    const display = scalarMapsStore.display[map.itemId];
    if (!display?.visible || props.disabled) {
      // Hidden by the user, or disabled (unrolled, or a dataset view
      // loading): free the canvas and tile cache.
      dropLayer(map.itemId);
      continue;
    }
    const url = desiredUrl(map);
    let entry = layers.get(map.itemId);
    if (url === null) {
      // No array for this location: hide, keeping the layer for the next
      // location that has one. A hidden layer requests nothing.
      if (entry?.layer.visible()) {
        entry.layer.visible(false);
      }
      continue;
    }
    if (!entry) {
      const created = {
        layer: createImageTileOverlayLayer({
          map: props.map,
          annotationLayer: props.annotationLayer,
          sizeX: props.sizeX,
          sizeY: props.sizeY,
          maxLevel: props.maxLevel,
          tileSize: TILE_SIZE,
          opacity: display.opacity,
        }),
        url: "",
      };
      const itemId = map.itemId;
      // Only a tile the layer's cache still holds reports (the helper checks;
      // a reset or a new URL empties the cache), and only while this layer
      // is the map's: a deleted layer's cache still holds its tiles.
      hookTileFailures(created.layer, () => {
        if (layers.get(itemId) === created) {
          scalarMapsStore.setScalarMapTilesFailed({ itemId, failed: true });
        }
      });
      entry = created;
      layers.set(itemId, entry);
    }
    if (entry.url !== url) {
      // GeoJS empties the tile cache on a URL change: a new set of tiles.
      entry.url = url;
      clearTilesFailed(map.itemId);
      entry.layer.url(url);
    }
    if (!entry.layer.visible()) {
      entry.layer.visible(true);
    }
  }
  // Deleted maps, and every map of a previous dataset.
  [...layers.keys()].filter((itemId) => !listed.has(itemId)).forEach(dropLayer);
}

const scheduleSync = debounce(sync, URL_DEBOUNCE_MS);

// Which layers exist and whether they show: immediate. Includes the
// location, since a location without data hides the layer, and everything
// else that is not a slider: the file's revision and the share-view token.
const structureSignature = computed(() =>
  JSON.stringify([
    props.disabled,
    store.xy,
    store.z,
    store.time,
    store.shareLinkTileToken,
    scalarMapsStore.currentMaps.map((map) => [
      map.itemId,
      map.revision,
      scalarMapsStore.display[map.itemId]?.visible ?? false,
    ]),
  ]),
);

// What only changes the tile URL of a shown layer: slider-driven, so
// debounced. Opacity is deliberately absent (a restyle, below).
const urlSignature = computed(() =>
  JSON.stringify(
    scalarMapsStore.currentMaps.map((map) => {
      const display = scalarMapsStore.display[map.itemId];
      return display
        ? [
            map.itemId,
            display.colormap,
            display.min,
            display.max,
            display.thresholdEnabled,
            display.threshold,
            display.thresholdSide,
          ]
        : [map.itemId];
    }),
  ),
);

const opacitySignature = computed(() =>
  JSON.stringify(
    scalarMapsStore.currentMaps.map((map) => [
      map.itemId,
      scalarMapsStore.display[map.itemId]?.opacity ?? null,
    ]),
  ),
);

watch(structureSignature, () => {
  // A pending debounced sync would only repeat this one.
  scheduleSync.cancel();
  sync();
});

watch(urlSignature, () => scheduleSync());

// The palette's Refresh: empty the tile cache of every layer with a failed
// tile, so the next draw requests those tiles again (GeoJS never retries a
// rejected tile it holds). reset() drops the drawn tiles too, and only a map
// draw reaches the layer's fetch (_update), as in ImageViewer's overview
// raster retry.
watch(
  () => scalarMapsStore.tileRetryRequests,
  () => {
    let reset = false;
    layers.forEach((entry, itemId) => {
      if (scalarMapsStore.tileFailedMapIds.includes(itemId)) {
        clearTilesFailed(itemId);
        entry.layer.reset();
        reset = true;
      }
    });
    if (reset) {
      props.map.draw();
    }
  },
);

watch(opacitySignature, () => {
  layers.forEach(({ layer }, itemId) => {
    const opacity = scalarMapsStore.display[itemId]?.opacity;
    if (opacity !== undefined) {
      layer.opacity(opacity);
    }
  });
});

// The pyramid is sized to the image; a new image needs new layers.
watch(
  () => [props.sizeX, props.sizeY, props.maxLevel],
  () => {
    scheduleSync.cancel();
    dropAllLayers();
    sync();
  },
);

sync();

onBeforeUnmount(() => {
  scheduleSync.cancel();
  dropAllLayers();
});

defineExpose({ sync });
</script>
