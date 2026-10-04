<template>
  <div class="montage-view">
    <!-- Same header as FloatingPalette, so the montage reads as one of the
         panels rather than a hole cut in the canvas. -->
    <header class="montage-header">
      <span class="montage-grip" aria-hidden="true">
        <i></i><i></i><i></i>
      </span>
      <h4 class="montage-title">Montage</h4>
      <span class="montage-count">{{ countLabel }}</span>
      <button
        type="button"
        class="montage-close"
        aria-label="Close montage"
        title="Back to the image view"
        @click="montageStore.setIsOpen(false)"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </header>
    <div class="montage-toolbar">
      <div class="montage-control montage-size">
        <span class="text-caption">Size</span>
        <!-- Applied when the drag ends: every tick would otherwise resize
             and redraw every panel and rewrite the saved settings. -->
        <v-slider
          v-model="panelSizeDraft"
          :min="80"
          :max="320"
          :step="20"
          density="compact"
          hide-details
          @end="setPanelSize"
        />
      </div>
      <v-text-field
        :model-value="settings.padding"
        type="number"
        label="Padding (px)"
        min="0"
        density="compact"
        variant="outlined"
        hide-details
        class="montage-control montage-padding"
        @update:model-value="setPadding"
      />
      <v-btn-toggle
        :model-value="settings.scaleMode"
        density="compact"
        variant="outlined"
        divided
        mandatory
        class="montage-control"
        @update:model-value="setScaleMode"
      >
        <v-btn value="uniform" size="small">Same scale</v-btn>
        <v-btn value="fit" size="small">Fit each</v-btn>
      </v-btn-toggle>
      <v-checkbox
        :model-value="settings.showOutlines"
        label="Outlines"
        density="compact"
        hide-details
        class="montage-control"
        @update:model-value="(v) => update({ showOutlines: !!v })"
      />
      <v-checkbox
        :model-value="settings.showIndex"
        label="Number"
        density="compact"
        hide-details
        class="montage-control"
        @update:model-value="(v) => update({ showIndex: !!v })"
      />
      <v-select
        :model-value="selectedLabelKeys"
        :items="propertyOptions"
        label="Show properties"
        multiple
        density="compact"
        variant="outlined"
        hide-details
        class="montage-control montage-properties"
        @update:model-value="setLabelKeys"
      >
        <template v-slot:selection="{ index }">
          <span v-if="index === 0" class="text-body-2">
            {{ selectedLabelKeys.length }} selected
          </span>
        </template>
      </v-select>
      <v-spacer />
      <v-btn
        variant="outlined"
        color="primary"
        size="small"
        class="montage-control"
        :loading="isExporting"
        :disabled="!canExport"
        @click="exportPng"
      >
        <v-icon start>mdi-download</v-icon>
        Export PNG
      </v-btn>
      <span v-if="exportError" class="text-caption text-error">
        {{ exportError }}
      </span>
    </div>
    <div v-if="panels.length === 0" class="montage-empty text-body-2">
      No objects on the current Object Browser page. The montage shows the
      objects listed there, with the same filters, sorting and paging.
    </div>
    <div
      v-else
      ref="gridEl"
      class="montage-grid"
      :style="{
        gridTemplateColumns: `repeat(auto-fill, ${settings.panelSize}px)`,
        gap: `${GAP}px`,
      }"
    >
      <montage-panel
        v-for="panel in panels"
        :key="panel.id"
        :content="panel.content"
        :crop-key="cropKeyFor(panel.id)"
        :load-crop="loadCrop"
        :size="settings.panelSize"
        :pixel-ratio="pixelRatio"
        :loader="loader"
        :selected="annotationStore.isAnnotationSelected(panel.id)"
        :hovered="annotationStore.hoveredAnnotationId === panel.id"
        @toggle-select="annotationStore.toggleSelected([panel.id])"
        @navigate="navigateTo(panel.id)"
        @hover="(entered) => onHover(panel.id, entered)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, computed, watch, onBeforeUnmount } from "vue";
