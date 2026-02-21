<template>
  <div>
    <v-card v-if="store.configuration">
      <v-card-title class="headline"> Snapshots </v-card-title>
      <v-dialog v-model="imageTooBigDialog">
        <v-alert class="ma-0" type="error">
          <div class="title">Image can't be downloaded</div>
          <div class="ma-2">
            Image size can't exceed {{ maxPixels }} pixels.<br />
            When downloading raw channels, subsampling is not allowed.<br />
            Downloading layers allows subsampling image to
            {{ maxPixels }} pixels if the image is too big.
          </div>
          <div class="d-flex">
            <v-spacer />
            <v-btn @click="imageTooBigDialog = false">OK</v-btn>
          </div>
        </v-alert>
      </v-dialog>

      <v-card-text>
        <v-row :currentArea="markCurrentArea()">
          <v-col class="title body-1"> Coordinates and size: </v-col>
        </v-row>
        <v-row v-if="store.dataset">
          <v-col>
            <v-text-field
              label="Left"
              v-model="bboxLeft"
              type="number"
              :max="store.dataset.width"
              dense
              hide-details
            />
          </v-col>
          <v-col>
            <v-text-field
              label="Top"
              v-model="bboxTop"
              type="number"
              :max="store.dataset.height"
              dense
              hide-details
            />
          </v-col>
          <v-col>
            <v-text-field
              label="Width"
              v-model="bboxWidth"
              type="number"
              :max="store.dataset.width"
              dense
              hide-details
            />
          </v-col>
          <v-col>
            <v-text-field
              label="Height"
              v-model="bboxHeight"
              type="number"
              :max="store.dataset.height"
              dense
              hide-details
            />
          </v-col>
        </v-row>
        <v-row class="pl-3">
          <v-btn
            small
            class="my-2"
            @click="setArea('viewport')"
            :disabled="isRotated()"
          >
            Set frame to current view
          </v-btn>
          <v-btn small class="my-2" @click="setArea('full')">
            Set frame to maximum view size
          </v-btn>
        </v-row>
        <v-row class="pl-3">
          <v-dialog v-model="createDialog">
            <template v-slot:activator="{ on, attrs }">
              <v-btn
                color="primary"
                v-on="on"
                v-bind="attrs"
                :disabled="!isLoggedIn"
                v-description="{
                  section: 'Snapshots',
                  title: 'Save as Snapshot',
                  description: 'Bookmark a location as a Snapshot',
                }"
              >
                Save as Snapshot...
              </v-btn>
            </template>
            <v-card>
              <v-card-title> Create New Snapshot </v-card-title>
              <v-form
                lazy-validation
                ref="saveSnapshotForm"
                @input="updateFormValidation"
                @submit.prevent="saveSnapshot"
              >
                <v-card-text
                  title="Add a name, description, or tags to create a new snapshot."
                >
                  <v-row>
                    <v-col>
                      <v-text-field
                        label="Snapshot name"
                        v-model="newName"
                        dense
                        hide-details
                        autofocus
                        :rules="nameRules"
                        required
                      />
                    </v-col>
                  </v-row>
                  <v-row>
                    <v-col>
                      <tag-picker v-model="newTags" />
                    </v-col>
                  </v-row>
                  <v-row>
                    <v-col>
                      <v-text-field
                        label="Snapshot description"
                        v-model="newDescription"
                        dense
                        hide-details
                      />
                    </v-col>
                  </v-row>
                </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn
                    color="primary"
                    :disabled="!isSaveSnapshotValid"
                    type="submit"
                  >
                    Create Snapshot
                  </v-btn>
                </v-card-actions>
              </v-form>
            </v-card>
          </v-dialog>
        </v-row>
      </v-card-text>

      <v-divider />
      <v-card-title class="headline"> Snapshot list </v-card-title>
      <v-card-text>
        <v-data-table
          :items="snapshotList"
          :headers="tableHeaders"
          :items-per-page="5"
          item-key="key"
          class="accent-1"
          @click:row="loadSnapshot"
          show-select
          v-model="selectedSnapshotItems"
        >
          <!-- Search bar -->
          <template v-slot:top>
            <v-text-field
              label="Filter by name..."
              v-model="snapshotSearch"
              clearable
              hide-details
              class="ma-2"
            />
          </template>
          <!-- Datasets -->
          <template v-slot:item.datasetName="{ item }">
            <div style="max-width: 100px">
              {{ item.datasetName }}
            </div>
          </template>
          <!-- Tags -->
          <template v-slot:item.tags="{ item }">
            <v-chip
              v-for="t in item.record.tags"
              :key="'tag_' + item.name + '_' + t"
              @click.stop="snapshotSearch = t"
              x-small
              >{{ t }}</v-chip
            >
          </template>
          <!-- Delete icon -->
          <template v-slot:item.delete="{ item }">
            <v-btn
              fab
              small
              color="red"
              @click.stop="removeSnapshot(item.name)"
            >
              <v-icon>mdi-trash-can</v-icon>
            </v-btn>
          </template>
        </v-data-table>
      </v-card-text>

      <v-divider />

      <v-card-title
        class="headline"
        v-description="{
          section: 'Snapshots',
          title: 'Download Snapshot Images',
          description: 'Download images of the snapshot',
        }"
      >
        Download Snapshot Images
      </v-card-title>
      <v-card-text>
        <v-row>
          <v-col cols="5">
            <v-radio-group v-model="downloadMode">
              <v-radio label="Scaled Layers" value="layers" />
              <v-radio label="Raw channels" value="channels" />
            </v-radio-group>
          </v-col>
          <v-col>
            <v-select
              v-if="downloadMode === 'layers'"
              v-model="exportLayer"
              :items="layerItems"
              label="Layer"
              dense
              hide-details
            />
            <v-select
              v-if="downloadMode === 'channels'"
              v-model="exportChannel"
              :items="channelItems"
              label="Channel"
              dense
              hide-details
            />
          </v-col>
        </v-row>
        <v-row>
          <v-col>
            <v-select
              v-model="format"
              :items="formatList"
              label="Format"
              dense
              hide-details
            />
          </v-col>
        </v-row>
        <v-row>
          <v-col>
            <v-slider
              v-if="format === 'jpeg'"
              label="JPEG Quality"
              v-model="jpegQuality"
              min="80"
              max="95"
              step="5"
            >
              <template v-slot:append>
                <v-text-field
                  v-model="jpegQuality"
                  class="mt-0 pt-0"
                  type="number"
                  step="5"
                  style="width: 3em"
                />
              </template>
            </v-slider>
          </v-col>
        </v-row>
      </v-card-text>
      <v-card-actions class="d-block">
        <v-row>
          <v-col>
            <div class="d-flex align-center">
              <v-checkbox
                v-model="addScalebar"
                label="Add scalebar"
                class="mt-0 shrink"
                hide-details
              />
              <span class="ml-2 text-no-wrap">{{
                prettyScalebarSettings(scalebarSettings)
              }}</span>
              <v-icon
                small
                class="ml-2"
                @click.stop="scalebarSettingsDialog = true"
                >mdi-cog</v-icon
              >
            </div>
          </v-col>
        </v-row>
        <!-- Scalebar settings dialog -->
        <v-dialog v-model="scalebarSettingsDialog" max-width="600px">
          <v-card>
            <v-card-title>Snapshot Scalebar Settings</v-card-title>
            <v-card-text>
              <v-container>
                <v-row>
                  <v-col cols="6">
                    <div class="subtitle-1 mb-2">Pixel size</div>
                    <v-radio-group
                      v-model="pixelSizeMode"
                      @change="handlePixelSizeModeChange"
                    >
                      <v-radio
                        value="dataset"
                        :label="`Pixel size from dataset: ${formattedConfigurationPixelSize}`"
                      />
                      <v-radio
                        value="manual"
                        label="Manually select pixel size"
                      />
                    </v-radio-group>
                    <div class="mt-2">
                      <v-text-field
                        v-model.number="manualPixelSizeLength"
                        type="number"
                        step="0.1"
                        label="Pixel size"
                        dense
                        hide-details
                        class="mb-4"
                        :disabled="pixelSizeMode === 'dataset'"
                      />
                      <v-select
                        v-model="manualPixelSizeUnit"
                        :items="pixelSizeUnitItems"
                        label="Unit"
                        dense
                        hide-details
                        :disabled="pixelSizeMode === 'dataset'"
                      />
                    </div>
                  </v-col>
                  <v-col cols="6">
                    <div class="subtitle-1 mb-2">Scalebar length</div>
                    <v-radio-group
                      v-model="scalebarMode"
                      @change="handleScalebarModeChange"
                    >
                      <v-radio
                        value="automatic"
                        :label="`Automatic scalebar length: ${formattedScalebarSettings}`"
                      />
                      <v-radio
                        value="manual"
                        label="Manually select scalebar length"
                      />
                    </v-radio-group>
                    <div class="mt-2">
                      <v-text-field
                        v-model.number="manualScalebarSettingsLength"
                        type="number"
                        step="0.1"
                        label="Scalebar length"
                        dense
                        hide-details
                        class="mb-4"
                        :disabled="scalebarMode === 'automatic'"
                      />
                      <v-select
                        v-model="manualScalebarSettingsUnit"
                        :items="scalebarSettingsUnitItems"
                        label="Unit"
                        dense
                        hide-details
                        :disabled="
                          scalebarMode === 'automatic' ||
                          pixelSize.unit === 'px'
                        "
                      />
                    </div>
                  </v-col>
                </v-row>
              </v-container>
              <span class="d-flex align-center">
                <color-picker-menu
                  v-model="snapshotScalebarColor"
                  class="mx-2"
                  style="min-width: 200px"
                />
              </span>
            </v-card-text>
            <v-card-actions>
              <v-spacer></v-spacer>
              <v-btn text @click="scalebarSettingsDialog = false">Close</v-btn>
            </v-card-actions>
          </v-card>
        </v-dialog>

        <v-progress-circular v-if="downloading" indeterminate />

        <div class="mb-2">
          <v-btn
            color="primary"
            @click="downloadImagesForCurrentState()"
            :disabled="unroll || downloading"
          >
            Download images for current location
          </v-btn>
        </div>
        <div class="mb-2">
          <v-btn
            color="primary"
            @click="downloadImagesForAllSnapshots()"
            :disabled="unroll || downloading"
          >
            Download images for all Snapshots
          </v-btn>
        </div>
        <div class="mb-2">
          <v-btn
            color="primary"
            @click="downloadImagesForSelectedSnapshots()"
            :disabled="
              unroll || downloading || selectedSnapshotItems.length === 0
            "
          >
            Download images for selected Snapshots
          </v-btn>
        </div>
        <div class="mb-2">
          <v-btn
            color="primary"
            @click="snapshotWithAnnotations()"
            :disabled="unroll || downloading"
          >
            Download image with annotations
          </v-btn>
        </div>
        <div class="mb-2">
          <v-btn
            color="primary"
            @click="movieDialog = true"
            :disabled="unroll || downloading"
          >
            Download movie for current location
          </v-btn>
        </div>
        <div class="mb-2">
          <v-checkbox
            v-model="addAnnotationsToMovie"
            label="Include annotations in movie"
            class="ma-0 pa-0"
          ></v-checkbox>
        </div>
      </v-card-actions>

      <v-divider />

      <div class="d-flex pa-2">
        <v-btn color="primary" @click="screenshotViewport()">
          Download Screenshot of Current Viewport
        </v-btn>
      </div>
    </v-card>
    <v-dialog width="min-content" v-model="layersOverwritePanel" persistent>
      <v-alert prominent type="warning" class="ma-0">
        <div>
          <v-card-title> Snapshot layers incompatibility </v-card-title>
          <v-card-text>
            The selected snapshot layers are not compatible with the current
            configuration layers. It can be because some layers have been
            removed or because layer channels have changed.
          </v-card-text>
          <v-card-actions class="d-flex justify-end">
            <v-btn @click="overwriteConfigurationLayers" color="red">
              Overwrite configuration layers
            </v-btn>
            <v-btn @click="changeDatasetViewContrasts" color="secondary">
              Try to apply contrasts anyway
            </v-btn>
            <v-btn @click="layersOverwritePanel = false" color="primary">
              Do not change layers
            </v-btn>
          </v-card-actions>
        </div>
      </v-alert>
    </v-dialog>
    <movie-dialog
      v-if="store.dataset"
      v-model="movieDialog"
      :current-time="store.time"
      :dataset="store.dataset"
      @download="handleMovieDownload"
    />
  </div>
