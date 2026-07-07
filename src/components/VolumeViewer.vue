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
      <div
        v-if="showSegmentations"
        class="segmentation-opacity"
        title="Segmentation opacity"
      >
        <v-icon size="16">mdi-opacity</v-icon>
        <v-slider
          v-model="segmentationOpacity"
          :min="0.05"
          :max="1"
          :step="0.05"
          density="compact"
          hide-details
        />
      </div>
      <v-btn
        v-if="showSegmentations"
        variant="text"
        size="small"
        icon
        :color="loftSurfaces ? 'primary' : undefined"
        title="Loft stacked annotations into smooth surfaces"
        @click="loftSurfaces = !loftSurfaces"
      >
        <v-icon size="20">mdi-vector-curve</v-icon>
      </v-btn>
      <v-btn
        v-if="showSegmentations && loftSurfaces"
        variant="text"
        size="small"
        icon
        title="Loft overlap threshold"
        @click="loftDialog = true"
      >
        <v-icon size="20">mdi-tune-variant</v-icon>
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
      <v-btn
        variant="text"
        size="small"
        icon
        :color="showAxes ? 'primary' : undefined"
        title="Orientation axes"
        @click="showAxes = !showAxes"
      >
        <v-icon size="20">mdi-axis-arrow</v-icon>
      </v-btn>
      <v-btn
        variant="text"
        size="small"
        icon
        :color="showBoundingBox ? 'primary' : undefined"
        title="Scaled bounding box (µm)"
        @click="showBoundingBox = !showBoundingBox"
      >
        <v-icon size="20">mdi-grid</v-icon>
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

    <v-dialog v-model="loftDialog" max-width="420px">
      <v-card>
        <v-card-title>Loft overlap threshold</v-card-title>
        <v-card-text>
          <v-slider
            v-model="loftOverlapPercent"
            :min="0"
            :max="95"
            :step="5"
            density="comfortable"
            hide-details
          >
            <template v-slot:append>
              <span class="loft-threshold-value">
                {{ loftOverlapPercent }}%
              </span>
            </template>
          </v-slider>
          <div class="loft-hint">
            Annotations with the same tag on adjacent slices are joined into one
            surface when their xy overlap is at least this fraction of the
            smaller annotation. 0% joins on any overlap.
          </div>
        </v-card-text>
        <v-card-actions class="button-bar">
          <v-spacer />
          <v-btn variant="text" size="small" @click="loftDialog = false">
            Close
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

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
// Registers the OpenGL implementation of vtkSphereMapper (point spheres).
import "@kitware/vtk.js/Rendering/Profiles/Molecule";
import vtkPolyDataNormals from "@kitware/vtk.js/Filters/Core/PolyDataNormals";
import vtkActor, {
  vtkActor as VtkActor,
} from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkSphereMapper, {
  vtkSphereMapper as VtkSphereMapper,
} from "@kitware/vtk.js/Rendering/Core/SphereMapper";
import vtkAxesActor from "@kitware/vtk.js/Rendering/Core/AxesActor";
import vtkCubeAxesActor from "@kitware/vtk.js/Rendering/Core/CubeAxesActor";
import vtkOrientationMarkerWidget, {
  vtkOrientationMarkerWidget as VtkOrientationMarkerWidget,
} from "@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget";
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

// CubeAxesActor ships without types; it's a vtkActor with these extra methods.
type VtkCubeAxesActor = VtkActor & {
  setCamera(camera: unknown): boolean;
  setDataBounds(bounds: number[]): boolean;
  setGridLines(value: boolean): boolean;
};

const vtkContainer = ref<HTMLElement | null>(null);
const loading = ref(false);
const statusText = ref("");
const volumeSource = new TileFrameVolumeSource(store.girderRestProxy, {
  // Reuse GirderAPI's cached, merging histogram fetch for whole-cube windowing.
  getLayerHistogram: (images) => store.api.getLayerHistogram(images),
});

interface ISegmentationPipeline {
  actor: VtkActor;
  mapper: VtkMapper | VtkSphereMapper;
}

let genericRenderWindow: VtkGenericRenderWindow | null = null;
let orientationWidget: VtkOrientationMarkerWidget | null = null;
let axesActor: ReturnType<typeof vtkAxesActor.newInstance> | null = null;
let cubeAxesActor: VtkCubeAxesActor | null = null;
let volumePipelines: IVolumePipeline[] = [];
// Annotation rendering: one actor for extruded surfaces, one for point
// spheres (only the ones with geometry are created).
let segmentationPipelines: ISegmentationPipeline[] = [];
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

const showAxes = computed({
  get: () => volumeViewStore.showAxes,
  set: (value: boolean) => volumeViewStore.setShowAxes(value),
});

const showBoundingBox = computed({
  get: () => volumeViewStore.showBoundingBox,
  set: (value: boolean) => volumeViewStore.setShowBoundingBox(value),
});