import { debounce } from "lodash";
import store from "@/store";
import annotationStore from "@/store/annotation";
import annotationListServer from "@/store/annotationListServer";
import propertyStore from "@/store/properties";
import montageStore, {
  IMontageSettings,
  TMontageScaleMode,
} from "@/store/montage";
import {
  AnnotationShape,
  IAnnotation,
  IDataset,
  IDisplayLayer,
  IAnnotationPropertyValues,
  TAnnotationOrStub,
  isHydratedAnnotation,
} from "@/store/model";
import MontagePanel from "@/components/Montage/MontagePanel.vue";
import {
  IImageRect,
  IMontageCrop,
  IMontageOutline,
  IMontagePanelContent,
  MontageCropError,
  StaleCropError,
  annotationImageBounds,
  clipToImage,
  drawMontagePanel,
  montageExportColumns,
  montageGrid,
  montageWindows,
  regionOutputSize,
} from "@/utils/montage";
import pLimit from "p-limit";
import {
  IMontageImageRequest,
  MontageImageLoader,
} from "@/utils/montageImageLoader";
import {
  LayerSelectionError,
  getBaseURLFromDownloadParameters,
  getLayersDownloadUrls,
} from "@/utils/screenshot";
import { getStringFromPropertiesAndPath } from "@/utils/paths";
import { goToAnnotationLocation } from "@/utils/annotationNavigation";
import { downloadToClient } from "@/utils/download";
import { logError } from "@/utils/log";

const GAP = 6;
const EXPORT_BACKGROUND = "#202020";

const gridEl = ref<HTMLElement | null>(null);
const isExporting = ref(false);
// Set on unmount so an export in flight stops building/fetching and never
// downloads a montage the user already closed.
let isUnmounted = false;
const exportError = ref<string | null>(null);
// Crops are requested at screen density (capped) so export can reuse them.
const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));

const loader = new MontageImageLoader((url, signal) =>
  store.api.getSnapshotImage(url, signal),
);

const settings = computed(() => montageStore.settings);
const pageItems = computed(() => montageStore.listPageItems);
const pageIds = computed(() => pageItems.value.map(({ id }) => id));
const dataset = computed(() => store.dataset);

function update(changes: Partial<IMontageSettings>) {
  montageStore.updateSettings(changes);
}

const panelSizeDraft = ref(settings.value.panelSize);
watch(
  () => settings.value.panelSize,
  (value) => {
    panelSizeDraft.value = value;
  },
);

function setPanelSize(value: number) {
  update({ panelSize: value });
}

function setPadding(value: string | number) {
  // An emptied field is mid-edit, not a request for zero padding.
  if (value === "") {
    return;
  }
  const padding = Number(value);
  if (Number.isFinite(padding) && padding >= 0) {
    update({ padding });
  }
}

function setScaleMode(value: TMontageScaleMode) {
  update({ scaleMode: value });
}

// --- Property labels -------------------------------------------------------
const pathKey = (path: string[]) => JSON.stringify(path);

const propertyOptions = computed(() =>
  propertyStore.computedPropertyPaths.map((path) => ({
    title: propertyStore.getFullNameFromPath(path) ?? path.join(" / "),
    value: pathKey(path),
  })),
);

// The chosen paths are a global preference, but property ids belong to one
// configuration: only those this dataset's configuration has are shown.
const labelPaths = computed(() =>
  settings.value.labelPropertyPaths.filter(
    ([propertyId]) => propertyStore.getPropertyById(propertyId) !== null,
  ),
);

const selectedLabelKeys = computed(() => labelPaths.value.map(pathKey));

// Keeps the paths chosen under other configurations (hidden here by
// labelPaths) so picking labels in one doesn't erase another's.
function setLabelKeys(keys: string[]) {
  const otherConfigurations = settings.value.labelPropertyPaths.filter(
    ([propertyId]) => propertyStore.getPropertyById(propertyId) === null,
  );
  update({
    labelPropertyPaths: [
      ...otherConfigurations,
      ...keys.map((key) => JSON.parse(key)),
    ],
  });
}

// Values are fetched for exactly the page's objects and the chosen paths: the
// store's propertyValues map is projected to the list's displayed columns, so
// it may not hold an arbitrary label path.
const labelValues = shallowRef(
  new Map<string, IAnnotationPropertyValues[string]>(),
);
let labelSequence = 0;

async function refreshLabels() {
  const sequence = ++labelSequence;
  const datasetId = dataset.value?.id;
  const paths = labelPaths.value;
  if (!datasetId || paths.length === 0 || pageIds.value.length === 0) {
    labelValues.value = new Map();
    return;
  }
  try {
    const entries = await propertyStore.propertiesAPI.getPropertyValuesForIds(
      datasetId,
      pageIds.value,
      paths,
    );
    if (sequence !== labelSequence) {
      return;
    }
    labelValues.value = new Map(
      entries.map(({ annotationId, values }) => [annotationId, values]),
    );
  } catch (error) {
    // Keep the labels already shown; a blip shouldn't blank them.
    if (sequence === labelSequence) {
      logError("Failed to load montage property labels", error);
    }
  }
}