</template>
<script lang="ts">
export enum TScalebarUnit {
  NM = "nm",
  UM = "µm",
  MM = "mm",
  M = "m",
  PX = "px",
}

export enum MovieFormat {
  ZIP = "zip",
  GIF = "gif",
  WEBM = "webm",
  MP4 = "mp4",
}

export enum PixelSizeMode {
  DATASET = "dataset",
  MANUAL = "manual",
}

export enum ScalebarMode {
  AUTOMATIC = "automatic",
  MANUAL = "manual",
}
</script>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import TagPicker from "@/components/TagPicker.vue";
import MovieDialog from "@/components/MovieDialog.vue";
import ColorPickerMenu from "@/components/ColorPickerMenu.vue";
import store from "@/store";
import progress from "@/store/progress";
import geojs from "geojs";
import { formatDate } from "@/utils/date";
import { downloadToClient } from "@/utils/download";
import GIF from "gif.js";
import {
  IDatasetLocation,
  IDisplayLayer,
  IGeoJSAnnotation,
  IGeoJSAnnotationLayer,
  IGeoJSBounds,
  IGeoJSMap,
  ISnapshot,
  copyLayerWithoutPrivateAttributes,
  ProgressType,
  TUnitLength,
} from "@/store/model";
import { DeflateOptions, Zip, ZipDeflate } from "fflate";
import girderResources from "@/store/girderResources";
import {
  getChannelsDownloadUrls,
  getDownloadParameters,
  getLayersDownloadUrls,
  getBaseURLFromDownloadParameters,
} from "@/utils/screenshot";
import { logError } from "@/utils/log";

interface ISnapshotItem {
  name: string;
  datasetName: string;
  key: string;
  record: ISnapshot;
  modified: string;
}

function intFromString(value: string) {
  const parsedValue = parseInt("0" + value, 10);
  return Number.isNaN(parsedValue) ? 0 : parsedValue;
}

interface IGifOptions extends GIF.Options {
  workerOptions?: {
    willReadFrequently: boolean;
  };
}

// This interface is similar to IScaleInformation<TUnitLength>,
// but it allows for "px" as a unit.
interface IScalebarSettings {
  length: number;
  unit: TScalebarUnit;
}

/**
 * Get the best supported video MIME type for the current browser.
 * Prioritizes MP4 (H.264) for broad compatibility, falls back to WebM for Firefox.
 */
function getSupportedVideoMimeType(preferMp4: boolean): string | null {
  const mp4Types = [
    'video/mp4; codecs="avc1.42E01E,mp4a.40.2"', // H.264 Baseline + AAC
    "video/mp4", // Let browser choose MP4 codecs
  ];
  const webmTypes = [
    'video/webm; codecs="vp9,opus"', // WebM with VP9
    'video/webm; codecs="vp8,opus"', // Older WebM fallback
    "video/webm",
  ];

  const types = preferMp4 ? mp4Types : webmTypes;
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || null;
}

/**
 * Get file extension from MIME type.
 */
function getVideoFileExtension(mimeType: string): string {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("webm")) return "webm";
  return "video";
}

// --- Props ---

const props = defineProps<{
  snapshotVisible: boolean;
}>();

// --- Template ref ---

const saveSnapshotForm = ref<HTMLFormElement | null>(null);

// --- Data (refs) ---

const movieDialog = ref(false);
const jpegQuality = ref<number | string>(95);
const downloading = ref(false);
const imageTooBigDialog = ref(false);
const createDialog = ref(false);
const newName = ref("");
const newDescription = ref("");
const newTags = ref<string[]>([]);
const isSaveSnapshotValid = ref(true);
const selectedSnapshotItems = ref<ISnapshotItem[]>([]);
const snapshotSearch = ref("");
const bboxLeft = ref(0);
const bboxTop = ref(0);
const bboxRight = ref(0);
const bboxBottom = ref(0);
const bboxLayer = ref<IGeoJSAnnotationLayer | null>(null);
const bboxAnnotation = ref<IGeoJSAnnotation | null>(null);
const scalebarAnnotation = ref<IGeoJSAnnotation | null>(null);
const downloadMode = ref<"layers" | "channels">("layers");
const exportLayer = ref<string>("composite");
const exportChannel = ref<"all" | number>("all");
const format = ref("png");
const layersOverwritePanel = ref(false);
const overwrittingSnaphot = ref<ISnapshot | null>(null);
const addScalebar = ref(true);
const addScalebarText = ref(true);
const scalebarSettingsDialog = ref(false);
const snapshotScalebarColor = ref("#ffffff");
const manualScalebarSettings = ref<IScalebarSettings | null>(null);
const manualPixelSize = ref<IScalebarSettings | null>(null);
const addAnnotationsToMovie = ref(false);
const pixelSizeMode = ref<PixelSizeMode>(PixelSizeMode.DATASET);
const scalebarMode = ref<ScalebarMode>(ScalebarMode.AUTOMATIC);

// --- Constants ---

const tableHeaders: {
  text: string;
  value: string;
  sortable: boolean;
  sort?: (a: any, b: any) => number;
  class?: string;
}[] = [
  { text: "Name", value: "name", sortable: true, class: "text-no-wrap" },
  {
    text: "Dataset",
    value: "datasetName",
    sortable: true,
    class: "text-no-wrap",
  },
  {
    text: "Timestamp",
    value: "modified",
    sortable: true,
    sort: (a: any, b: any) => Date.parse(a) - Date.parse(b),
    class: "text-no-wrap",
  },
  { text: "Tags", value: "tags", sortable: false, class: "text-no-wrap" },
  { text: "Delete", value: "delete", sortable: false },
];

const maxPixels = 4_000_000;

const nameRules = [(name: string) => !!name.trim() || "Name is required"];

// --- Computed properties ---

const isLoggedIn = computed(() => store.isLoggedIn);

