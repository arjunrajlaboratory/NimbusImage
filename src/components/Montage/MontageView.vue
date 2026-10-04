<template>
  <div class="montage-view">
    <div class="montage-toolbar">
      <v-tooltip text="Back to the image view">
        <template v-slot:activator="{ props: activatorProps }">
          <v-btn
            v-bind="activatorProps"
            variant="text"
            icon
            size="small"
            aria-label="Close montage"
            @click="montageStore.setIsOpen(false)"
          >
            <v-icon>mdi-arrow-left</v-icon>
          </v-btn>
        </template>
      </v-tooltip>
      <span class="montage-count text-body-2">
        {{ countLabel }}
      </span>
      <v-divider vertical class="mx-2" />
      <div class="montage-control montage-size">
        <span class="text-caption">Size</span>
        <v-slider
          :model-value="settings.panelSize"
          :min="80"
          :max="320"
          :step="20"
          density="compact"
          hide-details
          @update:model-value="setPanelSize"
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
import {
  IMontageImageRequest,
  MontageImageLoader,
  createLimiter,
} from "@/utils/montageImageLoader";
import { getLayersDownloadUrls } from "@/utils/screenshot";
import { getStringFromPropertiesAndPath } from "@/utils/paths";
import { goToAnnotationLocation } from "@/utils/annotationNavigation";
import { downloadToClient } from "@/utils/download";
import { logError } from "@/utils/log";

const GAP = 6;
const EXPORT_BACKGROUND = "#202020";

const gridEl = ref<HTMLElement | null>(null);
const isExporting = ref(false);
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

// The store replaces its property-value map when values are (re)computed or
// fetched; the montage's own copy goes stale then, so refetch. Debounced: a
// compute can land values in several batches.
const debouncedLabelRefresh = debounce(refreshLabels, 300);
watch(
  () => propertyStore.propertyValues,
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
function resolveAnnotation(id: string): TAnnotationOrStub | undefined {
  const fromStore = storeAnnotation(id);
  if (fromStore && isHydratedAnnotation(fromStore)) {
    return fromStore;
  }
  return fetchedAnnotations.value.get(id) ?? fromStore;
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
interface ICropInput {
  annotation: TAnnotationOrStub;
  window: IImageRect;
  imageRect: IImageRect | null;
}

const settledCrops = shallowRef({
  generation: 0,
  inputs: new Map<string, ICropInput>(),
});
// True from any input change until the next generation is settled, so the
// export never draws a page whose crops don't match it.
const cropsPending = ref(true);
const cropBuilds = new Map<string, Promise<IMontageCrop>>();
const limitCropBuilds = createLimiter(4);

function settleCrops() {
  // Hydration changes the windows; the watcher re-fires when it ends.
  if (!dataset.value || isHydrating.value) {
    return;
  }
  cropBuilds.clear();
  settledCrops.value = {
    generation: settledCrops.value.generation + 1,
    inputs: new Map(
      panels.value.map(({ id, annotation, content }) => [
        id,
        { annotation, window: content.window, imageRect: content.imageRect },
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
  const { annotation, window, imageRect } = input;
  if (!imageRect) {
    throw new MontageCropError("Object is outside the image");
  }
  const currentDataset = dataset.value!;
  const anyImage = currentDataset.anyImage();
  if (!anyImage) {
    throw new MontageCropError("Dataset has no images");
  }
  const scale =
    (settings.value.panelSize * pixelRatio) / (window.right - window.left);
  const { width, height } = regionOutputSize(imageRect, scale);
  const baseUrl = new URL(
    `${store.girderRest.apiRoot}/item/${anyImage.item._id}/tiles/region`,
  );
  const params = {
    ...imageRect,
    width,
    height,
    encoding: "JPEG",
    jpegQuality: 90,
  };
  for (const [key, value] of Object.entries(params)) {
    baseUrl.searchParams.set(key, String(value));
  }
  const { XY, Z, Time } = annotation.location;
  try {
    const [{ url }] = await getLayersDownloadUrls(
      baseUrl,
      "composite",
      store.layers,
      currentDataset,
      { xy: XY, z: Z, time: Time },
      store.api,
    );
    return { url, imageRect };
  } catch (error) {
    // Its validation errors (no visible layer, no plane at this frame) are
    // expected per object; anything else (a histogram fetch) is a failure.
    if (error instanceof Error && /^No (image|layers)/.test(error.message)) {
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
    build = limitCropBuilds(() => buildPanelCrop(input));
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

async function exportPng() {
  // Capture everything the export depends on before the first await.
  const exported = panels.value.map((panel) => ({
    content: panel.content,
    cropKey: cropKeyFor(panel.id),
  }));
  const size = Math.round(settings.value.panelSize * pixelRatio);
  const gap = Math.round(GAP * pixelRatio);
  const grid = montageGrid(
    exported.length,
    exportColumns(exported.length),
    size,
    gap,
  );
  const datasetName = dataset.value?.name ?? "dataset";
  isExporting.value = true;
  exportError.value = null;
  const held: IMontageImageRequest[] = [];
  try {
    // Offscreen panels haven't built or fetched their crops yet; do it here.
    const crops = await Promise.all(
      exported.map(async ({ cropKey }) => {
        if (!cropKey) return null;
        try {
          const crop = await loadCrop(cropKey);
          const request = loader.load(crop.url);
          held.push(request);
          return { image: await request.promise, imageRect: crop.imageRect };
        } catch {
          return null;
        }
      }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = grid.width;
    canvas.height = grid.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas is unavailable.");
    }
    ctx.fillStyle = EXPORT_BACKGROUND;
    ctx.fillRect(0, 0, grid.width, grid.height);
    exported.forEach(({ content }, i) => {
      const column = i % grid.columns;
      const row = Math.floor(i / grid.columns);
      drawMontagePanel(
        ctx,
        column * (size + gap),
        row * (size + gap),
        size,
        {
          ...content,
          image: crops[i]?.image ?? null,
          imageRect: crops[i]?.imageRect ?? null,
        },
        pixelRatio,
      );
    });
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) {
      throw new Error("Could not encode the montage image.");
    }
    const href = URL.createObjectURL(blob);
    downloadToClient({ href, download: `${datasetName} - montage.png` });
    setTimeout(() => URL.revokeObjectURL(href), 0);
  } catch (error) {
    logError("Montage export failed", error);
    exportError.value = "Export failed";
  } finally {
    held.forEach((request) => request.release());
    isExporting.value = false;
  }
}

onBeforeUnmount(() => {
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
  canExport,
  exportPng,
  setLabelKeys,
  setPadding,
  loader,
});
</script>

<style lang="scss" scoped>
.montage-view {
  display: flex;
  flex-direction: column;
  background: rgb(var(--v-theme-background));
  overflow: hidden;
}

.montage-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
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