watch(
  () => JSON.stringify([dataset.value?.id, pageIds.value, labelPaths.value]),
  refreshLabels,
  { immediate: true },
);

// The montage's own copy of the values goes stale when values are computed or
// imported; propertyValuesRevision is bumped exactly then (not on the viewport
// merges that replace propertyValues in lazy mode). Debounced: a compute can
// land values in several batches.
const debouncedLabelRefresh = debounce(refreshLabels, 300);
watch(
  () => propertyStore.propertyValuesRevision,
  () => debouncedLabelRefresh(),
);

// --- Geometry --------------------------------------------------------------
// Non-point stubs carry no outline; hydrate the page's in one batch request.
const fetchedAnnotations = shallowRef(new Map<string, IAnnotation>());
const isHydrating = ref(false);
let hydrationSequence = 0;
let hydrationController: AbortController | null = null;

const serverRowsById = computed(
  () => new Map(annotationListServer.rows.map((row) => [row.id, row])),
);

function storeAnnotation(id: string): TAnnotationOrStub | undefined {
  return (
    annotationStore.getAnnotationOrStubFromId(id) ??
    serverRowsById.value.get(id)
  );
}

// The store's own (fresh) full annotation first, then one hydrated here, then
// the stub.
// the stub. A hydrated copy only contributes geometry: color and tags come
// from the store's stub, which stays current when the object is recolored or
// retagged (e.g. from the Object Browser) while the montage is open.
function resolveAnnotation(id: string): TAnnotationOrStub | undefined {
  const fromStore = storeAnnotation(id);
  if (fromStore && isHydratedAnnotation(fromStore)) {
    return fromStore;
  }
  const fetched = fetchedAnnotations.value.get(id);
  if (fetched && fromStore) {
    return { ...fetched, color: fromStore.color, tags: fromStore.tags };
  }
  return fetched ?? fromStore;
}

watch(
  () => pageIds.value.join(","),
  async () => {
    const sequence = ++hydrationSequence;
    hydrationController?.abort();
    hydrationController = null;
    const ids = pageIds.value;
    const kept = new Map(
      ids
        .filter((id) => fetchedAnnotations.value.has(id))
        .map((id) => [id, fetchedAnnotations.value.get(id)!]),
    );
    fetchedAnnotations.value = kept;
    const needed = ids.filter((id) => {
      if (kept.has(id)) return false;
      const annotation = storeAnnotation(id);
      return (
        annotation !== undefined &&
        !isHydratedAnnotation(annotation) &&
        annotation.shape !== AnnotationShape.Point
      );
    });
    if (needed.length === 0) {
      isHydrating.value = false;
      return;
    }
    isHydrating.value = true;
    const controller = new AbortController();
    hydrationController = controller;
    try {
      const annotations =
        await annotationStore.annotationsAPI.hydrateAnnotations(
          needed,
          controller.signal,
        );
      if (sequence !== hydrationSequence) {
        return;
      }
      const next = new Map(fetchedAnnotations.value);
      annotations.forEach((annotation) => next.set(annotation.id, annotation));
      fetchedAnnotations.value = next;
    } catch (error) {
      if (sequence === hydrationSequence && !controller.signal.aborted) {
        logError("Failed to load montage object outlines", error);
      }
    } finally {
      if (sequence === hydrationSequence) {
        isHydrating.value = false;
      }
    }
  },
  { immediate: true },
);

function outlineOf(annotation: TAnnotationOrStub): IMontageOutline | null {
  if (isHydratedAnnotation(annotation)) {
    return { shape: annotation.shape, coordinates: annotation.coordinates };
  }
  if (annotation.shape === AnnotationShape.Point) {
    return { shape: annotation.shape, coordinates: [annotation.centroid] };
  }
  return null;
}

function colorOf(annotation: TAnnotationOrStub): string {
  return (
    annotation.color ??
    store.layers.find((layer) => layer.channel === annotation.channel)?.color ??
    "#ffffff"
  );
}

interface IMontagePanel {
  id: string;
  annotation: TAnnotationOrStub;
  content: Omit<IMontagePanelContent, "image">;
}