const formatList = computed(() => {
  if (downloadMode.value === "layers") {
    return [
      { text: "PNG", value: "png" },
      { text: "JPEG", value: "jpeg" },
      { text: "TIFF", value: "tiff" },
      { text: "TIFF - Tiled (for huge images)", value: "tiled" },
    ];
  }
  if (downloadMode.value === "channels") {
    return [
      { text: "TIFF", value: "tiff" },
      { text: "TIFF - Tiled (for huge images)", value: "tiled" },
    ];
  }
  return [{ text: "Unknown download mode", value: "" }];
});

const bboxWidth = computed({
  get: (): number => {
    return (bboxRight.value || 0) - (bboxLeft.value || 0);
  },
  set: (value: string | number) => {
    if (typeof value == "string") {
      bboxRight.value = (bboxLeft.value || 0) + intFromString(value);
    } else {
      bboxRight.value = value;
    }
  },
});

const bboxHeight = computed({
  get: (): number => {
    return (bboxBottom.value || 0) - (bboxTop.value || 0);
  },
  set: (value: string | number) => {
    if (typeof value == "string") {
      bboxBottom.value = (bboxTop.value || 0) + intFromString(value);
    } else {
      bboxBottom.value = value;
    }
  },
});

const unroll = computed(() => store.unroll);

const geoJSMaps = computed(() => store.maps.map((map) => map.map));

const firstMap = computed((): IGeoJSMap | undefined => geoJSMaps.value[0]);

const layerItems = computed(() => {
  const results: { text: string; value: string }[] = [
    { text: "Composite layers", value: "composite" },
    { text: "All layers (zip)", value: "all" },
  ];
  store.layers.forEach((layer) => {
    if (layer.visible) {
      results.push({ text: layer.name, value: layer.id });
    }
  });
  return results;
});

const channelItems = computed(() => {
  const results: { text: string; value: string | number }[] = [
    { text: "All channels", value: "all" },
  ];
  if (store.dataset) {
    store.dataset.channels.forEach((channel) => {
      results.push({
        text: store.dataset!.channelNames.get(channel) || "Channel " + channel,
        value: channel,
      });
    });
  }
  return results;
});

const manualScalebarSettingsLength = computed({
  get: (): number => manualScalebarSettings.value?.length || 1.0,
  set: (value: number) => {
    if (manualScalebarSettings.value) {
      manualScalebarSettings.value.length = value;
    }
  },
});

const manualScalebarSettingsUnit = computed({
  get: (): TScalebarUnit =>
    manualScalebarSettings.value?.unit || TScalebarUnit.PX,
  set: (value: TScalebarUnit) => {
    if (manualScalebarSettings.value) {
      manualScalebarSettings.value.unit = value;
    }
  },
});

const manualPixelSizeLength = computed({
  get: (): number => manualPixelSize.value?.length || 1.0,
  set: (value: number) => {
    if (manualPixelSize.value) {
      manualPixelSize.value.length = value;
    }
  },
});

const manualPixelSizeUnit = computed({
  get: (): TScalebarUnit => manualPixelSize.value?.unit || TScalebarUnit.PX,
  set: (value: TScalebarUnit) => {
    if (manualPixelSize.value) {
      manualPixelSize.value.unit = value;
    }
  },
});

const configurationPixelSize = computed((): IScalebarSettings => {
  const scale = store.configuration?.scales.pixelSize;
  if (!scale) {
    return { length: 1.0, unit: TScalebarUnit.PX };
  }
  if (scale.value === 0) {
    return { length: 1.0, unit: TScalebarUnit.PX };
  }
  return { length: scale.value, unit: scale.unit as TScalebarUnit };
});

const formattedConfigurationPixelSize = computed((): string => {
  return prettyScalebarSettings(configurationPixelSize.value);
});

const formattedScalebarSettings = computed((): string => {
  return prettyScalebarSettings(scalebarSettings.value);
});

const pixelSize = computed((): IScalebarSettings => {
  if (pixelSizeMode.value === "manual" && manualPixelSize.value) {
    return manualPixelSize.value;
  }
  return configurationPixelSize.value;
});

const idealScalebarLength = computed(() => {
  const ps = pixelSize.value;
  if (ps.unit === TScalebarUnit.PX) {
    return guessIdealScalebar(bboxRight.value - bboxLeft.value, ps.length);
  }
  const pixelLengthInMeters = convertLengthToMeters(ps.length, ps.unit);
  return guessIdealScalebar(
    bboxRight.value - bboxLeft.value,
    pixelLengthInMeters,
  );
});

const scalebarSettings = computed((): IScalebarSettings => {
  if (scalebarMode.value === "manual" && manualScalebarSettings.value) {
    return manualScalebarSettings.value;
  }
  const idealScalebar = idealScalebarLength.value;
  if (!idealScalebar) {
    return { length: 1.0, unit: TScalebarUnit.PX };
  } else {
    if (pixelSize.value.unit === TScalebarUnit.PX) {
      return { length: idealScalebar, unit: TScalebarUnit.PX };
    }
    return convertMetersToLength(idealScalebar);
  }
});

const scalebarLengthInPixels = computed((): number => {
  if (scalebarSettings.value.unit === TScalebarUnit.PX) {
    return scalebarSettings.value.length;
  }
  const ps = pixelSize.value;
  if (ps.unit === TScalebarUnit.PX) {
    return scalebarSettings.value.length;
  }
  const pixelLengthInMeters = convertLengthToMeters(ps.length, ps.unit);
  const scalebarLengthInMeters = convertLengthToMeters(
    scalebarSettings.value.length,
    scalebarSettings.value.unit,
  );
  return scalebarLengthInMeters / pixelLengthInMeters;
});

const snapshotList = computed(() => {
  const sre = new RegExp(snapshotSearch.value || "", "i");
  const results: ISnapshotItem[] = [];
  if (store.configuration && store.configuration.snapshots) {
    const snapshots = store.configuration.snapshots.slice();
    snapshots.sort(
      (a: ISnapshot, b: ISnapshot) =>
        (b.modified || b.created) - (a.modified || a.created),
    );
    snapshots.forEach((s: ISnapshot) => {
      if (
        sre.exec(s.name) ||
        sre.exec(s.description) ||
        s.tags.some((t: string) => sre.exec(t))
      ) {
        const item = {
          name: s.name,
          datasetName: "",
          key: s.name,
          record: s,
          modified: formatDate(new Date(s.modified || s.created)),
        };
        results.push(item);

        let datasetViewPromise;
        if (store.datasetView?.id === s.datasetViewId) {
          datasetViewPromise = Promise.resolve(store.datasetView);
        } else {
          datasetViewPromise = store.api.getDatasetView(s.datasetViewId);
        }
        datasetViewPromise
          .then(({ datasetId }) =>
            girderResources.getDataset({ id: datasetId }),
          )
          .then((dataset) => {
            item.datasetName = dataset?.name || "Unknown dataset";
          });
      }
    });
  }
  return results;
});

const currentSnapshot = computed((): { [key: string]: any } | undefined => {
  if (store.configuration && store.configuration.snapshots) {
    return store.configuration.snapshots
      .slice()
      .filter((s: ISnapshot) => s.name === newName.value)[0];
  }
  return;
});

const pixelSizeUnitItems = computed(() => {
  return [
    { text: "Nanometers (nm)", value: TScalebarUnit.NM },
    { text: "Micrometers (µm)", value: TScalebarUnit.UM },
    { text: "Millimeters (mm)", value: TScalebarUnit.MM },
    { text: "Meters (m)", value: TScalebarUnit.M },
    { text: "Pixels (px)", value: TScalebarUnit.PX },
  ];
});

const scalebarSettingsUnitItems = computed(() => {
  if (pixelSize.value.unit === "px") {
    return [{ text: "Pixels (px)", value: TScalebarUnit.PX }];
  }
  return [
    { text: "Nanometers (nm)", value: TScalebarUnit.NM },
    { text: "Micrometers (µm)", value: TScalebarUnit.UM },
    { text: "Millimeters (mm)", value: TScalebarUnit.MM },
    { text: "Meters (m)", value: TScalebarUnit.M },
    { text: "Pixels (px)", value: TScalebarUnit.PX },
  ];
});

// --- Functions ---

function isRotated(): boolean {
  return geoJSMaps.value.some((map) => !!map.rotation());
}

function unitLengthToScalebarUnit(unit: TUnitLength): TUnitLength {
  switch (unit) {
    case "nm":
      return TScalebarUnit.NM;
    case "µm":
      return TScalebarUnit.UM;
    case "mm":
      return TScalebarUnit.MM;
    case "m":
      return TScalebarUnit.M;
  }
}

function convertLengthToMeters(length: number, unit: TUnitLength): number {
  switch (unit) {
    case TScalebarUnit.NM:
      return length * 1e-9;
    case TScalebarUnit.UM:
      return length * 1e-6;
    case TScalebarUnit.MM:
      return length * 1e-3;
    case TScalebarUnit.M:
      return length;
    default:
      return length;
  }
}

function convertMetersToLength(length: number): IScalebarSettings {
  if (length < 1e-6) {
    return { length: length * 1e9, unit: TScalebarUnit.NM };
  }
  if (length < 1e-3) {
    return { length: length * 1e6, unit: TScalebarUnit.UM };
  }
  if (length < 1) {
    return { length: length * 1e3, unit: TScalebarUnit.MM };
  }
  return { length: length, unit: TScalebarUnit.M };
}

