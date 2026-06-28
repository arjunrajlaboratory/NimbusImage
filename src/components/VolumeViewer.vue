<template>
  <div class="volume-viewer">
    <div ref="vtkContainer" class="vtk-container" />

    <div class="volume-toolbar">
      <v-btn-toggle
        v-model="axisMode"
        mandatory
        density="compact"
        variant="outlined"
        color="primary"
      >
        <v-btn value="z" size="small" title="Z as depth axis">
          <v-icon size="18">mdi-axis-z-arrow</v-icon>
        </v-btn>
        <v-btn
          value="t"
          size="small"
          title="Time as depth axis (timelapse)"
          :disabled="!canUseTimeAxis"
        >
          <v-icon size="18">mdi-clock-outline</v-icon>
        </v-btn>
      </v-btn-toggle>

      <v-btn
        v-if="axisMode === 't'"
        variant="text"
        size="small"
        icon
        title="Time depth spacing"
        @click="openTimeSpacingDialog"
      >
        <v-icon size="20">mdi-arrow-expand-vertical</v-icon>
      </v-btn>

      <v-divider vertical />

      <v-btn-toggle
        v-model="blendMode"
        mandatory
        density="compact"
        variant="outlined"
        color="primary"
      >
        <v-btn value="composite" size="small" title="Composite">
          <v-icon size="18">mdi-layers-triple-outline</v-icon>
        </v-btn>
        <v-btn value="mip" size="small" title="Maximum intensity">
          <v-icon size="18">mdi-chart-bell-curve</v-icon>
        </v-btn>
      </v-btn-toggle>

      <v-divider vertical />

      <v-btn
        variant="text"
        size="small"
        icon
        :color="showVolume ? 'primary' : undefined"
        title="Volume"
        @click="showVolume = !showVolume"
      >
        <v-icon size="20">mdi-cube-outline</v-icon>
      </v-btn>
      <v-btn
        variant="text"
        size="small"
        icon
        :color="showSegmentations ? 'primary' : undefined"
        title="Segmentations"
        @click="showSegmentations = !showSegmentations"
      >
        <v-icon size="20">mdi-vector-polygon</v-icon>
      </v-btn>
      <v-btn
        variant="text"
        size="small"
        icon
        title="Reset camera"
        @click="resetCamera"
      >
        <v-icon size="20">mdi-fit-to-page-outline</v-icon>
      </v-btn>

      <v-divider vertical />

      <v-btn-toggle
        v-model="segmentationColorMode"
        mandatory
        density="compact"
        variant="outlined"
        color="primary"
      >
        <v-btn value="tag" size="small" title="Color by tag">
          <v-icon size="18">mdi-tag-outline</v-icon>
        </v-btn>
        <v-btn value="property" size="small" title="Color by property">
          <v-icon size="18">mdi-chart-scatter-plot</v-icon>
        </v-btn>
      </v-btn-toggle>

      <v-select
        v-if="segmentationColorMode === 'property'"
        v-model="selectedPropertyKey"
        :items="propertyItems"
        density="compact"
        variant="outlined"
        hide-details
        single-line
        class="property-select"
        :disabled="propertyItems.length === 0"
      />
    </div>

    <div v-if="statusText" class="volume-status">
      <v-progress-circular
        v-if="loading"
        indeterminate
        size="18"
        width="2"
        color="white"
      />
      <span>{{ statusText }}</span>
    </div>

    <v-dialog v-model="timeSpacingDialog" max-width="360px">
      <v-card>
        <v-card-title>Time depth spacing</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="timeSpacingInput"
            type="number"
            label="Spacing between timepoints (µm)"
            density="comfortable"
            hide-details
            autofocus
          />
          <div class="time-spacing-hint">
            Default is 5× the pixel size{{
              defaultTimeStepUm != null
                ? ` (${round2(defaultTimeStepUm)} µm)`
                : ""
            }}. Time has no physical depth, so this is a display choice.
          </div>
        </v-card-text>
        <v-card-actions class="button-bar">
          <v-btn variant="text" size="small" @click="resetTimeSpacing">
            Reset to default
          </v-btn>
          <v-spacer />
          <v-btn variant="text" size="small" @click="timeSpacingDialog = false">
            Cancel
          </v-btn>
          <v-btn
            variant="flat"
            color="primary"
            size="small"
            @click="applyTimeSpacing"
          >
            Apply
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import "@kitware/vtk.js/Rendering/Profiles/Volume";
import vtkActor, {
  vtkActor as VtkActor,
} from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper, {
  vtkMapper as VtkMapper,
} from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkVolume, {
  vtkVolume as VtkVolume,
} from "@kitware/vtk.js/Rendering/Core/Volume";
import vtkVolumeMapper, {
  vtkVolumeMapper as VtkVolumeMapper,
} from "@kitware/vtk.js/Rendering/Core/VolumeMapper";
import vtkGenericRenderWindow, {
  vtkGenericRenderWindow as VtkGenericRenderWindow,
} from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import {
  computed,
  markRaw,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import store from "@/store";
import filterStore from "@/store/filters";
import propertyStore from "@/store/properties";
import volumeViewStore from "@/store/volumeView";
import {
  TVolumeAxis,
  TVolumeBlendMode,
  TVolumeSegmentationColorMode,
} from "@/store/model";
import {
  ChannelVolume,
  TileFrameVolumeSource,
  VolumeGeometry,
  defaultTimeStepUm as computeDefaultTimeStepUm,
} from "@/store/VolumeAPI";
import { annotationsTo3D } from "@/utils/annotationsTo3D";
import { convertLength } from "@/utils/conversion";
import { layerToVolumeTransferFunction } from "@/utils/layerToVolumeTransferFunction";
import { logError } from "@/utils/log";

interface IVolumePipeline {
  layerId: string;
  mapper: VtkVolumeMapper;
  actor: VtkVolume;
}

const vtkContainer = ref<HTMLElement | null>(null);
const loading = ref(false);
const statusText = ref("");
const volumeSource = new TileFrameVolumeSource(store.girderRestProxy);

let genericRenderWindow: VtkGenericRenderWindow | null = null;
let volumePipelines: IVolumePipeline[] = [];
let segmentationActor: VtkActor | null = null;
let segmentationMapper: VtkMapper | null = null;
let activeGeometry: VolumeGeometry | null = null;
let activeAbortController: AbortController | null = null;
let buildSerial = 0;
// Signature of the last build's geometry (dataset + depth axis). The camera is
// only reframed when this changes, so contrast / channel toggles preserve zoom.
let lastGeometrySignature: string | null = null;

const dataset = computed(() => store.dataset);
const layerStackImages = computed(() => store.layerStackImages);
const visibleLayerStackImages = computed(() =>
  layerStackImages.value.filter(
    (layerStackImage) => layerStackImage.layer.visible,
  ),
);

const blendMode = computed<TVolumeBlendMode>({
  get: () => volumeViewStore.blendMode,
  set: (value) => volumeViewStore.setBlendMode(value),
});

const axisMode = computed<TVolumeAxis>({
  get: () => volumeViewStore.axis,
  set: (value) => volumeViewStore.setAxis(value),
});

// Time can only be mapped to depth when the dataset has more than one timepoint.
const canUseTimeAxis = computed(() => (dataset.value?.time.length ?? 0) > 1);

const showVolume = computed({
  get: () => volumeViewStore.showVolume,
  set: (value: boolean) => volumeViewStore.setShowVolume(value),
});

const showSegmentations = computed({
  get: () => volumeViewStore.showSegmentations,
  set: (value: boolean) => volumeViewStore.setShowSegmentations(value),
});

const segmentationColorMode = computed<TVolumeSegmentationColorMode>({
  get: () => volumeViewStore.segmentationColorMode,
  set: (value) => volumeViewStore.setSegmentationColorMode(value),
});

function propertyKey(path: string[]) {
  return path.join("\u0000");
}

const propertyItems = computed(() =>
  propertyStore.computedPropertyPaths.map((path) => ({
    title: propertyStore.getFullNameFromPath(path) ?? path.join(" / "),
    value: propertyKey(path),
  })),
);

const selectedPropertyKey = computed({
  get: () => propertyKey(volumeViewStore.segmentationPropertyPath),
  set: (key: string) => {
    const item = propertyStore.computedPropertyPaths.find(
      (path) => propertyKey(path) === key,
    );
    volumeViewStore.setSegmentationPropertyPath(item ?? []);
  },
});

const zStepUmOverride = computed(() => {
  const zStep = store.scales.zStep;
  const value = convertLength(zStep.value, zStep.unit, "µm");
  return Number.isFinite(value) && value > 0 ? value : null;
});

// Depth spacing override when time is the depth axis (µm). null → auto default.
const timeStepUmOverride = computed(() => volumeViewStore.timeStepUmOverride);

// The default time depth spacing (5× the xy pixel size), shown in the dialog —
// uses the same computation the renderer applies.
const defaultTimeStepUm = computed(() => {
  const image = dataset.value?.anyImage();
  return image ? computeDefaultTimeStepUm(image) : null;
});

// Time-spacing dialog state.
const timeSpacingDialog = ref(false);
const timeSpacingInput = ref("");
function openTimeSpacingDialog() {
  const current = timeStepUmOverride.value ?? defaultTimeStepUm.value;
  timeSpacingInput.value = current != null ? String(round2(current)) : "";
  timeSpacingDialog.value = true;
}
function round2(value: number) {
  return Math.round(value * 100) / 100;
}
function applyTimeSpacing() {
  const parsed = Number(timeSpacingInput.value);
  volumeViewStore.setTimeStepUmOverride(
    Number.isFinite(parsed) && parsed > 0 ? parsed : null,
  );
  timeSpacingDialog.value = false;
}
function resetTimeSpacing() {
  volumeViewStore.setTimeStepUmOverride(null);
  timeSpacingDialog.value = false;
}

const volumeBuildKey = computed(() =>
  JSON.stringify({
    datasetId: dataset.value?.id ?? null,
    axis: axisMode.value,
    xy: store.xy,
    // Only the fixed (non-depth) axis index changes the volume; scrolling the
    // depth axis itself does not, so it must not force a rebuild.
    fixedIndex: axisMode.value === "z" ? store.time : store.z,
    zStepUm: zStepUmOverride.value,
    timeStepUm: timeStepUmOverride.value,
    layers: visibleLayerStackImages.value.map((layerStackImage) => ({
      id: layerStackImage.layer.id,
      channel: layerStackImage.layer.channel,
      contrast: layerStackImage.layer.contrast,
      hist: layerStackImage.hist
        ? [
            layerStackImage.hist.min,
            layerStackImage.hist.max,
            layerStackImage.hist.samples,
          ]
        : null,
    })),
  }),
);

const colorKey = computed(() =>
  JSON.stringify(
    store.layers.map((layer) => ({
      id: layer.id,
      color: layer.color,
    })),
  ),
);

function render() {
  genericRenderWindow?.getRenderWindow().render();
}

function renderer() {
  return genericRenderWindow?.getRenderer() ?? null;
}

function setMapperBlendMode(mapper: VtkVolumeMapper) {
  if (blendMode.value === "mip") {
    mapper.setBlendModeToMaximumIntensity();
  } else {
    mapper.setBlendModeToComposite();
  }
}

function applyTransferFunction(pipeline: IVolumePipeline) {
  const layer = store.layers.find(
    (candidate) => candidate.id === pipeline.layerId,
  );
  if (!layer) {
    return;
  }
  const { colorTransferFunction, opacityTransferFunction } =
    layerToVolumeTransferFunction(layer.color);
  const property = pipeline.actor.getProperty();
  property.setRGBTransferFunction(0, colorTransferFunction);
  property.setScalarOpacity(0, opacityTransferFunction);
  property.setInterpolationTypeToLinear();
  property.setShade(false);
}

function clearSegmentationActor() {
  const currentRenderer = renderer();
  if (currentRenderer && segmentationActor) {
    currentRenderer.removeActor(segmentationActor);
  }
  segmentationActor?.delete();
  segmentationMapper?.delete();
  segmentationActor = null;
  segmentationMapper = null;
}

function clearVolumeActors() {
  const currentRenderer = renderer();
  for (const pipeline of volumePipelines) {
    if (currentRenderer) {
      currentRenderer.removeVolume(pipeline.actor);
    }
    pipeline.actor.delete();
    pipeline.mapper.delete();
  }
  volumePipelines = [];
  activeGeometry = null;
}

function resetCamera() {
  const currentRenderer = renderer();
  if (!currentRenderer) {
    return;
  }
  currentRenderer.resetCamera();
  render();
}

function addChannelVolume(volume: ChannelVolume) {
  const currentRenderer = renderer();
  if (!currentRenderer) {
    return;
  }
  const mapper = vtkVolumeMapper.newInstance();
  mapper.setInputData(volume.imageData);
  mapper.setMaximumSamplesPerRay(2000);
  setMapperBlendMode(mapper);

  const actor = vtkVolume.newInstance();
  actor.setMapper(mapper);
  actor.setVisibility(showVolume.value);

  const pipeline = markRaw({
    layerId: volume.layer.id,
    mapper,
    actor,
  });
  applyTransferFunction(pipeline);
  volumePipelines.push(pipeline);
  currentRenderer.addVolume(actor);
}

async function ensureHistograms() {
  await Promise.all(
    visibleLayerStackImages.value.map((layerStackImage) =>
      layerStackImage.hist
        ? Promise.resolve(layerStackImage.hist)
        : store.getLayerHistogram(layerStackImage.layer),
    ),
  );
}

async function rebuildVolume() {
  const currentDataset = dataset.value;
  const currentRenderer = renderer();
  if (!currentDataset || !currentRenderer) {
    return;
  }

  activeAbortController?.abort();
  const abortController = new AbortController();
  activeAbortController = abortController;
  const serial = ++buildSerial;
  loading.value = true;
  statusText.value = "Building 3D";
  clearSegmentationActor();
  clearVolumeActors();

  if (visibleLayerStackImages.value.length === 0) {
    loading.value = false;
    statusText.value = "No visible layers";
    return;
  }

  try {
    await ensureHistograms();
    const volumes = await volumeSource.buildVolume(
      {
        dataset: currentDataset,
        layers: layerStackImages.value,
        xy: store.xy,
        z: store.z,
        time: store.time,
        axis: axisMode.value,
        zStepUmOverride: zStepUmOverride.value,
        timeStepUmOverride: timeStepUmOverride.value,
      },
      abortController.signal,
    );
    if (serial !== buildSerial || abortController.signal.aborted) {
      return;
    }
    volumes.forEach(addChannelVolume);
    activeGeometry = volumes[0]?.geometry ?? null;
    updateSegmentationActor();
    // Reframe only when the volume geometry fundamentally changes (dataset or
    // depth axis); contrast / channel-visibility rebuilds keep the camera.
    const signature = `${currentDataset.id}|${axisMode.value}`;
    if (signature !== lastGeometrySignature) {
      lastGeometrySignature = signature;
      resetCamera();
    } else {
      render();
    }
    loading.value = false;
    statusText.value = volumes.length
      ? `${volumes.length} channel${volumes.length === 1 ? "" : "s"}`
      : "No volume frames";
  } catch (error) {
    if (abortController.signal.aborted) {
      return;
    }
    logError(error);
    loading.value = false;
    statusText.value = "3D build failed";
  }
}

function updateSegmentationActor() {
  const currentRenderer = renderer();
  if (!currentRenderer || !activeGeometry) {
    clearSegmentationActor();
    render();
    return;
  }

  clearSegmentationActor();
  if (!showSegmentations.value) {
    render();
    return;
  }

  const result = annotationsTo3D({
    annotations: filterStore.filteredAnnotations,
    geometry: activeGeometry,
    currentXY: store.xy,
    currentTime: store.time,
    currentZ: store.z,
    axis: axisMode.value,
    colorMode: segmentationColorMode.value,
    propertyPath: volumeViewStore.segmentationPropertyPath,
    propertyValues: propertyStore.propertyValues,
  });
  if (result.polyData.getNumberOfCells() === 0) {
    render();
    return;
  }

  segmentationMapper = vtkMapper.newInstance({ scalarVisibility: true });
  segmentationMapper.setInputData(result.polyData);
  segmentationMapper.setScalarModeToUseCellData();
  segmentationMapper.setColorModeToMapScalars();
  segmentationMapper.setLookupTable(result.lookupTable);
  segmentationMapper.setScalarRange(result.scalarRange);

  segmentationActor = vtkActor.newInstance();
  segmentationActor.setMapper(segmentationMapper);
  segmentationActor.getProperty().setOpacity(0.55);
  // Backface culling off: earcut cap triangulation has arbitrary winding, and
  // the translucent prisms should render both faces.
  segmentationActor.getProperty().setBackfaceCulling(false);
  currentRenderer.addActor(segmentationActor);
  render();
}

function applyVisibility() {
  volumePipelines.forEach((pipeline) =>
    pipeline.actor.setVisibility(showVolume.value),
  );
  if (segmentationActor) {
    segmentationActor.setVisibility(showSegmentations.value);
  }
  if (showSegmentations.value && !segmentationActor) {
    updateSegmentationActor();
  }
  render();
}

function applyBlendMode() {
  volumePipelines.forEach((pipeline) => setMapperBlendMode(pipeline.mapper));
  render();
}

function applyLayerColors() {
  volumePipelines.forEach(applyTransferFunction);
  render();
}

function resize() {
  genericRenderWindow?.resize();
}

let resizeObserver: ResizeObserver | null = null;

onMounted(async () => {
  await nextTick();
  if (!vtkContainer.value) {
    return;
  }
  genericRenderWindow = markRaw(
    vtkGenericRenderWindow.newInstance({
      background: [0, 0, 0],
      listenWindowResize: false,
    }),
  );
  genericRenderWindow.setContainer(vtkContainer.value);
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(vtkContainer.value);
  rebuildVolume();
});

onBeforeUnmount(() => {
  activeAbortController?.abort();
  resizeObserver?.disconnect();
  resizeObserver = null;
  clearSegmentationActor();
  clearVolumeActors();
  genericRenderWindow?.delete();
  genericRenderWindow = null;
});

// Never leave the depth axis on "time" for a dataset that has no time series.
watch(canUseTimeAxis, (canUse) => {
  if (!canUse && axisMode.value === "t") {
    axisMode.value = "z";
  }
});

watch(volumeBuildKey, rebuildVolume);
watch(blendMode, applyBlendMode);
watch(showVolume, applyVisibility);
watch(showSegmentations, applyVisibility);
watch(colorKey, applyLayerColors);
// Segmentation-only inputs (these don't change the volume, so they don't go
// through rebuildVolume). Navigation / axis changes update segmentations via
// the rebuild instead.
watch(
  [
    () => filterStore.filteredAnnotations,
    segmentationColorMode,
    selectedPropertyKey,
    () => propertyStore.propertyValues,
  ],
  () => {
    updateSegmentationActor();
  },
);

defineExpose({
  vtkContainer,
  loading,
  statusText,
  blendMode,
  showVolume,
  showSegmentations,
  segmentationColorMode,
  selectedPropertyKey,
  propertyItems,
  rebuildVolume,
  resetCamera,
  updateSegmentationActor,
  get genericRenderWindow() {
    return genericRenderWindow;
  },
});
</script>

<style lang="scss" scoped>
.volume-viewer {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #000;
}

.vtk-container {
  position: absolute;
  inset: 0;
}

// The 2D/3D switcher (in Viewer.vue) sits in the bottom-right corner; the
// volume toolbar stacks just above it, and the status/progress readout above
// that — all clear of the left-hand navigator/layers panels.
.volume-toolbar {
  position: absolute;
  right: 10px;
  bottom: 56px;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  max-width: calc(100% - 20px);
  padding: 6px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  background: rgba(18, 24, 30, 0.78);
  backdrop-filter: blur(10px);
}

.property-select {
  width: min(260px, 35vw);
}

.time-spacing-hint {
  margin-top: 8px;
  font-size: 12px;
  opacity: 0.7;
}

.volume-status {
  position: absolute;
  right: 10px;
  bottom: 112px;
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(360px, calc(100% - 20px));
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.72);
  color: white;
  font-size: 12px;
}
</style>