const panels = computed((): IMontagePanel[] => {
  const resolved = pageItems.value.flatMap((item) => {
    const annotation = resolveAnnotation(item.id);
    return annotation ? [{ item, annotation }] : [];
  });
  const windows = montageWindows(
    resolved.map(({ annotation }) => annotationImageBounds(annotation)),
    settings.value.padding,
    settings.value.scaleMode,
  );
  const { showOutlines, showIndex } = settings.value;
  return resolved.map(({ item, annotation }, i) => {
    const values = labelValues.value.get(item.id) ?? {};
    return {
      id: item.id,
      annotation,
      content: {
        window: windows[i],
        imageRect: dataset.value
          ? clipToImage(windows[i], dataset.value.width, dataset.value.height)
          : null,
        outline: showOutlines ? outlineOf(annotation) : null,
        color: colorOf(annotation),
        indexLabel: showIndex ? `#${item.index}` : null,
        // Short (leaf) names: a panel is narrow, and the value matters more.
        textLines: labelPaths.value.map(
          (path) =>
            `${propertyStore.getSubIdsNameFromPath(path) ?? path.at(-1)}: ${
              getStringFromPropertiesAndPath(values, path) ?? "-"
            }`,
        ),
      },
    };
  });
});

const countLabel = computed(() => {
  const count = panels.value.length;
  return `${count.toLocaleString()} object${count === 1 ? "" : "s"} · list page`;
});

// --- Crops ---------------------------------------------------------------
// A crop is built (style per layer, which may need a contrast histogram for
// the object's own frame) only when its panel asks: panels ask once visible,
// so a page of 200 objects over many frames does not fetch every frame's
// histograms up front. Builds share a small pool for the same reason.
//
// Inputs settle 250ms after the last change (contrast drags, padding typing),
// then get a new generation; a crop key is "generation:id". While inputs are
// settling every key is null and panels keep showing their current crop.
// Everything a build reads, snapshotted when the generation settles: a build
// that runs later (queued, or for an export) must render the same state as
// the rest of its generation, not whatever the layers are by then.
interface ICropInput {
  annotation: TAnnotationOrStub;
  window: IImageRect;
  imageRect: IImageRect | null;
  panelSize: number;
  dataset: IDataset;
  layers: IDisplayLayer[];
}

const settledCrops = shallowRef({
  generation: 0,
  inputs: new Map<string, ICropInput>(),
});
// True from any input change until the next generation is settled, so the
// export never draws a page whose crops don't match it.
const cropsPending = ref(true);
const cropBuilds = new Map<string, Promise<IMontageCrop>>();
const limitCropBuilds = pLimit(4);

function settleCrops() {
  // Hydration changes the windows; the watcher re-fires when it ends.
  const currentDataset = dataset.value;
  if (!currentDataset || isHydrating.value) {
    return;
  }
  const layers = store.layers;
  cropBuilds.clear();
  settledCrops.value = {
    generation: settledCrops.value.generation + 1,
    inputs: new Map(
      panels.value.map(({ id, annotation, content }) => [
        id,
        {
          annotation,
          window: content.window,
          imageRect: content.imageRect,
          panelSize: settings.value.panelSize,
          dataset: currentDataset,
          layers,
        },
      ]),
    ),
  };
  cropsPending.value = false;
}

const debouncedSettleCrops = debounce(settleCrops, 250);

watch(
  () =>
    JSON.stringify([
      dataset.value?.id,
      isHydrating.value,
      settings.value.panelSize,
      store.layers,
      panels.value.map(({ id, annotation, content }) => [
        id,
        annotation.location,
        content.window,
      ]),
    ]),
  () => {
    cropsPending.value = true;
    debouncedSettleCrops();
  },
  { immediate: true },
);

function cropKeyFor(id: string): string | null {
  const { generation, inputs } = settledCrops.value;
  return !cropsPending.value && inputs.has(id) ? `${generation}:${id}` : null;
}