function guessIdealScalebar(
  imageWidthPixels: number,
  distancePerPixel: number,
): number | null {
  if (imageWidthPixels <= 0 || distancePerPixel <= 0) {
    return null;
  }
  const roundToSignificant = (num: number, sigDigits: number = 10): number => {
    if (num === 0) return 0;
    const magnitude = Math.floor(Math.log10(Math.abs(num)));
    const scale = Math.pow(10, sigDigits - magnitude - 1);
    return Math.round(num * scale) / scale;
  };

  const units = [
    { unit: TScalebarUnit.NM, scale: 1e-9 },
    { unit: TScalebarUnit.UM, scale: 1e-6 },
    { unit: TScalebarUnit.MM, scale: 1e-3 },
    { unit: TScalebarUnit.M, scale: 1 },
  ];

  const preferredMultiples = [1, 2, 5, 10];

  const minPixels = imageWidthPixels * 0.05;
  const maxPx = imageWidthPixels * 0.25;
  const targetPixels = (minPixels + maxPx) / 2;

  const targetDistance = targetPixels * distancePerPixel;

  let selectedUnit = units[0];
  for (const unit of units) {
    if (targetDistance >= unit.scale / 10) {
      selectedUnit = unit;
    } else {
      break;
    }
  }

  const targetInUnits = targetDistance / selectedUnit.scale;

  const power = Math.floor(Math.log10(targetInUnits));

  let bestValue = null;
  let bestDiff = Infinity;

  for (let p = power - 1; p <= power + 1; p++) {
    for (const multiple of preferredMultiples) {
      const value = multiple * Math.pow(10, p);
      const physicalDistance = value * selectedUnit.scale;
      const pixels = physicalDistance / distancePerPixel;

      if (pixels >= minPixels * 0.8 && pixels <= maxPx * 1.2) {
        const diff = Math.abs(pixels - targetPixels);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestValue = physicalDistance;
        }
      }
    }
  }

  if (!bestValue) {
    const value = Math.pow(10, Math.floor(Math.log10(targetInUnits)));
    bestValue = value * selectedUnit.scale;
  }

  return roundToSignificant(bestValue);
}

function prettyScalebarSettings(settings: IScalebarSettings): string {
  if (settings.unit === TScalebarUnit.PX) {
    return `${settings.length} px`;
  }
  const length = convertLengthToMeters(settings.length, settings.unit);
  const printSettings = convertMetersToLength(length);
  return `${printSettings.length.toFixed(1)} ${printSettings.unit}`;
}

function handlePixelSizeModeChange() {
  if (pixelSizeMode.value === "manual") {
    manualPixelSize.value = configurationPixelSize.value;
  }
}

function handleScalebarModeChange() {
  if (scalebarMode.value === "manual") {
    manualScalebarSettings.value = scalebarSettings.value;
  }
}

function setBoundingBox(
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  const w = store.dataset!.width;
  const h = store.dataset!.height;
  bboxLeft.value = Math.min(w - 1, Math.max(0, Math.round(left)));
  bboxRight.value = Math.max(
    bboxLeft.value + 1,
    Math.min(w, Math.round(right)),
  );
  bboxTop.value = Math.min(h - 1, Math.max(0, Math.round(top)));
  bboxBottom.value = Math.max(
    bboxTop.value + 1,
    Math.min(h, Math.round(bottom)),
  );
}

function showSnapshot(show: boolean) {
  const map = firstMap.value;
  if (!map) {
    return;
  }
  if (bboxHeight.value <= 0 && bboxWidth.value <= 0) {
    const topLeft = map.displayToGcs({ x: 0, y: 0 });
    const bottomRight = map.displayToGcs({
      x: map.size().width,
      y: map.size().height,
    });
    const insetX = (bottomRight.x - topLeft.x) / 3;
    const insetY = (bottomRight.y - topLeft.y) / 3;
    bboxLeft.value = topLeft.x + insetX;
    bboxTop.value = topLeft.y + insetY;
    bboxRight.value = bottomRight.x - insetX;
    bboxBottom.value = bottomRight.y - insetY;
  }
  if (show && map) {
    const bounds = map.bounds();
    const screenBounds = map.gcsToDisplay([
      { x: bounds.left, y: bounds.top },
      { x: bounds.right, y: bounds.bottom },
    ]);
    const insetX = (screenBounds[1].x - screenBounds[0].x) / 3;
    const insetY = (screenBounds[1].y - screenBounds[0].y) / 3;
    const innerBounds = map.displayToGcs([
      { x: screenBounds[0].x + insetX, y: screenBounds[0].y + insetY },
      { x: screenBounds[1].x - insetX, y: screenBounds[1].y - insetY },
    ]);
    setBoundingBox(
      innerBounds[0].x,
      innerBounds[0].y,
      innerBounds[1].x,
      innerBounds[1].y,
    );

    if (!bboxLayer.value) {
      bboxLayer.value = map.createLayer("annotation", {
        autoshareRenderer: false,
        showLabels: false,
      });

      bboxAnnotation.value = geojs.annotation.rectangleAnnotation({
        layer: bboxLayer.value,
        corners: [
          { x: bboxLeft.value, y: bboxTop.value },
          { x: bboxRight.value, y: bboxTop.value },
          { x: bboxRight.value, y: bboxBottom.value },
          { x: bboxLeft.value, y: bboxBottom.value },
        ],
        editHandleStyle: {
          strokeColor: { r: 1, g: 0, b: 0 },
          handles: { rotate: false },
        },
        editStyle: {
          fillOpacity: 0,
          strokeColor: { r: 1, g: 0, b: 0 },
          strokeWidth: 2,
        },
        style: {
          fillOpacity: 0,
          strokeColor: { r: 1, g: 0, b: 0 },
          strokeWidth: 2,
        },
      }) as IGeoJSAnnotation;

      scalebarAnnotation.value = geojs.annotation.lineAnnotation({
        vertices: scalebarVertices(bboxRight.value, bboxBottom.value),
        layer: bboxLayer.value,
        style: {
          strokeColor: snapshotScalebarColor.value,
          strokeWidth: 3,
          strokeOpacity: 1,
        },
      });

      bboxLayer.value.addAnnotation(bboxAnnotation.value);
      bboxLayer.value.addAnnotation(scalebarAnnotation.value);
      map.draw();
    }
  } else {
    if (bboxLayer.value) {
      doneBoundingBox(true);
      map.deleteLayer(bboxLayer.value);
      bboxLayer.value = null;
      bboxAnnotation.value = null;
      scalebarAnnotation.value = null;
      map.draw();
    }
  }
}

function markCurrentArea() {
  const dataset = store.dataset;
  if (!dataset) {
    return;
  }
  const w = dataset.width;
  const h = dataset.height;
  let coordinates = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  coordinates = [
    { x: bboxLeft.value, y: bboxTop.value },
    { x: bboxRight.value, y: bboxTop.value },
    { x: bboxRight.value, y: bboxBottom.value },
    { x: bboxLeft.value, y: bboxBottom.value },
  ];
  const map = firstMap.value;
  if (
    bboxLayer.value &&
    bboxAnnotation.value &&
    scalebarAnnotation.value &&
    map
  ) {
    bboxLayer.value.visible(true);
    coordinates = geojs.transform.transformCoordinates(
      map.ingcs(),
      map.gcs(),
      coordinates,
    );
    bboxAnnotation.value.options("corners", coordinates);
    if (bboxLayer.value.currentAnnotation) {
      bboxLayer.value.currentAnnotation.options("corners", coordinates);
    }

    scalebarAnnotation.value.options({
      vertices: scalebarVertices(coordinates[2].x, coordinates[2].y),
    });

    bboxLayer.value.draw();
  }
  return w * h;
}

function scalebarVertices(rightEdge: number, bottomEdge: number) {
  return [
    { x: rightEdge - 10, y: bottomEdge + 10 },
    {
      x: rightEdge - 10 - scalebarLengthInPixels.value,
      y: bottomEdge + 10,
    },
  ];
}

function setArea(mode: string) {
  const map = firstMap.value;
  if (!map) {
    return;
  }
  if (mode === "full" && store.dataset) {
    setBoundingBox(0, 0, store.dataset.width, store.dataset.height);
  } else if (mode === "viewport" && map && store.dataset) {
    const bounds = map.bounds();
    setBoundingBox(bounds.left, bounds.top, bounds.right, bounds.bottom);
  }
  markCurrentArea();
}

function drawBoundingBox() {
  if (bboxLayer.value && bboxAnnotation.value) {
    bboxLayer.value.mode(null);
    bboxLayer.value.mode(bboxLayer.value.modes.edit, bboxAnnotation.value);
    bboxLayer.value.draw();
  }
  const map = firstMap.value;
  if (!map) {
    return;
  }
  map.geoOff(geojs.event.annotation.mode, doneBoundingBox);
  map.geoOff(geojs.event.annotation.coordinates, boundingBoxCoordinates);
  map.geoOn(geojs.event.annotation.mode, doneBoundingBox);
  map.geoOn(geojs.event.annotation.coordinates, boundingBoxCoordinates);
  markCurrentArea();
}

