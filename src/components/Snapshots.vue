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
      v-model="movieDialog"
      :current-time="store.time"
      :dataset="store.dataset"
      @download="handleMovieDownload"
    />
  </div>
</template>

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import TagPicker from "@/components/TagPicker.vue";
import MovieDialog from "@/components/MovieDialog.vue";
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

export enum PixelSizeMode {
  DATASET = "dataset",
  MANUAL = "manual",
}

export enum ScalebarMode {
  AUTOMATIC = "automatic",
  MANUAL = "manual",
}

@Component({
  components: { TagPicker, MovieDialog },
})
export default class Snapshots extends Vue {
  readonly store = store;
  readonly progress = progress;
  movieDialog: boolean = false;

  @Prop()
  snapshotVisible!: boolean;

  @Watch("snapshotVisible")
  watchSnapshotVisible() {
    this.showSnapshot(this.snapshotVisible);
    if (this.snapshotVisible) {
      this.markCurrentArea();
      this.drawBoundingBox();
    }
  }

  get isLoggedIn() {
    return this.store.isLoggedIn;
  }

  tableHeaders: {
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

  jpegQuality: number | string = 95;

  readonly maxPixels = 4_000_000;

  downloading: boolean = false;

  imageTooBigDialog: boolean = false;
  createDialog: boolean = false;
  newName: string = "";
  newDescription: string = "";
  newTags: string[] = [];
  readonly nameRules = [(name: string) => !!name.trim() || "Name is required"];
  isSaveSnapshotValid: boolean = true;

  selectedSnapshotItems: ISnapshotItem[] = [];

  $refs!: {
    // https://github.com/vuetifyjs/vuetify/issues/5962
    saveSnapshotForm: HTMLFormElement;
  };

  snapshotSearch: string = "";

  bboxLeft: number = 0;
  bboxTop: number = 0;
  bboxRight: number = 0;
  bboxBottom: number = 0;
  bboxLayer: IGeoJSAnnotationLayer | null = null;
  bboxAnnotation: IGeoJSAnnotation | null = null;
  scalebarAnnotation: IGeoJSAnnotation | null = null;
  downloadMode: "layers" | "channels" = "layers";
  exportLayer: "all" | "composite" | string = "composite";
  exportChannel: "all" | number = "all";
  format: string = "png";

  layersOverwritePanel: boolean = false;
  overwrittingSnaphot: ISnapshot | null = null;

  addScalebar: boolean = true;
  addScalebarText: boolean = true;
  scalebarSettingsDialog: boolean = false;
  snapshotScalebarColor: string = "#ffffff";
  manualScalebarSettings: IScalebarSettings | null = null;
  manualPixelSize: IScalebarSettings | null = null;

  addAnnotationsToMovie: boolean = false;

  pixelSizeMode: PixelSizeMode = PixelSizeMode.DATASET;
  scalebarMode: ScalebarMode = ScalebarMode.AUTOMATIC;

  get formatList() {
    if (this.downloadMode === "layers") {
      return [
        { text: "PNG", value: "png" },
        { text: "JPEG", value: "jpeg" },
        { text: "TIFF", value: "tiff" },
        { text: "TIFF - Tiled (for huge images)", value: "tiled" },
      ];
    }
    if (this.downloadMode === "channels") {
      return [
        { text: "TIFF", value: "tiff" },
        { text: "TIFF - Tiled (for huge images)", value: "tiled" },
      ];
    }
    return [{ text: "Unknown download mode", value: "" }];
  }

  @Watch("downloadMode")
  downloadModeChanged() {
    this.format = this.formatList[0].value;
  }

  get bboxWidth(): number {
    return (this.bboxRight || 0) - (this.bboxLeft || 0);
  }

  set bboxWidth(value: string | number) {
    if (typeof value == "string") {
      this.bboxRight = (this.bboxLeft || 0) + intFromString(value);
    } else {
      this.bboxRight = value;
    }
  }

  get bboxHeight(): number {
    return (this.bboxBottom || 0) - (this.bboxTop || 0);
  }

  set bboxHeight(value: string | number) {
    if (typeof value == "string") {
      this.bboxBottom = (this.bboxTop || 0) + intFromString(value);
    } else {
      this.bboxBottom = value;
    }
  }

  get unroll(): boolean {
    return store.unroll;
  }

  get geoJSMaps() {
    return this.store.maps.map((map) => map.map);
  }

  get firstMap(): IGeoJSMap | undefined {
    return this.geoJSMaps[0];
  }

  isRotated(): boolean {
    return this.geoJSMaps.some((map) => !!map.rotation());
  }

  get layerItems() {
    const results: {
      text: string;
      value: string;
    }[] = [
      { text: "Composite layers", value: "composite" },
      { text: "All layers (zip)", value: "all" },
    ];
    store.layers.forEach((layer) => {
      if (layer.visible) {
        results.push({ text: layer.name, value: layer.id });
      }
    });
    return results;
  }

  get channelItems() {
    const results: {
      text: string;
      value: string | number;
    }[] = [{ text: "All channels", value: "all" }];
    if (this.store.dataset) {
      this.store.dataset.channels.forEach((channel) => {
        results.push({
          text:
            this.store.dataset!.channelNames.get(channel) ||
            "Channel " + channel,
          value: channel,
        });
      });
    }
    return results;
  }

  get manualScalebarSettingsLength(): number {
    return this.manualScalebarSettings?.length || 1.0;
  }

  set manualScalebarSettingsLength(value: number) {
    if (this.manualScalebarSettings) {
      this.manualScalebarSettings.length = value;
    }
  }

  get manualScalebarSettingsUnit(): TScalebarUnit {
    return this.manualScalebarSettings?.unit || TScalebarUnit.PX;
  }

  set manualScalebarSettingsUnit(value: TScalebarUnit) {
    if (this.manualScalebarSettings) {
      this.manualScalebarSettings.unit = value;
    }
  }

  get manualPixelSizeLength(): number {
    return this.manualPixelSize?.length || 1.0;
  }

  set manualPixelSizeLength(value: number) {
    if (this.manualPixelSize) {
      this.manualPixelSize.length = value;
    }
  }

  get manualPixelSizeUnit(): TScalebarUnit {
    return this.manualPixelSize?.unit || TScalebarUnit.PX;
  }

  set manualPixelSizeUnit(value: TScalebarUnit) {
    if (this.manualPixelSize) {
      this.manualPixelSize.unit = value;
    }
  }

  get configurationPixelSize(): IScalebarSettings {
    const scale = store.configuration?.scales.pixelSize;
    if (!scale) {
      return { length: 1.0, unit: TScalebarUnit.PX };
    }
    // Sometimes, if there is no metadata, the pixel size is 0.
    if (scale.value === 0) {
      return { length: 1.0, unit: TScalebarUnit.PX };
    }
    return { length: scale.value, unit: scale.unit as TScalebarUnit };
  }

  get formattedConfigurationPixelSize(): string {
    const settings = this.configurationPixelSize;
    return this.prettyScalebarSettings(settings);
  }

  get formattedScalebarSettings(): string {
    const settings = this.scalebarSettings;
    return this.prettyScalebarSettings(settings);
  }

  prettyScalebarSettings(settings: IScalebarSettings): string {
    if (settings.unit === TScalebarUnit.PX) {
      return `${settings.length} px`;
    }
    const length = this.convertLengthToMeters(settings.length, settings.unit);
    const printSettings = this.convertMetersToLength(length);
    return `${printSettings.length.toFixed(1)} ${printSettings.unit}`;
  }

  get pixelSize(): IScalebarSettings {
    // If there is a manual pixel size, use that.
    if (this.pixelSizeMode === "manual" && this.manualPixelSize) {
      return this.manualPixelSize;
    }
    // Otherwise, use the configuration pixel size.
    return this.configurationPixelSize;
  }

  get scalebarSettings(): IScalebarSettings {
    // If there is a manual scalebar settings, use that.
    if (this.scalebarMode === "manual" && this.manualScalebarSettings) {
      return this.manualScalebarSettings;
    }
    // Otherwise, compute the ideal scalebar length.
    const idealScalebar = this.idealScalebarLength;
    if (!idealScalebar) {
      return { length: 1.0, unit: TScalebarUnit.PX };
    } else {
      if (this.pixelSize.unit === TScalebarUnit.PX) {
        // If the unit is pixels, then we need to explicitly set the unit to pixels.
        return { length: idealScalebar, unit: TScalebarUnit.PX };
      }
      return this.convertMetersToLength(idealScalebar);
    }
  }

  get scalebarLengthInPixels(): number {
    // If the unit is pixels, return the length as is
    if (this.scalebarSettings.unit === TScalebarUnit.PX) {
      return this.scalebarSettings.length;
    }
    // If the unit is physical distance, then we need to convert to pixels.
    // First, let's convert the length per pixel into meters.
    // This is somewhat irritating because scales.pixelSize.unit can be:
    // any of: export type TUnitLength = "nm" | "µm" | "mm" | "m";
    // and we want to convert to meters.

    const pixelSize = this.pixelSize;
    if (pixelSize.unit === TScalebarUnit.PX) {
      // This should be captured above, but an extra guard just in case.
      return this.scalebarSettings.length;
    }

    const pixelLengthInMeters = this.convertLengthToMeters(
      pixelSize.length,
      pixelSize.unit,
    );
    // Then, convert the scalebar length to meters
    const scalebarLengthInMeters = this.convertLengthToMeters(
      this.scalebarSettings.length,
      this.scalebarSettings.unit,
    );
    return scalebarLengthInMeters / pixelLengthInMeters;
  }

  // Convert a unit of length to a unit of scalebar length
  // Required because the length unit does not include pixels
  // TODO: Remove? Now it literally does nothing at all.
  unitLengthToScalebarUnit(unit: TUnitLength): TUnitLength {
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

  convertLengthToMeters(length: number, unit: TUnitLength): number {
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

  convertMetersToLength(length: number): IScalebarSettings {
    // Implement logic to assign a IScalebarUnit based on the meters
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

  guessIdealScalebar(
    imageWidthPixels: number,
    distancePerPixel: number,
  ): number | null {
    if (imageWidthPixels <= 0 || distancePerPixel <= 0) {
      return null;
    }
    // Helper function to round to significant digits
    const roundToSignificant = (
      num: number,
      sigDigits: number = 10,
    ): number => {
      if (num === 0) return 0;
      const magnitude = Math.floor(Math.log10(Math.abs(num)));
      const scale = Math.pow(10, sigDigits - magnitude - 1);
      return Math.round(num * scale) / scale;
    };

    // distancePerPixel is in meters; if you want to use pixels, just send 1
    // Define our units in ascending order (all converted to meters)
    const units = [
      { unit: TScalebarUnit.NM, scale: 1e-9 }, // nanometers
      { unit: TScalebarUnit.UM, scale: 1e-6 }, // micrometers
      { unit: TScalebarUnit.MM, scale: 1e-3 }, // millimeters
      { unit: TScalebarUnit.M, scale: 1 }, // meters
    ];

    // Preferred round numbers for scale bars
    const preferredMultiples = [1, 2, 5, 10];

    // Calculate the target range for scale bar in pixels (5% to 25% of image width)
    const minPixels = imageWidthPixels * 0.05;
    const maxPixels = imageWidthPixels * 0.25;
    const targetPixels = (minPixels + maxPixels) / 2;

    // Calculate what this range represents in meters
    const targetDistance = targetPixels * distancePerPixel;

    // Find appropriate unit based on target distance
    let selectedUnit = units[0];
    for (const unit of units) {
      if (targetDistance >= unit.scale / 10) {
        // Allow unit to be used if target is 1/10th of its scale
        selectedUnit = unit;
      } else {
        break;
      }
    }

    // Convert target distance to selected unit
    const targetInUnits = targetDistance / selectedUnit.scale;

    // Find appropriate power of 10
    const power = Math.floor(Math.log10(targetInUnits));

    // Try different round numbers
    let bestValue = null;
    let bestDiff = Infinity;

    // Try powers from power-1 to power+1
    for (let p = power - 1; p <= power + 1; p++) {
      for (const multiple of preferredMultiples) {
        const value = multiple * Math.pow(10, p);
        const physicalDistance = value * selectedUnit.scale;
        const pixels = physicalDistance / distancePerPixel;

        // Check if this value gives us a reasonable scale bar length
        if (pixels >= minPixels * 0.8 && pixels <= maxPixels * 1.2) {
          const diff = Math.abs(pixels - targetPixels);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestValue = physicalDistance;
          }
        }
      }
    }

    // If we didn't find a good value, create one from the target
    if (!bestValue) {
      const value = Math.pow(10, Math.floor(Math.log10(targetInUnits)));
      bestValue = value * selectedUnit.scale;
    }

    // Round the final value before returning
    return roundToSignificant(bestValue);
  }

  get idealScalebarLength() {
    const pixelSize = this.pixelSize;
    if (pixelSize.unit === TScalebarUnit.PX) {
      return this.guessIdealScalebar(
        this.bboxRight - this.bboxLeft,
        pixelSize.length, // This value should be 1 (passes 1 meter)
      );
    }
    // If the pixel size is not pixels, then we need to convert to meters
    const pixelLengthInMeters = this.convertLengthToMeters(
      pixelSize.length,
      pixelSize.unit,
    );
    return this.guessIdealScalebar(
      this.bboxRight - this.bboxLeft,
      pixelLengthInMeters,
    );
  }

  async screenshotViewport() {
    const map = this.firstMap;
    if (!map) {
      return;
    }
    const layers = map
      .layers()
      .filter(
        (layer) =>
          layer !== this.bboxLayer &&
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

  async snapshotWithAnnotations() {
    const map = this.firstMap;
    if (!map) {
      return;
    }

    // Get all visible layers except the bounding box layer
    const layers = map
      .layers()
      .filter(
        (layer) =>
          layer !== this.bboxLayer &&
          layer.node().css("visibility") !== "hidden",
      );

    // Capture the full screenshot
    const fullScreenshot = await map.screenshot(layers);

    // Create a new canvas for cropping
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    // Create an image element to load the screenshot
    const img = new Image();

    // Wait for the image to load
    await new Promise((resolve) => {
      img.onload = resolve;
      img.src = fullScreenshot;
    });

    // Convert bounding box GCS coordinates to display coordinates
    const topLeft = map.gcsToDisplay({ x: this.bboxLeft, y: this.bboxTop });
    const bottomRight = map.gcsToDisplay({
      x: this.bboxRight,
      y: this.bboxBottom,
    });

    // Calculate width and height in display pixels
    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;

    // Set canvas dimensions to match the bounding box
    canvas.width = width;
    canvas.height = height;

    // Draw only the portion of the image that falls within the bounding box
    ctx.drawImage(
      img,
      topLeft.x,
      topLeft.y,
      width,
      height, // Source rectangle
      0,
      0,
      width,
      height, // Destination rectangle
    );

    // Add scalebar if requested
    if (this.addScalebar) {
      this.drawScalebarOnCanvas(ctx, canvas.width, canvas.height);
    }

    // Convert the canvas to a data URL
    const croppedScreenshot = canvas.toDataURL("image/png");

    // Download the cropped screenshot
    const params = {
      href: croppedScreenshot,
      download: "viewport_screenshot.png",
    };
    downloadToClient(params);
  }

  async downloadImagesForCurrentState() {
    const datasetId = this.store.dataset?.id;
    if (!datasetId) {
      return;
    }
    const location = this.store.currentLocation;
    const boundingBox = {
      left: this.bboxLeft,
      top: this.bboxTop,
      right: this.bboxRight,
      bottom: this.bboxBottom,
    };

    this.downloading = true;

    // Snapshots always come from the current configuration
    const configuration = this.store.configuration;
    if (!configuration) {
      return;
    }

    try {
      const urls = await this.getUrlsForSnapshot(
        location,
        boundingBox,
        datasetId,
        this.newName,
        configuration.layers,
        configuration.name,
      );
      if (!urls) {
        return;
      }
      await this.downloadUrls(urls, this.addScalebar);
    } finally {
      this.downloading = false;
    }
  }

  async downloadImagesForAllSnapshots() {
    const configuration = this.store.configuration;
    if (!configuration) {
      return;
    }
    const snapshots = configuration.snapshots || [];
    await this.downloadImagesForSetOfSnapshots(snapshots);
  }

  async downloadImagesForSelectedSnapshots() {
    const configuration = this.store.configuration;
    if (!configuration) {
      return;
    }
    const selected = this.selectedSnapshotItems.map((s) => s.record);
    await this.downloadImagesForSetOfSnapshots(selected);
  }

  async downloadImagesForSetOfSnapshots(snapshots: ISnapshot[]) {
    this.downloading = true;

    // Create progress tracker
    const progressId = await this.progress.create({
      type: ProgressType.SNAPSHOT_BATCH_DOWNLOAD,
      title: "Downloading snapshot images",
    });

    try {
      const configuration = this.store.configuration;
      if (!configuration) {
        return;
      }

      const allUrls: URL[] = [];
      const totalSnapshots = snapshots.length;

      for (let i = 0; i < totalSnapshots; i++) {
        const snapshot = snapshots[i];

        // Update progress before processing each snapshot
        this.progress.update({
          id: progressId,
          progress: i,
          total: totalSnapshots,
          title: `Processing snapshot ${i + 1} of ${totalSnapshots}`,
        });

        const datasetView = await this.store.api.getDatasetView(
          snapshot.datasetViewId,
        );
        const currentUrls = await this.getUrlsForSnapshot(
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

      // Update to show download phase
      this.progress.update({
        id: progressId,
        progress: totalSnapshots,
        total: totalSnapshots,
        title: "Downloading files...",
      });

      await this.downloadUrls(allUrls, this.addScalebar);
    } finally {
      this.progress.complete(progressId);
      this.downloading = false;
    }
  }

  // We use xy, z, time, screenshot.bbox and name from the snapshot
  async getUrlsForSnapshot(
    location: IDatasetLocation,
    boundingBox: IGeoJSBounds,
    datasetId: string,
    name: string,
    layers: IDisplayLayer[],
    configurationName: string,
  ) {
    // Get dataset
    const dataset =
      store.dataset?.id === datasetId
        ? store.dataset
        : await girderResources.getDataset({ id: datasetId });
    if (!dataset) {
      return;
    }

    // Get the id of the image for this dataset
    const anyImage = dataset.anyImage();
    if (!anyImage) {
      return;
    }
    const itemId = anyImage.item._id;

    // Get the filename
    const dateStr = formatDate(new Date());
    const extension = this.format === "tiled" ? "tiff" : this.format;

    const jpegQuality =
      typeof this.jpegQuality !== "number"
        ? Number(this.jpegQuality)
        : this.jpegQuality;
    const params = getDownloadParameters(
      boundingBox,
      this.format,
      this.maxPixels,
      jpegQuality,
      this.downloadMode,
    );
    if (params === null) {
      // Image is too big
      this.imageTooBigDialog = true;
      return;
    }
    const apiRoot = store.girderRest.apiRoot;
    const baseUrl = getBaseURLFromDownloadParameters(params, itemId, apiRoot);

    const urls: URL[] = [];
    if (this.downloadMode === "channels") {
      const channelUrls = getChannelsDownloadUrls(
        baseUrl,
        this.exportChannel,
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
        this.exportLayer,
        layers,
        dataset,
        location,
      );
      for (const { url, layerIds } of layerUrls) {
        const layerNames = layerIds.map(
          (layerId) =>
            layers.find((layer) => layer.id === layerId)?.name ??
            "Unknown layer",
        );
        const fileName = `${name} - ${layerNames.join(" ")} - ${dataset.name} - ${configurationName} - ${dateStr}.${extension}`;
        url.searchParams.set("contentDispositionFilename", fileName);
        urls.push(url);
      }
    }

    return urls;
  }

  async addScalebarToImageBuffer(data: ArrayBuffer): Promise<ArrayBuffer> {
    // Create a blob from the image data
    const blob = new Blob([data], { type: "image/png" });
    const imageUrl = URL.createObjectURL(blob);

    // Create an image element and wait for it to load
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = imageUrl;
    });

    // Create a canvas to draw the frame with annotations
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get canvas context");

    // Draw the original image
    ctx.drawImage(img, 0, 0);

    // Draw the scalebar using the helper method
    this.drawScalebarOnCanvas(ctx, canvas.width, canvas.height);

    // Clean up
    URL.revokeObjectURL(imageUrl);

    // Convert canvas to blob and then to array buffer
    const annotatedBlob = await new Promise<Blob>((resolve) => {
      canvas.toBlob((blob) => resolve(blob!), "image/png");
    });
    return await annotatedBlob.arrayBuffer();
  }

  async downloadUrls(urls: URL[], addScalebar: boolean = false) {
    if (urls.length <= 0) {
      return;
    }

    if (urls.length === 1) {
      if (addScalebar) {
        // For single file with scalebar
        const { data } = await store.girderRest.get(urls[0].href, {
          responseType: "arraybuffer",
        });
        const processedData = await this.addScalebarToImageBuffer(data);
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
        // Original single file behavior
        downloadToClient({ href: urls[0].href });
      }
      return;
    }

    // Create and setup a zip object
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

    // Get all the files and add them to the zip
    const deflateOptions: DeflateOptions = {
      // Don't compress the zip when the files are already compressed
      level: ["jpeg", "png"].includes(this.format) ? 0 : 9,
    };
    const filenames: Set<string> = new Set();
    const filesPushed = urls.map(async (url) => {
      // Fetch the file data
      const { data } = await store.girderRest.get(url.href, {
        responseType: "arraybuffer",
      });

      // Process data if scalebar is requested
      const finalData = addScalebar
        ? await this.addScalebarToImageBuffer(data)
        : data;

      // Create a unique file name
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
      // Add file to zip and set its data
      const zipFile = new ZipDeflate(fileName, deflateOptions);
      zip.add(zipFile);
      zipFile.push(new Uint8Array(finalData), true);
    });

    // Wait for all files to be pushed to end the zip
    await Promise.all(filesPushed);
    zip.end();

    // When the zip is ready, download it to the client
    const blob = await zipDone;
    const dataURL = URL.createObjectURL(blob);
    const params = {
      href: dataURL,
      download: "snapshot.zip",
    };
    downloadToClient(params);
  }

  setBoundingBox(left: number, top: number, right: number, bottom: number) {
    const w = store.dataset!.width;
    const h = store.dataset!.height;
    this.bboxLeft = Math.min(w - 1, Math.max(0, Math.round(left)));
    this.bboxRight = Math.max(
      this.bboxLeft + 1,
      Math.min(w, Math.round(right)),
    );
    this.bboxTop = Math.min(h - 1, Math.max(0, Math.round(top)));
    this.bboxBottom = Math.max(
      this.bboxTop + 1,
      Math.min(h, Math.round(bottom)),
    );
  }

  @Watch("firstMap")
  resetBboxLayer() {
    if (this.snapshotVisible) {
      this.showSnapshot(false);
      this.showSnapshot(true);
      this.markCurrentArea();
      this.drawBoundingBox();
    } else {
      this.showSnapshot(false);
    }
  }

  showSnapshot(show: boolean) {
    const map = this.firstMap;
    if (!map) {
      return;
    }
    // TODO: I'm not sure this first section is needed.
    // As far as I can tell, this is called upon a change to first map,
    // called with show = false, and then called again with show = true.
    // But it seems as through the bbox is set in the next conditional.
    if (this.bboxHeight <= 0 && this.bboxWidth <= 0) {
      const topLeft = map.displayToGcs({ x: 0, y: 0 });
      const bottomRight = map.displayToGcs({
        x: map.size().width,
        y: map.size().height,
      });
      // Set bounding box to the middle third of the map
      const insetX = (bottomRight.x - topLeft.x) / 3;
      const insetY = (bottomRight.y - topLeft.y) / 3;
      this.bboxLeft = topLeft.x + insetX;
      this.bboxTop = topLeft.y + insetY;
      this.bboxRight = bottomRight.x - insetX;
      this.bboxBottom = bottomRight.y - insetY;
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
      this.setBoundingBox(
        innerBounds[0].x,
        innerBounds[0].y,
        innerBounds[1].x,
        innerBounds[1].y,
      );

      if (!this.bboxLayer) {
        this.bboxLayer = map.createLayer("annotation", {
          autoshareRenderer: false,
          showLabels: false,
        });

        // Create bbox annotation as before
        this.bboxAnnotation = geojs.annotation.rectangleAnnotation({
          layer: this.bboxLayer,
          corners: [
            { x: this.bboxLeft, y: this.bboxTop },
            { x: this.bboxRight, y: this.bboxTop },
            { x: this.bboxRight, y: this.bboxBottom },
            { x: this.bboxLeft, y: this.bboxBottom },
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

        // Create scalebar annotation
        this.scalebarAnnotation = geojs.annotation.lineAnnotation({
          vertices: this.scalebarVertices(this.bboxRight, this.bboxBottom),
          layer: this.bboxLayer,
          style: {
            strokeColor: this.snapshotScalebarColor,
            strokeWidth: 3,
            strokeOpacity: 1,
          },
        });

        this.bboxLayer.addAnnotation(this.bboxAnnotation);
        this.bboxLayer.addAnnotation(this.scalebarAnnotation);
        map.draw();
      }
    } else {
      if (this.bboxLayer) {
        this.doneBoundingBox(true);
        map.deleteLayer(this.bboxLayer);
        this.bboxLayer = null;
        this.bboxAnnotation = null;
        this.scalebarAnnotation = null;
        map.draw();
      }
    }
  }

  markCurrentArea() {
    // this updates the shown screenshot area
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
      { x: this.bboxLeft, y: this.bboxTop },
      { x: this.bboxRight, y: this.bboxTop },
      { x: this.bboxRight, y: this.bboxBottom },
      { x: this.bboxLeft, y: this.bboxBottom },
    ];
    const map = this.firstMap;
    if (
      this.bboxLayer &&
      this.bboxAnnotation &&
      this.scalebarAnnotation &&
      map
    ) {
      // Update bbox as before
      this.bboxLayer.visible(true);
      coordinates = geojs.transform.transformCoordinates(
        map.ingcs(),
        map.gcs(),
        coordinates,
      );
      this.bboxAnnotation.options("corners", coordinates);
      if (this.bboxLayer.currentAnnotation) {
        this.bboxLayer.currentAnnotation.options("corners", coordinates);
      }

      this.scalebarAnnotation.options({
        vertices: this.scalebarVertices(coordinates[2].x, coordinates[2].y),
      });

      this.bboxLayer.draw();
    }
    return w * h;
  }

  @Watch("snapshotScalebarColor")
  updateScalebarColor() {
    if (this.scalebarAnnotation) {
      this.scalebarAnnotation.style({
        strokeColor: this.snapshotScalebarColor,
        strokeWidth: 3,
        strokeOpacity: 1,
      });
      this.bboxLayer?.draw();
    }
  }

  scalebarVertices(rightEdge: number, bottomEdge: number) {
    return [
      { x: rightEdge - 10, y: bottomEdge + 10 },
      { x: rightEdge - 10 - this.scalebarLengthInPixels, y: bottomEdge + 10 },
    ];
  }

  setArea(mode: string) {
    const map = this.firstMap;
    if (!map) {
      return;
    }
    if (mode === "full" && store.dataset) {
      this.setBoundingBox(0, 0, store.dataset.width, store.dataset.height);
    } else if (mode === "viewport" && map && store.dataset) {
      const bounds = map.bounds();
      this.setBoundingBox(bounds.left, bounds.top, bounds.right, bounds.bottom);
    }
    this.markCurrentArea();
  }

  drawBoundingBox() {
    if (this.bboxLayer && this.bboxAnnotation) {
      this.bboxLayer.mode(null);
      this.bboxLayer.mode(this.bboxLayer.modes.edit, this.bboxAnnotation);
      this.bboxLayer.draw();
    }
    const map = this.firstMap;
    if (!map) {
      return;
    }
    map.geoOff(geojs.event.annotation.mode, this.doneBoundingBox);
    map.geoOff(geojs.event.annotation.coordinates, this.boundingBoxCoordinates);
    map.geoOn(geojs.event.annotation.mode, this.doneBoundingBox);
    map.geoOn(geojs.event.annotation.coordinates, this.boundingBoxCoordinates);
    this.markCurrentArea();
  }

  boundingBoxCoordinates(event: { [key: string]: any }) {
    const coord = event.annotation!.coordinates();
    if (event.annotation === this.bboxAnnotation && coord.length === 4) {
      this.setBoundingBox(
        Math.min(coord[0].x, coord[2].x),
        Math.min(coord[0].y, coord[2].y),
        Math.max(coord[0].x, coord[2].x),
        Math.max(coord[0].y, coord[2].y),
      );
    }
  }

  doneBoundingBox(allDone: boolean) {
    const map = this.firstMap;
    if (!map) {
      return;
    }
    map.geoOff(geojs.event.annotation.mode, this.doneBoundingBox);
    map.geoOff(geojs.event.annotation.coordinates, this.boundingBoxCoordinates);
    const coord = this.bboxAnnotation?.coordinates();
    if (coord && coord.length === 4) {
      this.setBoundingBox(
        Math.min(coord[0].x, coord[2].x),
        Math.min(coord[0].y, coord[2].y),
        Math.max(coord[0].x, coord[2].x),
        Math.max(coord[0].y, coord[2].y),
      );
    }
    if (this.bboxLayer) {
      if (this.bboxLayer.map().interactor()) {
        this.bboxLayer.mode(null);
      }
      this.bboxLayer.draw();
    }
    if (allDone !== true) {
      this.drawBoundingBox();
    }
  }

  get snapshotList() {
    const sre = new RegExp(this.snapshotSearch || "", "i");
    const results: ISnapshotItem[] = [];
    if (this.store.configuration && this.store.configuration.snapshots) {
      const snapshots = this.store.configuration.snapshots.slice();
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
            // format the date to string
            modified: formatDate(new Date(s.modified || s.created)),
          };
          results.push(item);

          // Asynchronously fetch the dataset name
          let datasetViewPromise;
          if (this.store.datasetView?.id === s.datasetViewId) {
            datasetViewPromise = Promise.resolve(this.store.datasetView);
          } else {
            datasetViewPromise = this.store.api.getDatasetView(s.datasetViewId);
          }
          datasetViewPromise
            .then(({ datasetId }) =>
              girderResources.getDataset({
                id: datasetId,
              }),
            )
            .then((dataset) => {
              Vue.set(item, "datasetName", dataset?.name || "Unknown dataset");
            });
        }
      });
    }
    return results;
  }

  areCurrentLayersCompatible(snapshot: ISnapshot) {
    // Returns true if all layers of the snapshot also exist in the store and have the same channel
    const currentLayers = this.store.layers;
    return snapshot.layers.every((snapshotLayer) => {
      const storeLayer = currentLayers.find(
        (layer) => layer.id === snapshotLayer.id,
      );
      return !!storeLayer && storeLayer.channel === snapshotLayer.channel;
    });
  }

  openConfigurationLayersOverwritePanel(snapshot: ISnapshot) {
    this.layersOverwritePanel = true;
    this.overwrittingSnaphot = snapshot;
  }

  changeDatasetViewContrasts() {
    if (this.overwrittingSnaphot) {
      this.store.loadSnapshotLayers(this.overwrittingSnaphot);
      this.overwrittingSnaphot = null;
    }
    this.layersOverwritePanel = false;
  }

  overwriteConfigurationLayers() {
    const layers = this.overwrittingSnaphot?.layers;
    if (layers) {
      this.store.setConfigurationLayers(layers);
      this.overwrittingSnaphot = null;
      this.store.resetDatasetViewContrasts();
    }
    this.layersOverwritePanel = false;
  }

  async loadSnapshot(item: ISnapshotItem) {
    const snapshot = item.record;
    if (
      snapshot.datasetViewId &&
      snapshot.datasetViewId !== this.store.datasetView?.id
    ) {
      await this.store.setDatasetViewId(snapshot.datasetViewId);
    }
    if (this.areCurrentLayersCompatible(snapshot)) {
      await this.store.loadSnapshotLayers(snapshot);
    } else {
      this.openConfigurationLayersOverwritePanel(snapshot);
    }
    this.newName = snapshot.name || "";
    this.newDescription = snapshot.description || "";
    this.newTags = (snapshot.tags || []).slice();
    this.bboxLeft = snapshot.screenshot!.bbox!.left;
    this.bboxTop = snapshot.screenshot!.bbox!.top;
    this.bboxRight = snapshot.screenshot!.bbox!.right;
    this.bboxBottom = snapshot.screenshot!.bbox!.bottom;

    await Promise.all([
      this.store.setXY(snapshot.xy),
      this.store.setZ(snapshot.z),
      this.store.setTime(snapshot.time),

      this.store.setUnrollXY(snapshot.unrollXY),
      this.store.setUnrollZ(snapshot.unrollZ),
      this.store.setUnrollT(snapshot.unrollT),

      this.store.setConfigurationLayers(snapshot.layers),
      this.store.setLayerMode(snapshot.layerMode),
    ]);

    const map = this.firstMap;
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
    this.markCurrentArea();
  }

  updateFormValidation() {
    const formElem = this.$refs.saveSnapshotForm;
    if (formElem) {
      this.isSaveSnapshotValid = formElem.validate();
    }
  }

  resetFormValidation() {
    const formElem = this.$refs.saveSnapshotForm;
    if (formElem) {
      formElem.resetValidation();
    }
  }

  saveSnapshot(): void {
    this.updateFormValidation();
    const map = this.firstMap;
    const datasetView = this.store.datasetView;
    if (!this.isSaveSnapshotValid || !map || !datasetView) {
      return;
    }
    const snapshot: ISnapshot = {
      name: this.newName.trim(),
      description: this.newDescription.trim(),
      tags: this.newTags.slice(),
      created: this.currentSnapshot ? this.currentSnapshot.created : Date.now(),
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
          left: this.bboxLeft,
          top: this.bboxTop,
          right: this.bboxRight,
          bottom: this.bboxBottom,
        },
      },
    };
    this.resetAndCloseForm();
    this.store.addSnapshot(snapshot);
  }

  resetAndCloseForm() {
    this.createDialog = false;
    this.newName = "";
    this.newDescription = "";
    this.newTags = [];
    this.resetFormValidation();
  }

  removeSnapshot(name: string): void {
    this.store.removeSnapshot(name);
  }

  get currentSnapshot(): { [key: string]: any } | undefined {
    if (store.configuration && store.configuration.snapshots) {
      return store.configuration.snapshots
        .slice()
        .filter((s: ISnapshot) => s.name === this.newName)[0];
    }
    return;
  }

  async getUrlsForMovie(
    timePoints: number[],
    datasetId: string,
    boundingBox: IGeoJSBounds,
    layers: IDisplayLayer[],
    location: IDatasetLocation,
  ): Promise<URL[]> {
    // Get dataset
    const dataset =
      store.dataset?.id === datasetId
        ? store.dataset
        : await girderResources.getDataset({ id: datasetId });
    if (!dataset) {
      throw new Error("Dataset not found");
    }

    // Get the id of the image for this dataset
    const anyImage = dataset.anyImage();
    if (!anyImage) {
      throw new Error("No image found in dataset");
    }
    const itemId = anyImage.item._id;

    const params = getDownloadParameters(
      boundingBox,
      "png", // Using PNG for best quality
      this.maxPixels,
      95, // jpegQuality (unused for PNG)
      "layers",
    );

    if (params === null) {
      throw new Error("Image size exceeds maximum allowed pixels");
    }

    const apiRoot = store.girderRest.apiRoot;
    const baseUrl = getBaseURLFromDownloadParameters(params, itemId, apiRoot);

    // Get URLs for all time points
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

  async waitForRenderingComplete() {
    // Wait for the map to finish rendering
    // This function is a bit of a hack
    // In principle, we should be fine after drawEnd, but it doesn't seem to be enough
    // So we wait a bit longer
    // I found a wait time of 2000ms to be enough in some very limited testing,
    // but this would require broader testing
    // TODO: Find a more robust solution
    const map = this.firstMap;
    if (!map) {
      return;
    }

    // Promise that resolves when the map's drawing is complete
    const waitForMapDraw = new Promise<void>((resolve) => {
      const onDrawEnd = () => {
        map.geoOff(geojs.event.drawEnd, onDrawEnd);
        resolve();
      };

      // Listen for the drawEnd event
      map.geoOn(geojs.event.drawEnd, onDrawEnd);

      // Fallback timeout in case event doesn't fire
      setTimeout(resolve, 5000);
    });

    // Wait for map drawing to complete
    await waitForMapDraw;

    // Wait to ensure UI updates are complete
    // Use two animation frames to ensure a complete render cycle
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );

    // Additional 2000ms delay to fully let it finish
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  async getUrlsForMovieWithAnnotations(
    timePoints: number[],
    datasetId: string,
  ): Promise<string[]> {
    // Get dataset
    const dataset =
      store.dataset?.id === datasetId
        ? store.dataset
        : await girderResources.getDataset({ id: datasetId });
    if (!dataset) {
      throw new Error("Dataset not found");
    }

    const map = this.firstMap;
    if (!map) {
      throw new Error("Map not available");
    }

    // Array to store data URLs for screenshots
    const dataUrls: string[] = [];

    // Progress tracking
    const progressId = await this.progress.create({
      type: ProgressType.MOVIE_GENERATION,
      title: "Capturing frames with annotations",
    });

    try {
      // For each time point
      for (let i = 0; i < timePoints.length; i++) {
        const timePoint = timePoints[i];

        // Set the time in the store to update the view
        this.store.setTime(timePoint);

        // Wait for rendering to complete
        await this.waitForRenderingComplete();

        // Get visible layers except bounding box
        const visibleLayers = map
          .layers()
          .filter(
            (layer) =>
              layer !== this.bboxLayer &&
              layer.node().css("visibility") !== "hidden",
          );

        // Capture the full screenshot
        const fullScreenshot = await map.screenshot(visibleLayers);

        // Process the screenshot to crop to bounding box
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("Failed to get canvas context");
        }

        // Create an image element to load the screenshot
        const img = new Image();

        // Wait for the image to load
        await new Promise((resolve) => {
          img.onload = resolve;
          img.src = fullScreenshot;
        });

        // Convert bounding box GCS coordinates to display coordinates
        const topLeft = map.gcsToDisplay({ x: this.bboxLeft, y: this.bboxTop });
        const bottomRight = map.gcsToDisplay({
          x: this.bboxRight,
          y: this.bboxBottom,
        });

        // Calculate width and height in display pixels
        const width = bottomRight.x - topLeft.x;
        const height = bottomRight.y - topLeft.y;

        // Set canvas dimensions to match the bounding box
        canvas.width = width;
        canvas.height = height;

        // Draw the cropped image
        ctx.drawImage(
          img,
          topLeft.x,
          topLeft.y,
          width,
          height, // Source rectangle
          0,
          0,
          width,
          height, // Destination rectangle
        );

        // Add scalebar if requested
        if (this.addScalebar) {
          this.drawScalebarOnCanvas(ctx, width, height);
        }

        // Convert the canvas to a data URL and store it
        const dataUrl = canvas.toDataURL("image/png");
        dataUrls.push(dataUrl);

        // Update progress
        this.progress.update({
          id: progressId,
          progress: i + 1,
          total: timePoints.length,
          title: `Capturing frame ${i + 1} of ${timePoints.length}`,
        });
      }
    } finally {
      this.progress.complete(progressId);
    }

    return dataUrls;
  }

  async handleMovieDownload(params: {
    startTime: number;
    endTime: number;
    fps: number;
    format: MovieFormat;
    shouldAddTimeStamp: boolean;
    initialTimeStampTime: number;
    timeStampStep: number;
    timeStampUnits: string;
  }) {
    const dataset = this.store.dataset;
    if (!dataset) return;

    try {
      this.downloading = true;
      const timePoints = Array.from(
        { length: params.endTime - params.startTime + 1 },
        (_, i) => params.startTime + i,
      );

      let urls: URL[] | string[] = [];
      if (this.addAnnotationsToMovie) {
        urls = await this.getUrlsForMovieWithAnnotations(
          timePoints,
          dataset.id,
        );
      } else {
        urls = await this.getUrlsForMovie(
          timePoints,
          dataset.id,
          {
            left: this.bboxLeft,
            top: this.bboxTop,
            right: this.bboxRight,
            bottom: this.bboxBottom,
          },
          this.store.layers,
          this.store.currentLocation,
        );
      }

      switch (params.format) {
        case MovieFormat.ZIP:
          await this.downloadMovieAsZippedImageSequence(params, urls);
          break;
        case MovieFormat.GIF:
          await this.downloadMovieAsGif(params, urls);
          break;
        case MovieFormat.MP4:
          await this.downloadMovieAsVideo(params, urls, true);
          break;
        case MovieFormat.WEBM:
          await this.downloadMovieAsVideo(params, urls, false);
          break;
        default:
          logError("Unknown format:", params.format);
      }
    } catch (error) {
      logError("Movie download failed:", error);
    } finally {
      this.downloading = false;
    }
  }

  async downloadMovieAsZippedImageSequence(
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
    const progressId = await this.progress.create({
      type: ProgressType.MOVIE_GENERATION,
      title: "Generating ZIP sequence",
    });

    try {
      // Create and setup a zip object
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
        level: 0, // Don't compress PNGs since they're already compressed
      };

      // Download each image and add to zip
      for (let i = 0; i < urls.length; i++) {
        let imageData: ArrayBuffer;
        let imageUrl: string;

        if (typeof urls[i] === "string") {
          // It's a data URL string
          // Convert data URL to Blob and then to ArrayBuffer
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
          // It's a URL object, download the data
          const response = await this.store.girderRest.get(
            (urls[i] as URL).href,
            {
              responseType: "arraybuffer",
            },
          );
          imageData = response.data;
          // Create a blob from the image data
          const blob = new Blob([imageData], { type: "image/png" });
          imageUrl = URL.createObjectURL(blob);
        }

        if (params.shouldAddTimeStamp) {
          // Create an image element and wait for it to load
          const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = imageUrl;
          });

          // Create a canvas to draw the frame with annotations
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Failed to get canvas context");

          // Draw the original image
          ctx.drawImage(img, 0, 0);

          // Draw the scalebar using the helper method
          this.drawScalebarOnCanvas(ctx, canvas.width, canvas.height);

          // Clean up
          URL.revokeObjectURL(imageUrl);

          this.addTimeStampToCanvas(canvas, params, i);

          // Convert canvas to blob
          const annotatedBlob = await new Promise<Blob>((resolve) => {
            canvas.toBlob((blob) => resolve(blob!), "image/png");
          });

          // Convert blob to array buffer
          const arrayBuffer = await annotatedBlob.arrayBuffer();

          // Add to zip
          const fileName = `frame${(i + 1).toString().padStart(4, "0")}.png`;
          const zipFile = new ZipDeflate(fileName, deflateOptions);
          zip.add(zipFile);
          zipFile.push(new Uint8Array(arrayBuffer), true);
        } else {
          // Add to zip without timestamp
          const fileName = `frame${(i + 1).toString().padStart(4, "0")}.png`;
          const zipFile = new ZipDeflate(fileName, deflateOptions);
          zip.add(zipFile);
          zipFile.push(new Uint8Array(imageData), true);

          // Only revoke object URL if we created it and used it
          if (typeof urls[i] !== "string") {
            URL.revokeObjectURL(imageUrl);
          }
        }

        this.progress.update({
          id: progressId,
          progress: i + 1,
          total: urls.length,
          title: "Processing frame",
        });
      }