const segmentationColorMode = computed<TVolumeSegmentationColorMode>({
  get: () => volumeViewStore.segmentationColorMode,
  set: (value) => volumeViewStore.setSegmentationColorMode(value),
});

const segmentationOpacity = computed({
  get: () => volumeViewStore.segmentationOpacity,
  set: (value: number) => volumeViewStore.setSegmentationOpacity(value),
});

const loftSurfaces = computed({
  get: () => volumeViewStore.loftSurfaces,
  set: (value: boolean) => volumeViewStore.setLoftSurfaces(value),
});

const loftOverlapPercent = computed({
  get: () => volumeViewStore.loftOverlapPercent,
  set: (value: number) => volumeViewStore.setLoftOverlapPercent(value),
});

const loftDialog = ref(false);

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
      // Slice settings pick which frame(s) feed the volume (see
      // resolveVisibleLayers): the xy slice always, and the fixed (non-depth)
      // axis slice. The depth axis iterates all of its values, so its own
      // slice setting is irrelevant and intentionally omitted.
      xy: layerStackImage.layer.xy,
      fixedSlice:
        axisMode.value === "z"
          ? layerStackImage.layer.time
          : layerStackImage.layer.z,
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

function clearSegmentationActors() {
  const currentRenderer = renderer();
  for (const pipeline of segmentationPipelines) {
    currentRenderer?.removeActor(pipeline.actor);
    pipeline.actor.delete();
    pipeline.mapper.delete();
  }
  segmentationPipelines = [];
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

function boundsFromGeometry(geometry: VolumeGeometry): number[] {
  const [dx, dy, dz] = geometry.dimensions;
  const [sx, sy, sz] = geometry.spacing;
  const [ox, oy, oz] = geometry.origin;
  return [
    ox,
    ox + (dx - 1) * sx,
    oy,
    oy + (dy - 1) * sy,
    oz,
    oz + (dz - 1) * sz,
  ];
}

// Scaled bounding box (µm tick labels). Tracks the current volume bounds and
// is only shown when enabled and a volume exists.
function updateBoundingBox() {
  if (!cubeAxesActor) {
    return;
  }
  if (activeGeometry) {
    cubeAxesActor.setDataBounds(boundsFromGeometry(activeGeometry));
  }
  cubeAxesActor.setVisibility(showBoundingBox.value && !!activeGeometry);
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
  clearSegmentationActors();
  clearVolumeActors();

  if (visibleLayerStackImages.value.length === 0) {
    loading.value = false;
    statusText.value = "No visible layers";
    return;
  }

  try {
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
    updateSegmentationActors();
    updateBoundingBox();
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

function addSegmentationActor(mapper: VtkMapper | VtkSphereMapper) {
  const currentRenderer = renderer();
  if (!currentRenderer) {
    return;
  }
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  const property = actor.getProperty();
  property.setOpacity(segmentationOpacity.value);
  // Backface culling off: earcut cap triangulation has arbitrary winding, and
  // the translucent prisms/ribbons should render both faces.
  property.setBackfaceCulling(false);
  // Lit, slightly specular shading so annotations read as surfaces.
  property.setInterpolationToPhong();
  property.setAmbient(0.3);
  property.setDiffuse(0.7);
  property.setSpecular(0.15);
  property.setSpecularPower(16);
  segmentationPipelines.push(markRaw({ actor, mapper }));
  currentRenderer.addActor(actor);
}

// Bumped on every segmentation update; results of superseded async builds
// are discarded instead of being applied out of order.
let segmentationSerial = 0;

async function updateSegmentationActors() {
  const serial = ++segmentationSerial;
  if (!renderer() || !activeGeometry || !showSegmentations.value) {
    clearSegmentationActors();
    render();
    return;
  }

  // Async: the loft chain matching runs in a web worker. The previous actors
  // stay on screen until the replacement is ready.
  const result = await annotationsTo3D({
    annotations: filterStore.filteredAnnotations,
    geometry: activeGeometry,
    currentXY: store.xy,
    currentTime: store.time,
    currentZ: store.z,
    axis: axisMode.value,
    colorMode: segmentationColorMode.value,
    propertyPath: volumeViewStore.segmentationPropertyPath,
    propertyValues: propertyStore.propertyValues,
    loftSurfaces: loftSurfaces.value,
    loftOverlapFraction: loftOverlapPercent.value / 100,
  });
  if (serial !== segmentationSerial || !renderer() || !activeGeometry) {
    return;
  }
  clearSegmentationActors();

  if (result.surfacePolyData.getNumberOfCells() > 0) {
    // Smooth point normals make the extruded prisms shade like rounded
    // surfaces instead of flat unlit slabs.
    const normalsFilter = vtkPolyDataNormals.newInstance();
    normalsFilter.setInputData(result.surfacePolyData);
    const mapper = vtkMapper.newInstance({ scalarVisibility: true });
    mapper.setInputData(normalsFilter.getOutputData());
    mapper.setScalarModeToUseCellData();
    mapper.setColorModeToMapScalars();
    mapper.setLookupTable(result.lookupTable);
    mapper.setScalarRange(result.scalarRange);
    addSegmentationActor(mapper);
  }

  if (result.pointsPolyData.getNumberOfPoints() > 0) {
    // Point annotations render as small shaded spheres.
    const mapper = vtkSphereMapper.newInstance();
    mapper.setInputData(result.pointsPolyData);
    mapper.setRadius(result.pointRadius);
    mapper.setScalarModeToUsePointData();
    mapper.setColorModeToMapScalars();
    mapper.setLookupTable(result.lookupTable);
    mapper.setScalarRange(result.scalarRange);
    addSegmentationActor(mapper);
  }
  render();
}

function applySegmentationOpacity() {
  segmentationPipelines.forEach((pipeline) =>
    pipeline.actor.getProperty().setOpacity(segmentationOpacity.value),
  );
  render();
}

function applyVisibility() {
  volumePipelines.forEach((pipeline) =>
    pipeline.actor.setVisibility(showVolume.value),
  );
  segmentationPipelines.forEach((pipeline) =>
    pipeline.actor.setVisibility(showSegmentations.value),
  );
  if (showSegmentations.value && segmentationPipelines.length === 0) {
    updateSegmentationActors();
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

  // Orientation gizmo (corner XYZ axes that rotate with the camera). The depth
  // axis is the blue Z arrow whether it represents z-planes or time.
  axesActor = markRaw(vtkAxesActor.newInstance());
  orientationWidget = markRaw(
    vtkOrientationMarkerWidget.newInstance({
      actor: axesActor,
      interactor: genericRenderWindow.getInteractor(),
    }),
  );
  // Bottom-right corner; the toolbar/status are shifted left to leave room.
  orientationWidget.setViewportCorner(
    vtkOrientationMarkerWidget.Corners.BOTTOM_RIGHT,
  );
  orientationWidget.setViewportSize(0.15);
  orientationWidget.setMinPixelSize(80);
  orientationWidget.setMaxPixelSize(160);
  orientationWidget.setEnabled(showAxes.value);

  // Scaled bounding box with µm tick labels (off until toggled / a build runs).
  cubeAxesActor = markRaw(vtkCubeAxesActor.newInstance() as VtkCubeAxesActor);
  cubeAxesActor.setCamera(genericRenderWindow.getRenderer().getActiveCamera());
  cubeAxesActor.setGridLines(false);
  cubeAxesActor.setVisibility(false);
  genericRenderWindow.getRenderer().addActor(cubeAxesActor);

  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(vtkContainer.value);
  rebuildVolume();
});

onBeforeUnmount(() => {
  activeAbortController?.abort();
  resizeObserver?.disconnect();
  resizeObserver = null;
  clearSegmentationActors();
  clearVolumeActors();
  orientationWidget?.setEnabled(false);
  orientationWidget?.delete();
  orientationWidget = null;
  axesActor?.delete();
  axesActor = null;
  if (cubeAxesActor) {
    renderer()?.removeActor(cubeAxesActor);
    cubeAxesActor.delete();
    cubeAxesActor = null;
  }
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
watch(showAxes, (value) => {
  orientationWidget?.setEnabled(value);
  render();
});
watch(showBoundingBox, updateBoundingBox);
watch(colorKey, applyLayerColors);
// Opacity only touches actor properties; the geometry is left alone.
watch(segmentationOpacity, applySegmentationOpacity);
// Segmentation-only inputs (these don't change the volume, so they don't go
// through rebuildVolume). Navigation / axis changes update segmentations via
// the rebuild instead.
watch(
  [
    () => filterStore.filteredAnnotations,
    segmentationColorMode,
    selectedPropertyKey,
    () => propertyStore.propertyValues,
    loftSurfaces,
    loftOverlapPercent,
  ],
  () => {
    updateSegmentationActors();
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
  segmentationOpacity,
  loftSurfaces,
  loftOverlapPercent,
  selectedPropertyKey,
  propertyItems,
  rebuildVolume,
  resetCamera,
  updateSegmentationActors,
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

// The 2D/3D toggle lives in the top app bar. The orientation gizmo sits in the
// bottom-right corner, so the toolbar and status are offset left of it (and
// clear of the left-hand navigator/layers panels). The status stacks just
// above the toolbar.
$gizmo-clearance: 130px;

.volume-toolbar {
  position: absolute;
  right: $gizmo-clearance;
  bottom: 10px;
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

.segmentation-opacity {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 110px;
  padding: 0 4px;

  .v-slider {
    flex: 1;
    margin-inline: 0;
  }
}

.time-spacing-hint,
.loft-hint {
  margin-top: 8px;
  font-size: 12px;
  opacity: 0.7;
}

.loft-threshold-value {
  min-width: 40px;
  text-align: right;
  font-size: 13px;
}

.volume-status {
  position: absolute;
  right: $gizmo-clearance;
  bottom: 56px;
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