function boundingBoxCoordinates(event: { [key: string]: any }) {
  const coord = event.annotation!.coordinates();
  if (event.annotation === bboxAnnotation.value && coord.length === 4) {
    setBoundingBox(
      Math.min(coord[0].x, coord[2].x),
      Math.min(coord[0].y, coord[2].y),
      Math.max(coord[0].x, coord[2].x),
      Math.max(coord[0].y, coord[2].y),
    );
  }
}

function doneBoundingBox(allDone: boolean) {
  const map = firstMap.value;
  if (!map) {
    return;
  }
  map.geoOff(geojs.event.annotation.mode, doneBoundingBox);
  map.geoOff(geojs.event.annotation.coordinates, boundingBoxCoordinates);
  const coord = bboxAnnotation.value?.coordinates();
  if (coord && coord.length === 4) {
    setBoundingBox(
      Math.min(coord[0].x, coord[2].x),
      Math.min(coord[0].y, coord[2].y),
      Math.max(coord[0].x, coord[2].x),
      Math.max(coord[0].y, coord[2].y),
    );
  }
  if (bboxLayer.value) {
    if (bboxLayer.value.map().interactor()) {
      bboxLayer.value.mode(null);
    }
    bboxLayer.value.draw();
  }
  if (allDone !== true) {
    drawBoundingBox();
  }
}

function areCurrentLayersCompatible(snapshot: ISnapshot) {
  const currentLayers = store.layers;
  return snapshot.layers.every((snapshotLayer) => {
    const storeLayer = currentLayers.find(
      (layer) => layer.id === snapshotLayer.id,
    );
    return !!storeLayer && storeLayer.channel === snapshotLayer.channel;
  });
}

function openConfigurationLayersOverwritePanel(snapshot: ISnapshot) {
  layersOverwritePanel.value = true;
  overwrittingSnaphot.value = snapshot;
}

function changeDatasetViewContrasts() {
  if (overwrittingSnaphot.value) {
    store.loadSnapshotLayers(overwrittingSnaphot.value);
    overwrittingSnaphot.value = null;
  }
  layersOverwritePanel.value = false;
}

function overwriteConfigurationLayers() {
  const layers = overwrittingSnaphot.value?.layers;
  if (layers) {
    store.setConfigurationLayers(layers);
    overwrittingSnaphot.value = null;
    store.resetDatasetViewContrasts();
  }
  layersOverwritePanel.value = false;
}

async function loadSnapshot(item: ISnapshotItem) {
  const snapshot = item.record;
  if (
    snapshot.datasetViewId &&
    snapshot.datasetViewId !== store.datasetView?.id
  ) {
    await store.setDatasetViewId(snapshot.datasetViewId);
  }
  if (areCurrentLayersCompatible(snapshot)) {
    await store.loadSnapshotLayers(snapshot);
  } else {
    openConfigurationLayersOverwritePanel(snapshot);
  }
  newName.value = snapshot.name || "";
  newDescription.value = snapshot.description || "";
  newTags.value = (snapshot.tags || []).slice();
  bboxLeft.value = snapshot.screenshot!.bbox!.left;
  bboxTop.value = snapshot.screenshot!.bbox!.top;
  bboxRight.value = snapshot.screenshot!.bbox!.right;
  bboxBottom.value = snapshot.screenshot!.bbox!.bottom;

  await Promise.all([
    store.setXY(snapshot.xy),
    store.setZ(snapshot.z),
    store.setTime(snapshot.time),

    store.setUnrollXY(snapshot.unrollXY),
    store.setUnrollZ(snapshot.unrollZ),
    store.setUnrollT(snapshot.unrollT),

    store.setConfigurationLayers(snapshot.layers),
    store.setLayerMode(snapshot.layerMode),
  ]);

  const map = firstMap.value;
  if (!map) {
    return;
  }
  map.bounds({
    left: Math.min(
      snapshot.viewport.tl.x,
      snapshot.viewport.tr.x,
      snapshot.viewport.bl.x,
      snapshot.viewport.tr.x,
    ),
    right: Math.max(
      snapshot.viewport.tl.x,
      snapshot.viewport.tr.x,
      snapshot.viewport.bl.x,
      snapshot.viewport.tr.x,
    ),
    top: Math.min(
      snapshot.viewport.tl.y,
      snapshot.viewport.tr.y,
      snapshot.viewport.bl.y,
      snapshot.viewport.tr.y,
    ),
    bottom: Math.max(
      snapshot.viewport.tl.y,
      snapshot.viewport.tr.y,
      snapshot.viewport.bl.y,
      snapshot.viewport.tr.y,
    ),
  });
  map.rotation(snapshot.rotation || 0);
  markCurrentArea();
}

function updateFormValidation() {
  const formElem = saveSnapshotForm.value;
  if (formElem) {
    isSaveSnapshotValid.value = formElem.validate();
  }
}

function resetFormValidation() {
  const formElem = saveSnapshotForm.value;
  if (formElem) {
    formElem.resetValidation();
  }
}

function saveSnapshot(): void {
  updateFormValidation();
  const map = firstMap.value;
  const datasetView = store.datasetView;
  if (!isSaveSnapshotValid.value || !map || !datasetView) {
    return;
  }
  const snapshot: ISnapshot = {
    name: newName.value.trim(),
    description: newDescription.value.trim(),
    tags: newTags.value.slice(),
    created: currentSnapshot.value ? currentSnapshot.value.created : Date.now(),
    datasetViewId: datasetView.id,
    modified: Date.now(),
    viewport: {
      tl: map.displayToGcs({ x: 0, y: 0 }),
      tr: map.displayToGcs({ x: map.size().width, y: 0 }),
      bl: map.displayToGcs({ x: 0, y: map.size().height }),
      br: map.displayToGcs({ x: map.size().width, y: map.size().height }),
    },
    rotation: map.rotation(),
    unrollXY: store.unrollXY,
    unrollZ: store.unrollZ,
    unrollT: store.unrollT,
    xy: store.xy,
    z: store.z,
    time: store.time,
    layerMode: store.layerMode,
    layers: store.layers.map(copyLayerWithoutPrivateAttributes),
    screenshot: {
      bbox: {
        left: bboxLeft.value,
        top: bboxTop.value,
        right: bboxRight.value,
        bottom: bboxBottom.value,
      },
    },
  };
  resetAndCloseForm();
  store.addSnapshot(snapshot);
}

function resetAndCloseForm() {
  createDialog.value = false;
  newName.value = "";
  newDescription.value = "";
  newTags.value = [];
  resetFormValidation();
}

function removeSnapshot(name: string): void {
  store.removeSnapshot(name);
}

async function screenshotViewport() {
  const map = firstMap.value;
  if (!map) {
    return;
  }
  const layers = map
    .layers()
    .filter(
      (layer) =>
        layer !== bboxLayer.value &&
        layer.node().css("visibility") !== "hidden",
    );
  map.screenshot(layers).then((image: string) => {
    const params = {
      href: image,
      download: "viewport_screenshot.png",
    };
    downloadToClient(params);
  });
}

async function snapshotWithAnnotations() {
  const map = firstMap.value;
  if (!map) {
    return;
  }

  const layers = map
    .layers()
    .filter(
      (layer) =>
        layer !== bboxLayer.value &&
        layer.node().css("visibility") !== "hidden",
    );

  const fullScreenshot = await map.screenshot(layers);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  const img = new Image();

  await new Promise((resolve) => {
    img.onload = resolve;
    img.src = fullScreenshot;
  });

  const topLeft = map.gcsToDisplay({
    x: bboxLeft.value,
    y: bboxTop.value,
  });
  const bottomRight = map.gcsToDisplay({
    x: bboxRight.value,
    y: bboxBottom.value,
  });

  const width = bottomRight.x - topLeft.x;
  const height = bottomRight.y - topLeft.y;

  canvas.width = width;
  canvas.height = height;

  ctx.drawImage(img, topLeft.x, topLeft.y, width, height, 0, 0, width, height);

  if (addScalebar.value) {
    drawScalebarOnCanvas(ctx, canvas.width, canvas.height);
  }

  const croppedScreenshot = canvas.toDataURL("image/png");

  const params = {
    href: croppedScreenshot,
    download: "viewport_screenshot.png",
  };
  downloadToClient(params);
}

async function downloadImagesForCurrentState() {
  const datasetId = store.dataset?.id;
  if (!datasetId) {
    return;
  }
  const location = store.currentLocation;
  const boundingBox = {
    left: bboxLeft.value,
    top: bboxTop.value,
    right: bboxRight.value,
    bottom: bboxBottom.value,
  };

  downloading.value = true;

  const configuration = store.configuration;
  if (!configuration) {
    return;
  }

  try {
    const urls = await getUrlsForSnapshot(
      location,
      boundingBox,
      datasetId,
      newName.value,
      configuration.layers,
      configuration.name,
    );
    if (!urls) {
      return;
    }
    await downloadUrls(urls, addScalebar.value);
  } finally {
    downloading.value = false;
  }
}