async function buildPanelCrop(input: ICropInput): Promise<IMontageCrop> {
  // Queued builds outlive the view; don't render for one that's gone.
  if (isUnmounted) {
    throw new StaleCropError();
  }
  const { annotation, window, imageRect, panelSize } = input;
  if (!imageRect) {
    throw new MontageCropError("Object is outside the image");
  }
  const { dataset: currentDataset, layers } = input;
  const anyImage = currentDataset.anyImage();
  if (!anyImage) {
    throw new MontageCropError("Dataset has no images");
  }
  const scale = (panelSize * pixelRatio) / (window.right - window.left);
  const baseUrl = getBaseURLFromDownloadParameters(
    {
      ...imageRect,
      ...regionOutputSize(imageRect, scale),
      encoding: "JPEG",
      jpegQuality: 90,
      contentDisposition: "inline",
    },
    anyImage.item._id,
    store.girderRest.apiRoot,
  );
  const { XY, Z, Time } = annotation.location;
  try {
    const [{ url }] = await getLayersDownloadUrls(
      baseUrl,
      "composite",
      layers,
      currentDataset,
      { xy: XY, z: Z, time: Time },
      store.api,
    );
    return { url, imageRect };
  } catch (error) {
    // No visible layer, or no plane at this object's frame: expected per
    // object. Anything else (a histogram fetch) is a real failure.
    if (error instanceof LayerSelectionError) {
      throw new MontageCropError(error.message);
    }
    throw error;
  }
}

function loadCrop(key: string): Promise<IMontageCrop> {
  const separator = key.indexOf(":");
  const generation = Number(key.slice(0, separator));
  const input = settledCrops.value.inputs.get(key.slice(separator + 1));
  if (generation !== settledCrops.value.generation || !input) {
    return Promise.reject(new StaleCropError());
  }
  let build = cropBuilds.get(key);
  if (!build) {
    // Re-checked when the build actually starts: it may have queued behind
    // others while the page or settings moved on.
    build = limitCropBuilds(() =>
      generation === settledCrops.value.generation
        ? buildPanelCrop(input)
        : Promise.reject(new StaleCropError()),
    );
    // A failed build is retried on the next request rather than cached.
    build.catch(() => cropBuilds.delete(key));
    cropBuilds.set(key, build);
  }
  return build;
}

const canExport = computed(
  () =>
    !isExporting.value &&
    !isHydrating.value &&
    !cropsPending.value &&
    panels.value.length > 0,
);

// --- Interaction -----------------------------------------------------------
function onHover(id: string, entered: boolean) {
  if (entered) {
    annotationStore.setHoveredAnnotationId(id);
  } else if (annotationStore.hoveredAnnotationId === id) {
    annotationStore.setHoveredAnnotationId(null);
  }
}

function navigateTo(id: string) {
  montageStore.setIsOpen(false);
  goToAnnotationLocation(id);
}

// --- Export ----------------------------------------------------------------
function exportColumns(count: number): number {
  // Grid content width (clientWidth includes its 12px side padding).
  return montageExportColumns(
    (gridEl.value?.clientWidth ?? 0) - 24,
    settings.value.panelSize,
    GAP,
    count,
  );
}

// Safari's canvas area limit (the strictest supported browser), with margin.
const MAX_EXPORT_PIXELS = 16_000_000;

// The crop for an export: the panel's (cached) one, or — if settings moved
// on mid-export and its build went stale — one built from the inputs the
// export captured, so queued panels don't come out blank.
async function exportCrop(
  key: string,
  input: ICropInput,
): Promise<IMontageCrop> {
  try {
    return await loadCrop(key);
  } catch (error) {
    if (error instanceof StaleCropError) {
      return limitCropBuilds(() => buildPanelCrop(input));
    }
    throw error;
  }
}