      // End the zip and wait for it to complete
      zip.end();
      const blob = await zipDone;

      const url = URL.createObjectURL(blob);
      downloadToClient({
        href: url,
        download: `timelapse_${params.startTime}_${params.endTime}.zip`,
      });
      URL.revokeObjectURL(url);
    } finally {
      this.progress.complete(progressId);
    }
  }

  async downloadMovieAsGif(
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
    const progressId = await this.progress.create({
      type: ProgressType.MOVIE_GENERATION,
      title: "Generating GIF",
    });

    try {
      // Create a GIF encoder
      const gifOptions: IGifOptions = {
        workers: 4,
        quality: 10,
        workerScript: "/gif.worker.js",
        width: null, // Will be set automatically
        height: null, // Will be set automatically
        workerOptions: {
          willReadFrequently: true,
        },
      };
      const gif = new GIF(gifOptions);

      // Load all images and add them to the GIF sequentially
      const totalFrames = urls.length;

      // Process frames one at a time to maintain order
      for (let i = 0; i < urls.length; i++) {
        // Check if we're dealing with a URL or a data URL string
        let imageUrl: string;
        if (typeof urls[i] === "string") {
          // It's already a data URL string from screenshots with annotations
          imageUrl = urls[i] as string;
        } else {
          // It's a URL object, download the image data
          const { data } = await this.store.girderRest.get(
            (urls[i] as URL).href,
            {
              responseType: "arraybuffer",
            },
          );
          // Convert array buffer to blob
          const blob = new Blob([data], { type: "image/png" });
          imageUrl = URL.createObjectURL(blob);
        }

        // Create an image element and wait for it to load
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => {
            if (params.shouldAddTimeStamp) {
              // Create a temporary canvas to draw the frame with annotations
              const canvas = document.createElement("canvas");
              canvas.width = img.width;
              canvas.height = img.height;
              const ctx = canvas.getContext("2d");
              if (!ctx) throw new Error("Failed to get canvas context");

              // Draw the original image
              ctx.drawImage(img, 0, 0);

              // Draw the scalebar using the helper method
              this.drawScalebarOnCanvas(ctx, canvas.width, canvas.height);

              this.addTimeStampToCanvas(canvas, params, i);

              // Add the annotated canvas frame to the GIF instead of the original image
              gif.addFrame(canvas, { delay: 1000 / params.fps });
            } else {
              gif.addFrame(img, { delay: 1000 / params.fps }); // delay in ms
            }

            this.progress.update({
              id: progressId,
              progress: i + 1,
              total: totalFrames * 2, // Account for both loading and rendering phases
              title: "Loading frame",
            });

            // Only revoke object URL if we created it (for URL objects)
            if (typeof urls[i] !== "string") {
              URL.revokeObjectURL(imageUrl);
            }

            resolve();
          };
          img.onerror = reject;
          img.src = imageUrl;
        });
      }

      // The rest of the function is unchanged
      const gifBlob = await new Promise<Blob>((resolve) => {
        gif.on("progress", (progressValue: number) => {
          // Update progress for rendering phase
          this.progress.update({
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

      // Download the GIF
      const url = URL.createObjectURL(gifBlob);
      downloadToClient({
        href: url,
        download: `timelapse_${params.startTime}_${params.endTime}.gif`,
      });
      URL.revokeObjectURL(url);
    } finally {
      this.progress.complete(progressId);
    }
  }

  async downloadMovieAsVideo(
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
    // Detect supported MIME type
    const mimeType = getSupportedVideoMimeType(preferMp4);
    if (!mimeType) {
      throw new Error("No supported video format found in this browser");
    }
    const fileExtension = getVideoFileExtension(mimeType);
    const formatLabel = fileExtension.toUpperCase();

    const progressId = await this.progress.create({
      type: ProgressType.MOVIE_GENERATION,
      title: `Generating ${formatLabel} video`,
    });

    try {
      // First pass: get dimensions from first frame
      let firstFrameUrl: string;
      if (typeof urls[0] === "string") {
        // It's already a data URL string
        firstFrameUrl = urls[0] as string;
      } else {
        // It's a URL object, download the data
        const firstFrameResponse = await this.store.girderRest.get(
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

      // Only revoke object URL if we created it
      if (typeof urls[0] !== "string") {
        URL.revokeObjectURL(firstFrameUrl);
      }

      // Setup canvas and media recorder
      const canvas = document.createElement("canvas");
      canvas.width = firstImage.width;
      canvas.height = firstImage.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Failed to get canvas context");

      const stream = canvas.captureStream(params.fps);
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 8000000, // 8Mbps
      });

      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      // Start recording
      mediaRecorder.start();

      // Process all frames
      let currentFrame = 0;
      const frameDuration = 1000 / params.fps;

      const processNextFrame = async () => {
        if (currentFrame >= urls.length) {
          mediaRecorder.stop();
          return;
        }

        // Get frame data - either from data URL or by downloading
        let imageUrl: string;
        if (typeof urls[currentFrame] === "string") {
          // It's a data URL string
          imageUrl = urls[currentFrame] as string;
        } else {
          // It's a URL object, download the data
          const { data } = await this.store.girderRest.get(
            (urls[currentFrame] as URL).href,
            {
              responseType: "arraybuffer",
            },
          );
          const blob = new Blob([data], { type: "image/png" });
          imageUrl = URL.createObjectURL(blob);
        }

        // Draw frame
        await new Promise<void>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            // Only revoke object URL if we created it
            if (typeof urls[currentFrame] !== "string") {
              URL.revokeObjectURL(imageUrl);
            }

            resolve();
          };
          img.onerror = reject;
          img.src = imageUrl;
        });

        if (params.shouldAddTimeStamp) {
          this.addTimeStampToCanvas(canvas, params, currentFrame);
        }

        this.progress.update({
          id: progressId,
          progress: currentFrame + 1,
          total: urls.length,
          title: "Processing frame",
        });

        currentFrame++;
        setTimeout(processNextFrame, frameDuration);
      };

      // Wait for recording to complete
      const videoBlob = await new Promise<Blob>((resolve) => {
        mediaRecorder.onstop = () => {
          const blob = new Blob(chunks, { type: mimeType });
          resolve(blob);
        };
        processNextFrame();
      });

      // Cleanup
      stream.getTracks().forEach((track) => track.stop());

      // Download the video
      const url = URL.createObjectURL(videoBlob);
      downloadToClient({
        href: url,
        download: `timelapse_${params.startTime}_${params.endTime}.${fileExtension}`,
      });
      URL.revokeObjectURL(url);
    } finally {
      this.progress.complete(progressId);
    }
  }

  addTimeStampToCanvas(
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

    // Add timestamp overlay
    ctx.fillStyle = "white"; // Text color
    ctx.strokeStyle = "black"; // Text outline color
    ctx.lineWidth = 3; // Text outline width
    ctx.font = "24px Arial"; // Text font and size
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";

    const timeText = `T=${params.initialTimeStampTime + frameIndex * params.timeStampStep} ${params.timeStampUnits}`;
    // Draw text outline
    ctx.strokeText(timeText, 10, canvas.height - 10);
    // Draw text fill
    ctx.fillText(timeText, 10, canvas.height - 10);
  }

  handlePixelSizeModeChange() {
    if (this.pixelSizeMode === "manual") {
      this.manualPixelSize = this.configurationPixelSize;
    }
  }

  handleScalebarModeChange() {
    if (this.scalebarMode === "manual") {
      this.manualScalebarSettings = this.scalebarSettings;
    }
  }

  get pixelSizeUnitItems() {
    // pixelSize can always be any unit.
    return [
      { text: "Nanometers (nm)", value: TScalebarUnit.NM },
      { text: "Micrometers (µm)", value: TScalebarUnit.UM },
      { text: "Millimeters (mm)", value: TScalebarUnit.MM },
      { text: "Meters (m)", value: TScalebarUnit.M },
      { text: "Pixels (px)", value: TScalebarUnit.PX },
    ];
  }

  get scalebarSettingsUnitItems() {
    if (this.pixelSize.unit === "px") {
      return [{ text: "Pixels (px)", value: TScalebarUnit.PX }];
    }
    return [
      { text: "Nanometers (nm)", value: TScalebarUnit.NM },
      { text: "Micrometers (µm)", value: TScalebarUnit.UM },
      { text: "Millimeters (mm)", value: TScalebarUnit.MM },
      { text: "Meters (m)", value: TScalebarUnit.M },
      { text: "Pixels (px)", value: TScalebarUnit.PX },
    ];
  }

  // Private helper to draw the scalebar onto a canvas
  private drawScalebarOnCanvas(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
  ) {
    // Calculate scalebar length in pixels
    const scalebarLength = this.scalebarLengthInPixels;
    const maxDim = Math.max(width, height);

    // Scale padding linearly (2% of max dimension), clamped [10, 40]
    const padding = Math.max(10, Math.min(40, 0.02 * maxDim));
    // Scale line width linearly (0.5% of max dimension), clamped [2, 8]
    const lineWidth = Math.max(3, Math.min(12, 0.008 * maxDim));
    // Scale font size linearly (1.5% of max dimension), clamped [12, 24]
    const fontSize = Math.max(12, Math.min(24, 0.02 * maxDim));

    // Set styles
    ctx.strokeStyle = this.snapshotScalebarColor;
    ctx.fillStyle = this.snapshotScalebarColor;
    ctx.lineWidth = lineWidth;

    // Draw the scalebar line
    ctx.beginPath();
    // Position from bottom-right corner with padding
    ctx.moveTo(width - padding, height - padding);
    ctx.lineTo(width - padding - scalebarLength, height - padding);
    ctx.stroke();

    // Add text for the scalebar if enabled
    if (this.addScalebarText) {
      ctx.font = `${fontSize}px Arial`;
      ctx.textBaseline = "bottom";
      ctx.textAlign = "right";
      // Position text above the line, considering padding and font size
      ctx.fillText(
        `${this.scalebarSettings.length}${this.scalebarSettings.unit}`,
        width - padding,
        height - padding - lineWidth, // Place text just above the line
      );
    }
  }
}
</script>