async function downloadImagesForAllSnapshots() {
  const configuration = store.configuration;
  if (!configuration) {
    return;
  }
  const snapshots = configuration.snapshots || [];
  await downloadImagesForSetOfSnapshots(snapshots);
}

async function downloadImagesForSelectedSnapshots() {
  const configuration = store.configuration;
  if (!configuration) {
    return;
  }
  const selected = selectedSnapshotItems.value.map((s) => s.record);
  await downloadImagesForSetOfSnapshots(selected);
}

async function downloadImagesForSetOfSnapshots(snapshots: ISnapshot[]) {
  downloading.value = true;

  const progressId = await progress.create({
    type: ProgressType.SNAPSHOT_BATCH_DOWNLOAD,
    title: "Downloading snapshot images",
  });

  try {
    const configuration = store.configuration;
    if (!configuration) {
      return;
    }

    const allUrls: URL[] = [];
    const totalSnapshots = snapshots.length;

    for (let i = 0; i < totalSnapshots; i++) {
      const snapshot = snapshots[i];

      progress.update({
        id: progressId,
        progress: i,
        total: totalSnapshots,
        title: `Processing snapshot ${i + 1} of ${totalSnapshots}`,
      });

      const datasetView = await store.api.getDatasetView(
        snapshot.datasetViewId,
      );
      const currentUrls = await getUrlsForSnapshot(
        snapshot,
        snapshot.screenshot.bbox,
        datasetView.datasetId,
        snapshot.name,
        snapshot.layers,
        configuration.name,
      );
      if (currentUrls) {
        allUrls.push(...currentUrls);
      }
    }

    progress.update({
      id: progressId,
      progress: totalSnapshots,
      total: totalSnapshots,
      title: "Downloading files...",
    });

    await downloadUrls(allUrls, addScalebar.value);
  } finally {
    progress.complete(progressId);
    downloading.value = false;
  }
}

async function getUrlsForSnapshot(
  location: IDatasetLocation,
  boundingBox: IGeoJSBounds,
  datasetId: string,
  name: string,
  layers: IDisplayLayer[],
  configurationName: string,
) {
  const dataset =
    store.dataset?.id === datasetId
      ? store.dataset
      : await girderResources.getDataset({ id: datasetId });
  if (!dataset) {
    return;
  }

  const anyImage = dataset.anyImage();
  if (!anyImage) {
    return;
  }
  const itemId = anyImage.item._id;

  const dateStr = formatDate(new Date());
  const extension = format.value === "tiled" ? "tiff" : format.value;

  const jpegQualityNum =
    typeof jpegQuality.value !== "number"
      ? Number(jpegQuality.value)
      : jpegQuality.value;
  const params = getDownloadParameters(
    boundingBox,
    format.value,
    maxPixels,
    jpegQualityNum,
    downloadMode.value,
  );
  if (params === null) {
    imageTooBigDialog.value = true;
    return;
  }
  const apiRoot = store.girderRest.apiRoot;
  const baseUrl = getBaseURLFromDownloadParameters(params, itemId, apiRoot);

  const urls: URL[] = [];
  if (downloadMode.value === "channels") {
    const channelUrls = getChannelsDownloadUrls(
      baseUrl,
      exportChannel.value,
      dataset,
      location,
    );
    for (const { url, channel } of channelUrls) {
      const channelName =
        dataset.channelNames.get(channel) ?? "Unknown channel";
      const fileName = `${name} - ${channelName} - ${dataset.name} - ${configurationName} - ${dateStr}.${extension}`;
      url.searchParams.set("contentDispositionFilename", fileName);
      urls.push(url);
    }
  } else {
    const layerUrls = await getLayersDownloadUrls(
      baseUrl,
      exportLayer.value,
      layers,
      dataset,
      location,
    );
    for (const { url, layerIds } of layerUrls) {
      const layerNames = layerIds.map(
        (layerId) =>
          layers.find((layer) => layer.id === layerId)?.name ?? "Unknown layer",
      );
      const fileName = `${name} - ${layerNames.join(" ")} - ${dataset.name} - ${configurationName} - ${dateStr}.${extension}`;
      url.searchParams.set("contentDispositionFilename", fileName);
      urls.push(url);
    }
  }

  return urls;
}

async function addScalebarToImageBuffer(
  data: ArrayBuffer,
): Promise<ArrayBuffer> {
  const blob = new Blob([data], { type: "image/png" });
  const imageUrl = URL.createObjectURL(blob);

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = imageUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get canvas context");

  ctx.drawImage(img, 0, 0);

  drawScalebarOnCanvas(ctx, canvas.width, canvas.height);

  URL.revokeObjectURL(imageUrl);

  const annotatedBlob = await new Promise<Blob>((resolve) => {
    canvas.toBlob((blob) => resolve(blob!), "image/png");
  });
  return await annotatedBlob.arrayBuffer();
}

async function downloadUrls(urls: URL[], withScalebar: boolean = false) {
  if (urls.length <= 0) {
    return;
  }

  if (urls.length === 1) {
    if (withScalebar) {
      const { data } = await store.girderRest.get(urls[0].href, {
        responseType: "arraybuffer",
      });
      const processedData = await addScalebarToImageBuffer(data);
      const blob = new Blob([processedData], { type: "image/png" });
      const url = URL.createObjectURL(blob);
      const filename =
        urls[0].searchParams.get("contentDispositionFilename") ||
        "snapshot.png";
      downloadToClient({
        href: url,
        download: filename,
      });
      URL.revokeObjectURL(url);
    } else {
      downloadToClient({ href: urls[0].href });
    }
    return;
  }

  const zip: Zip = new Zip();
  const zipChunks: Uint8Array[] = [];
  const zipDone: Promise<Blob> = new Promise((resolve, reject) => {
    zip.ondata = (err: Error | null, data: Uint8Array, final: boolean) => {
      if (!err) {
        zipChunks.push(data);
        if (final) {
          resolve(new Blob(zipChunks));
        }
      } else {
        reject(err);
      }
    };
  });

  const deflateOptions: DeflateOptions = {
    level: ["jpeg", "png"].includes(format.value) ? 0 : 9,
  };
  const filenames: Set<string> = new Set();
  const filesPushed = urls.map(async (url) => {
    const { data } = await store.girderRest.get(url.href, {
      responseType: "arraybuffer",
    });

    const finalData = withScalebar
      ? await addScalebarToImageBuffer(data)
      : data;

    const baseFullFilename =
      url.searchParams.get("contentDispositionFilename") || "snapshot";
    let fileName = baseFullFilename;
    let pointIdx = Math.max(baseFullFilename.lastIndexOf("."), 0);
    const baseName = baseFullFilename.slice(0, pointIdx);
    const extension = baseFullFilename.slice(pointIdx);
    for (let counter = 1; filenames.has(fileName); counter++) {
      fileName = baseName + " (" + counter + ")" + extension;
    }
    filenames.add(fileName);
    const zipFile = new ZipDeflate(fileName, deflateOptions);
    zip.add(zipFile);
    zipFile.push(new Uint8Array(finalData), true);
  });

  await Promise.all(filesPushed);
  zip.end();

  const blob = await zipDone;
  const dataURL = URL.createObjectURL(blob);
  const params = {
    href: dataURL,
    download: "snapshot.zip",
  };
  downloadToClient(params);
}

async function getUrlsForMovie(
  timePoints: number[],
  datasetId: string,
  boundingBox: IGeoJSBounds,
  layers: IDisplayLayer[],
  location: IDatasetLocation,
): Promise<URL[]> {
  const dataset =
    store.dataset?.id === datasetId
      ? store.dataset
      : await girderResources.getDataset({ id: datasetId });
  if (!dataset) {
    throw new Error("Dataset not found");
  }

  const anyImage = dataset.anyImage();
  if (!anyImage) {
    throw new Error("No image found in dataset");
  }
  const itemId = anyImage.item._id;

  const params = getDownloadParameters(
    boundingBox,
    "png",
    maxPixels,
    95,
    "layers",
  );

  if (params === null) {
    throw new Error("Image size exceeds maximum allowed pixels");
  }

  const apiRoot = store.girderRest.apiRoot;
  const baseUrl = getBaseURLFromDownloadParameters(params, itemId, apiRoot);

  const urls: URL[] = [];
  for (const time of timePoints) {
    const currentLocation = { ...location, time };
    const layerUrls = await getLayersDownloadUrls(
      baseUrl,
      "composite",
      layers,
      dataset,
      currentLocation,
    );

    if (layerUrls.length === 0) {
      throw new Error("No layers available for download");
    }

    urls.push(layerUrls[0].url);
  }

  return urls;
}

async function waitForRenderingComplete() {
  const map = firstMap.value;
  if (!map) {
    return;
  }

  const waitForMapDraw = new Promise<void>((resolve) => {
    const onDrawEnd = () => {
      map.geoOff(geojs.event.drawEnd, onDrawEnd);
      resolve();
    };

    map.geoOn(geojs.event.drawEnd, onDrawEnd);

    setTimeout(resolve, 5000);
  });

  await waitForMapDraw;

  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );

  await new Promise((resolve) => setTimeout(resolve, 2000));
}