async function exportPng() {
  // Capture everything the export depends on before the first await.
  const exported = panels.value.flatMap((panel) => {
    const cropKey = cropKeyFor(panel.id);
    const input = settledCrops.value.inputs.get(panel.id);
    return cropKey && input ? [{ content: panel.content, cropKey, input }] : [];
  });
  const columns = exportColumns(exported.length);
  const fullSize = Math.round(settings.value.panelSize * pixelRatio);
  const fullGap = Math.round(GAP * pixelRatio);
  const full = montageGrid(exported.length, columns, fullSize, fullGap);
  // Shrink the whole image, if needed, to fit the canvas area limit.
  const shrink = Math.min(
    1,
    Math.sqrt(MAX_EXPORT_PIXELS / (full.width * full.height)),
  );
  const size = Math.floor(fullSize * shrink);
  const gap = Math.max(1, Math.round(fullGap * shrink));
  const grid = montageGrid(exported.length, columns, size, gap);
  const datasetName = dataset.value?.name ?? "dataset";
  isExporting.value = true;
  exportError.value = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = grid.width;
    canvas.height = grid.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas is unavailable.");
    }
    ctx.fillStyle = EXPORT_BACKGROUND;
    ctx.fillRect(0, 0, grid.width, grid.height);
    let failed = 0;
    // Draw each panel as its crop arrives and let the crop go at once, so
    // the export never holds every decoded crop of the page together.
    await Promise.all(
      exported.map(async ({ content, cropKey, input }, i) => {
        let image: ImageBitmap | null = null;
        let imageRect: IImageRect | null = null;
        let request: IMontageImageRequest | null = null;
        try {
          if (isUnmounted) return;
          const crop = await exportCrop(cropKey, input);
          if (isUnmounted) return;
          request = loader.load(crop.url);
          image = await request.promise;
          imageRect = crop.imageRect;
        } catch (error) {
          if (!(error instanceof MontageCropError)) {
            failed++;
          }
        }
        drawMontagePanel(
          ctx,
          (i % grid.columns) * (size + gap),
          Math.floor(i / grid.columns) * (size + gap),
          size,
          { ...content, image, imageRect },
          pixelRatio * shrink,
        );
        request?.release();
      }),
    );
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) {
      throw new Error("Could not encode the montage image.");
    }
    if (isUnmounted) {
      return;
    }
    const href = URL.createObjectURL(blob);
    downloadToClient({ href, download: `${datasetName} - montage.png` });
    setTimeout(() => URL.revokeObjectURL(href), 0);
    if (failed > 0) {
      exportError.value = `${failed} crop${failed === 1 ? "" : "s"} could not be loaded`;
    }
  } catch (error) {
    logError("Montage export failed", error);
    exportError.value = "Export failed";
  } finally {
    isExporting.value = false;
  }
}

onBeforeUnmount(() => {
  isUnmounted = true;
  debouncedSettleCrops.cancel();
  debouncedLabelRefresh.cancel();
  hydrationController?.abort();
  labelSequence++;
  hydrationSequence++;
  // A panel removed under the cursor never gets its mouseleave.
  if (pageIds.value.includes(annotationStore.hoveredAnnotationId ?? "")) {
    annotationStore.setHoveredAnnotationId(null);
  }
  loader.clear();
});

defineExpose({
  panels,
  settledCrops,
  cropsPending,
  cropKeyFor,
  loadCrop,
  exportCrop,
  canExport,
  exportPng,
  setLabelKeys,
  setPadding,
  loader,
});
</script>

<style lang="scss" scoped>
// Matches FloatingPalette's glass card (background, border, radius, shadow).
.montage-view {
  display: flex;
  flex-direction: column;
  background: var(--nimbus-glass-bg);
  backdrop-filter: var(--nimbus-glass-filter);
  -webkit-backdrop-filter: var(--nimbus-glass-filter);
  border: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.08));
  border-radius: var(--nimbus-radius-lg, 12px);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.04) inset,
    0 0 0 0.5px rgba(255, 255, 255, 0.06),
    0 20px 40px -16px rgba(0, 0, 0, 0.7),
    0 8px 16px -8px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.montage-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 8px 10px 14px;
  border-bottom: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.06));
  flex: 0 0 auto;
}

.montage-grip {
  display: inline-flex;
  flex-direction: column;
  gap: 2.5px;
  padding-right: 2px;

  i {
    width: 12px;
    height: 1.5px;
    background: var(--nimbus-text-faint, #62666d);
    border-radius: 2px;
    display: block;
  }
}

.montage-title {
  font-family: var(--nimbus-font);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--nimbus-text-secondary, #d0d6e0);
  margin: 0;
}

.montage-count {
  flex: 1;
  font-size: 12px;
  color: var(--nimbus-text-muted, #8a8f98);
}

.montage-close {
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--nimbus-text-muted, #8a8f98);
  cursor: pointer;
  display: grid;
  place-items: center;
  transition:
    background 0.15s ease,
    color 0.15s ease;

  svg {
    width: 14px;
    height: 14px;
  }

  &:hover {
    background: rgba(255, 255, 255, 0.06);
    color: var(--nimbus-text-secondary, #f3f5f7);
  }
}

.montage-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.06));
}

.montage-control {
  flex: 0 0 auto;
}

.montage-size {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 160px;
}

.montage-padding {
  width: 110px;
}

.montage-properties {
  width: 200px;
}

.montage-empty {
  padding: 24px;
  opacity: 0.7;
}

.montage-grid {
  flex: 1 1 auto;
  display: grid;
  align-content: start;
  overflow: auto;
  padding: 12px;
}
</style>