async function getUrlsForMovieWithAnnotations(
  timePoints: number[],
  datasetId: string,
): Promise<string[]> {
  const dataset =
    store.dataset?.id === datasetId
      ? store.dataset
      : await girderResources.getDataset({ id: datasetId });
  if (!dataset) {
    throw new Error("Dataset not found");
  }

  const map = firstMap.value;
  if (!map) {
    throw new Error("Map not available");
  }

  const dataUrls: string[] = [];

  const progressId = await progress.create({
    type: ProgressType.MOVIE_GENERATION,
    title: "Capturing frames with annotations",
  });

  try {
    for (let i = 0; i < timePoints.length; i++) {
      const timePoint = timePoints[i];

      store.setTime(timePoint);

      await waitForRenderingComplete();

      const visibleLayers = map
        .layers()
        .filter(
          (layer) =>
            layer !== bboxLayer.value &&
            layer.node().css("visibility") !== "hidden",
        );

      const fullScreenshot = await map.screenshot(visibleLayers);

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Failed to get canvas context");
      }

      const img = new Image();

      await new Promise((resolve) => {
        img.onload = resolve;
        img.src = fullScreenshot;
      });

      const topLeft = map.gcsToDisplay({
        x: bboxLeft.value,
        y: bboxTop.value,
      });
      const bottomRight = map.gcsToDisplay({
        x: bboxRight.value,
        y: bboxBottom.value,
      });

      const width = bottomRight.x - topLeft.x;
      const height = bottomRight.y - topLeft.y;

      canvas.width = width;
      canvas.height = height;

      ctx.drawImage(
        img,
        topLeft.x,
        topLeft.y,
        width,
        height,
        0,
        0,
        width,
        height,
      );

      if (addScalebar.value) {
        drawScalebarOnCanvas(ctx, width, height);
      }

      const dataUrl = canvas.toDataURL("image/png");
      dataUrls.push(dataUrl);

      progress.update({
        id: progressId,
        progress: i + 1,
        total: timePoints.length,
        title: `Capturing frame ${i + 1} of ${timePoints.length}`,
      });
    }
  } finally {
    progress.complete(progressId);
  }

  return dataUrls;
}

async function handleMovieDownload(params: any) {
  const dataset = store.dataset;
  if (!dataset) return;

  try {
    downloading.value = true;
    const timePoints = Array.from(
      { length: params.endTime - params.startTime + 1 },
      (_, i) => params.startTime + i,
    );

    let urls: URL[] | string[] = [];
    if (addAnnotationsToMovie.value) {
      urls = await getUrlsForMovieWithAnnotations(timePoints, dataset.id);
    } else {
      urls = await getUrlsForMovie(
        timePoints,
        dataset.id,
        {
          left: bboxLeft.value,
          top: bboxTop.value,
          right: bboxRight.value,
          bottom: bboxBottom.value,
        },
        store.layers,
        store.currentLocation,
      );
    }

    switch (params.format) {
      case MovieFormat.ZIP:
        await downloadMovieAsZippedImageSequence(params, urls);
        break;
      case MovieFormat.GIF:
        await downloadMovieAsGif(params, urls);
        break;
      case MovieFormat.MP4:
        await downloadMovieAsVideo(params, urls, true);
        break;
      case MovieFormat.WEBM:
        await downloadMovieAsVideo(params, urls, false);
        break;
      default:
        logError("Unknown format:", params.format);
    }
  } catch (error) {
    logError("Movie download failed:", error);
  } finally {
    downloading.value = false;
  }
}

async function downloadMovieAsZippedImageSequence(
  params: {
    startTime: number;
    endTime: number;
    fps: number;
    shouldAddTimeStamp: boolean;
    initialTimeStampTime: number;
    timeStampStep: number;
    timeStampUnits: string;
  },
  urls: URL[] | string[],
) {
  const progressId = await progress.create({
    type: ProgressType.MOVIE_GENERATION,
    title: "Generating ZIP sequence",
  });

  try {
    const zip = new Zip();
    const zipChunks: Uint8Array[] = [];
    const zipDone: Promise<Blob> = new Promise((resolve, reject) => {
      zip.ondata = (err: Error | null, data: Uint8Array, final: boolean) => {
        if (!err) {
          zipChunks.push(data);
          if (final) {
            resolve(new Blob(zipChunks));
          }
        } else {
          reject(err);
        }
      };
    });

    const deflateOptions: DeflateOptions = {
      level: 0,
    };

    for (let i = 0; i < urls.length; i++) {
      let imageData: ArrayBuffer;
      let imageUrl: string;

      if (typeof urls[i] === "string") {
        const dataUrl = urls[i] as string;
        const base64Data = dataUrl.split(",")[1];
        const binaryData = atob(base64Data);
        const byteArray = new Uint8Array(binaryData.length);
        for (let j = 0; j < binaryData.length; j++) {
          byteArray[j] = binaryData.charCodeAt(j);
        }
        imageData = byteArray.buffer;
        imageUrl = dataUrl;
      } else {
        const response = await store.girderRest.get((urls[i] as URL).href, {
          responseType: "arraybuffer",
        });
        imageData = response.data;
        const blob = new Blob([imageData], { type: "image/png" });
        imageUrl = URL.createObjectURL(blob);
      }

      if (params.shouldAddTimeStamp || addScalebar.value) {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = imageUrl;
        });

        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Failed to get canvas context");

        ctx.drawImage(img, 0, 0);

        if (addScalebar.value) {
          drawScalebarOnCanvas(ctx, canvas.width, canvas.height);
        }

        URL.revokeObjectURL(imageUrl);

        if (params.shouldAddTimeStamp) {
          addTimeStampToCanvas(canvas, params, i);
        }

        const annotatedBlob = await new Promise<Blob>((resolve) => {
          canvas.toBlob((blob) => resolve(blob!), "image/png");
        });

        const arrayBuffer = await annotatedBlob.arrayBuffer();

        const fileName = `frame${(i + 1).toString().padStart(4, "0")}.png`;
        const zipFile = new ZipDeflate(fileName, deflateOptions);
        zip.add(zipFile);
        zipFile.push(new Uint8Array(arrayBuffer), true);
      } else {
        const fileName = `frame${(i + 1).toString().padStart(4, "0")}.png`;
        const zipFile = new ZipDeflate(fileName, deflateOptions);
        zip.add(zipFile);
        zipFile.push(new Uint8Array(imageData), true);

        if (typeof urls[i] !== "string") {
          URL.revokeObjectURL(imageUrl);
        }
      }

      progress.update({
        id: progressId,
        progress: i + 1,
        total: urls.length,
        title: "Processing frame",
      });
    }

    zip.end();
    const blob = await zipDone;

    const url = URL.createObjectURL(blob);
    downloadToClient({
      href: url,
      download: `timelapse_${params.startTime}_${params.endTime}.zip`,
    });
    URL.revokeObjectURL(url);
  } finally {
    progress.complete(progressId);
  }
}

async function downloadMovieAsGif(
  params: {
    startTime: number;
    endTime: number;
    fps: number;
    shouldAddTimeStamp: boolean;
    initialTimeStampTime: number;
    timeStampStep: number;
    timeStampUnits: string;
  },
  urls: URL[] | string[],
) {
  const progressId = await progress.create({
    type: ProgressType.MOVIE_GENERATION,
    title: "Generating GIF",
  });

  try {
    const gifOptions: IGifOptions = {
      workers: 4,
      quality: 10,
      workerScript: "/gif.worker.js",
      width: null,
      height: null,
      workerOptions: {
        willReadFrequently: true,
      },
    };
    const gif = new GIF(gifOptions);

    const totalFrames = urls.length;

    for (let i = 0; i < urls.length; i++) {
      let imageUrl: string;
      if (typeof urls[i] === "string") {
        imageUrl = urls[i] as string;
      } else {
        const { data } = await store.girderRest.get((urls[i] as URL).href, {
          responseType: "arraybuffer",
        });
        const blob = new Blob([data], { type: "image/png" });
        imageUrl = URL.createObjectURL(blob);
      }

      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => {
          if (params.shouldAddTimeStamp || addScalebar.value) {
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Failed to get canvas context");

            ctx.drawImage(img, 0, 0);

            if (addScalebar.value) {
              drawScalebarOnCanvas(ctx, canvas.width, canvas.height);
            }

            if (params.shouldAddTimeStamp) {
              addTimeStampToCanvas(canvas, params, i);
            }

            gif.addFrame(canvas, { delay: 1000 / params.fps });
          } else {
            gif.addFrame(img, { delay: 1000 / params.fps });
          }

          progress.update({
            id: progressId,
            progress: i + 1,
            total: totalFrames * 2,
            title: "Loading frame",
          });

          if (typeof urls[i] !== "string") {
            URL.revokeObjectURL(imageUrl);
          }

          resolve();
        };
        img.onerror = reject;
        img.src = imageUrl;
      });
    }

    const gifBlob = await new Promise<Blob>((resolve) => {
      gif.on("progress", (progressValue: number) => {
        progress.update({
          id: progressId,
          progress: totalFrames + Math.floor(progressValue * totalFrames),
          total: totalFrames * 2,
          title: `Rendering GIF: ${Math.round(progressValue * 100)}%`,
        });
      });

      gif.on("finished", (blob: Blob) => {
        resolve(blob);
      });

      gif.render();
    });

    const url = URL.createObjectURL(gifBlob);
    downloadToClient({
      href: url,
      download: `timelapse_${params.startTime}_${params.endTime}.gif`,
    });
    URL.revokeObjectURL(url);
  } finally {
    progress.complete(progressId);
  }
}

async function downloadMovieAsVideo(
  params: {
    startTime: number;
    endTime: number;
    fps: number;
    shouldAddTimeStamp: boolean;
    initialTimeStampTime: number;
    timeStampStep: number;
    timeStampUnits: string;
  },
  urls: URL[] | string[],
  preferMp4: boolean,
) {
  const mimeType = getSupportedVideoMimeType(preferMp4);
  if (!mimeType) {
    throw new Error("No supported video format found in this browser");
  }
  const fileExtension = getVideoFileExtension(mimeType);
  const formatLabel = fileExtension.toUpperCase();

  const progressId = await progress.create({
    type: ProgressType.MOVIE_GENERATION,
    title: `Generating ${formatLabel} video`,
  });

  try {
    let firstFrameUrl: string;
    if (typeof urls[0] === "string") {
      firstFrameUrl = urls[0] as string;
    } else {
      const firstFrameResponse = await store.girderRest.get(
        (urls[0] as URL).href,
        {
          responseType: "arraybuffer",
        },
      );
      const firstFrameBlob = new Blob([firstFrameResponse.data], {
        type: "image/png",
      });
      firstFrameUrl = URL.createObjectURL(firstFrameBlob);
    }

    const firstImage = await new Promise<HTMLImageElement>(
      (resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = firstFrameUrl;
      },
    );

    if (typeof urls[0] !== "string") {
      URL.revokeObjectURL(firstFrameUrl);
    }

    const canvas = document.createElement("canvas");
    canvas.width = firstImage.width;
    canvas.height = firstImage.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get canvas context");

    const stream = canvas.captureStream(params.fps);
    const mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8000000,
    });

    const chunks: Blob[] = [];
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    mediaRecorder.start();

    let currentFrame = 0;
    const frameDuration = 1000 / params.fps;

    const processNextFrame = async () => {
      if (currentFrame >= urls.length) {
        mediaRecorder.stop();
        return;
      }

      let imageUrl: string;
      if (typeof urls[currentFrame] === "string") {
        imageUrl = urls[currentFrame] as string;
      } else {
        const { data } = await store.girderRest.get(
          (urls[currentFrame] as URL).href,
          {
            responseType: "arraybuffer",
          },
        );
        const blob = new Blob([data], { type: "image/png" });
        imageUrl = URL.createObjectURL(blob);
      }

      await new Promise<void>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          if (typeof urls[currentFrame] !== "string") {
            URL.revokeObjectURL(imageUrl);
          }

          resolve();
        };
        img.onerror = reject;
        img.src = imageUrl;
      });

      if (addScalebar.value) {
        drawScalebarOnCanvas(ctx, canvas.width, canvas.height);
      }

      if (params.shouldAddTimeStamp) {
        addTimeStampToCanvas(canvas, params, currentFrame);
      }

      progress.update({
        id: progressId,
        progress: currentFrame + 1,
        total: urls.length,
        title: "Processing frame",
      });

      currentFrame++;
      setTimeout(processNextFrame, frameDuration);
    };

    const videoBlob = await new Promise<Blob>((resolve) => {
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        resolve(blob);
      };
      processNextFrame();
    });

    stream.getTracks().forEach((track) => track.stop());

    const url = URL.createObjectURL(videoBlob);
    downloadToClient({
      href: url,
      download: `timelapse_${params.startTime}_${params.endTime}.${fileExtension}`,
    });
    URL.revokeObjectURL(url);
  } finally {
    progress.complete(progressId);
  }
}

function addTimeStampToCanvas(
  canvas: HTMLCanvasElement,
  params: {
    initialTimeStampTime: number;
    timeStampStep: number;
    timeStampUnits: string;
  },
  frameIndex: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get canvas context");

  ctx.fillStyle = "white";
  ctx.strokeStyle = "black";
  ctx.lineWidth = 3;
  ctx.font = "24px Arial";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";

  const timeText = `T=${params.initialTimeStampTime + frameIndex * params.timeStampStep} ${params.timeStampUnits}`;
  ctx.strokeText(timeText, 10, canvas.height - 10);
  ctx.fillText(timeText, 10, canvas.height - 10);
}

function drawScalebarOnCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const scalebarLength = scalebarLengthInPixels.value;
  const maxDim = Math.max(width, height);

  const padding = Math.max(10, Math.min(40, 0.02 * maxDim));
  const lineWidth = Math.max(3, Math.min(12, 0.008 * maxDim));
  const fontSize = Math.max(12, Math.min(24, 0.02 * maxDim));

  ctx.strokeStyle = snapshotScalebarColor.value;
  ctx.fillStyle = snapshotScalebarColor.value;
  ctx.lineWidth = lineWidth;

  ctx.beginPath();
  ctx.moveTo(width - padding, height - padding);
  ctx.lineTo(width - padding - scalebarLength, height - padding);
  ctx.stroke();

  if (addScalebarText.value) {
    ctx.font = `${fontSize}px Arial`;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "right";
    ctx.fillText(
      `${scalebarSettings.value.length}${scalebarSettings.value.unit}`,
      width - padding,
      height - padding - lineWidth,
    );
  }
}

// --- Watchers ---

watch(
  () => props.snapshotVisible,
  () => {
    showSnapshot(props.snapshotVisible);
    if (props.snapshotVisible) {
      markCurrentArea();
      drawBoundingBox();
    }
  },
);

watch(downloadMode, () => {
  format.value = formatList.value[0].value;
});

watch(firstMap, () => {
  if (props.snapshotVisible) {
    showSnapshot(false);
    showSnapshot(true);
    markCurrentArea();
    drawBoundingBox();
  } else {
    showSnapshot(false);
  }
});

watch(snapshotScalebarColor, () => {
  if (scalebarAnnotation.value) {
    scalebarAnnotation.value.style({
      strokeColor: snapshotScalebarColor.value,
      strokeWidth: 3,
      strokeOpacity: 1,
    });
    bboxLayer.value?.draw();
  }
});

// --- Expose ---

defineExpose({
  // Data refs
  movieDialog,
  jpegQuality,
  downloading,
  imageTooBigDialog,
  createDialog,
  newName,
  newDescription,
  newTags,
  isSaveSnapshotValid,
  selectedSnapshotItems,
  snapshotSearch,
  bboxLeft,
  bboxTop,
  bboxRight,
  bboxBottom,
  bboxLayer,
  bboxAnnotation,
  scalebarAnnotation,
  downloadMode,
  exportLayer,
  exportChannel,
  format,
  layersOverwritePanel,
  overwrittingSnaphot,
  addScalebar,
  addScalebarText,
  scalebarSettingsDialog,
  snapshotScalebarColor,
  manualScalebarSettings,
  manualPixelSize,
  addAnnotationsToMovie,
  pixelSizeMode,
  scalebarMode,
  // Template ref
  saveSnapshotForm,
  // Constants
  tableHeaders,
  maxPixels,
  nameRules,
  // Computed properties
  isLoggedIn,
  formatList,
  bboxWidth,
  bboxHeight,
  unroll,
  geoJSMaps,
  firstMap,
  layerItems,
  channelItems,
  manualScalebarSettingsLength,
  manualScalebarSettingsUnit,
  manualPixelSizeLength,
  manualPixelSizeUnit,
  configurationPixelSize,
  formattedConfigurationPixelSize,
  formattedScalebarSettings,
  pixelSize,
  idealScalebarLength,
  scalebarSettings,
  scalebarLengthInPixels,
  snapshotList,
  currentSnapshot,
  pixelSizeUnitItems,
  scalebarSettingsUnitItems,
  // Functions
  isRotated,
  unitLengthToScalebarUnit,
  convertLengthToMeters,
  convertMetersToLength,
  guessIdealScalebar,
  prettyScalebarSettings,
  handlePixelSizeModeChange,
  handleScalebarModeChange,
  setBoundingBox,
  showSnapshot,
  markCurrentArea,
  scalebarVertices,
  setArea,
  drawBoundingBox,
  boundingBoxCoordinates,
  doneBoundingBox,
  areCurrentLayersCompatible,
  openConfigurationLayersOverwritePanel,
  changeDatasetViewContrasts,
  overwriteConfigurationLayers,
  loadSnapshot,
  updateFormValidation,
  resetFormValidation,
  saveSnapshot,
  resetAndCloseForm,
  removeSnapshot,
  screenshotViewport,
  snapshotWithAnnotations,
  downloadImagesForCurrentState,
  downloadImagesForAllSnapshots,
  downloadImagesForSelectedSnapshots,
  downloadImagesForSetOfSnapshots,
  getUrlsForSnapshot,
  addScalebarToImageBuffer,
  downloadUrls,
  getUrlsForMovie,
  waitForRenderingComplete,
  getUrlsForMovieWithAnnotations,
  handleMovieDownload,
  downloadMovieAsZippedImageSequence,
  downloadMovieAsGif,
  downloadMovieAsVideo,
  addTimeStampToCanvas,
  drawScalebarOnCanvas,
});
</script>
