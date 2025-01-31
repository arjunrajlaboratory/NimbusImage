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
            @click="movieDialog = true"
            :disabled="unroll || downloading"
          >
            Download Movie for Current Location
          </v-btn>
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

export enum MovieFormat {
  ZIP = "zip",
  GIF = "gif",
  WEBM = "webm",
}

@Component({ components: { TagPicker, MovieDialog } })
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
  downloadMode: "layers" | "channels" = "layers";
  exportLayer: "all" | "composite" | string = "composite";
  exportChannel: "all" | number = "all";
  format: string = "png";

  layersOverwritePanel: boolean = false;
  overwrittingSnaphot: ISnapshot | null = null;

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
      await this.downloadUrls(urls);
    } finally {
      this.downloading = false;
    }
  }

  async downloadImagesForAllSnapshots() {
    this.downloading = true;

    try {
      const allUrls: URL[] = [];
      const configuration = this.store.configuration;
      if (!configuration) {
        return;
      }
      for (const snapshot of configuration.snapshots || []) {
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
      await this.downloadUrls(allUrls);
    } finally {
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

  async downloadUrls(urls: URL[]) {
    if (urls.length <= 0) {
      return;
    }

    if (urls.length === 1) {
      downloadToClient({ href: urls[0].href });
      return;
    }

    // Create and setup a zip object
    const zip: Zip = new Zip();
    const zipChunks: Uint8Array[] = [];
    const zipDone: Promise<Blob> = new Promise((resolve, reject) => {
      zip.ondata = (err, data, final) => {
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
      zipFile.push(new Uint8Array(data), true);
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
    if (this.bboxHeight <= 0 && this.bboxWidth <= 0) {
      const inset = 20; // in pixels
      const topLeft = map.displayToGcs({ x: inset, y: inset });
      const bottomRight = map.displayToGcs({
        x: map.size().width - inset,
        y: map.size().height - inset,
      });
      this.bboxLeft = topLeft.x;
      this.bboxTop = topLeft.y;
      this.bboxRight = bottomRight.x;
      this.bboxBottom = bottomRight.y;
    }
    if (show && map) {
      const bounds = map.bounds();
      if (this.bboxLeft === null) {
        const screenBounds = map.gcsToDisplay([
          { x: bounds.left, y: bounds.top },
          { x: bounds.right, y: bounds.bottom },
        ]);
        const shrinkIn = 20;
        const innerBounds = map.displayToGcs([
          { x: screenBounds[0].x + shrinkIn, y: screenBounds[0].y + shrinkIn },
          { x: screenBounds[1].x - shrinkIn, y: screenBounds[1].y - shrinkIn },
        ]);
        this.setBoundingBox(
          innerBounds[0].x,
          innerBounds[0].y,
          innerBounds[1].x,
          innerBounds[1].y,
        );
      }
      if (!this.bboxLayer) {
        this.bboxLayer = map.createLayer("annotation", {
          autoshareRenderer: false,
          showLabels: false,
        });
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
        this.bboxLayer.addAnnotation(this.bboxAnnotation);
        map.draw();
      }
    } else {
      if (this.bboxLayer) {
        this.doneBoundingBox(true);
        map.deleteLayer(this.bboxLayer);
        this.bboxLayer = null;
        this.bboxAnnotation = null;
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
    if (this.bboxLayer && this.bboxAnnotation && map) {
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
      this.bboxLayer.draw();
    }
    return w * h;
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
        (a, b) => (b.modified || b.created) - (a.modified || a.created),
      );
      snapshots.forEach((s) => {
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
        .filter((s) => s.name === this.newName)[0];
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

  async handleMovieDownload(params: {
    startTime: number;
    endTime: number;
    fps: number;
    format: MovieFormat;
  }) {
    const dataset = this.store.dataset;
    if (!dataset) return;

    try {
      this.downloading = true;
      const timePoints = Array.from(
        { length: params.endTime - params.startTime + 1 },
        (_, i) => params.startTime + i,
      );

      const urls = await this.getUrlsForMovie(
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

      switch (params.format) {
        case MovieFormat.ZIP:
          await this.downloadMovieAsZippedImageSequence(params, urls);
          break;
        case MovieFormat.GIF:
          await this.downloadMovieAsGif(params, urls);
          break;
        case MovieFormat.WEBM:
          await this.downloadMovieAsWebm(params, urls);
          break;
        default:
          logError("Unknown format:", params.format);
      }
    } finally {
      this.downloading = false;
    }
  }

  async downloadMovieAsZippedImageSequence(
    params: {
      startTime: number;
      endTime: number;
      fps: number;
    },
    urls: URL[],
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
        zip.ondata = (err, data, final) => {
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
        const { data } = await this.store.girderRest.get(urls[i].href, {
          responseType: "arraybuffer",
        });

        const fileName = `frame${(i + 1).toString().padStart(3, "0")}.png`;
        const zipFile = new ZipDeflate(fileName, deflateOptions);
        zip.add(zipFile);
        zipFile.push(new Uint8Array(data), true);

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
    },
    urls: URL[],
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
        // Download the image data
        const { data } = await this.store.girderRest.get(urls[i].href, {
          responseType: "arraybuffer",
        });

        // Convert array buffer to blob
        const blob = new Blob([data], { type: "image/png" });
        const imageUrl = URL.createObjectURL(blob);

        // Create an image element and wait for it to load
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => {
            gif.addFrame(img, { delay: 1000 / params.fps }); // delay in ms
            this.progress.update({
              id: progressId,
              progress: i + 1,
              total: totalFrames * 2, // Account for both loading and rendering phases
              title: "Loading frame",
            });
            URL.revokeObjectURL(imageUrl); // Clean up the object URL
            resolve();
          };
          img.onerror = reject;
          img.src = imageUrl;
        });
      }

      // Render the GIF
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

  async downloadMovieAsWebm(
    params: {
      startTime: number;
      endTime: number;
      fps: number;
    },
    urls: URL[],
  ) {
    const progressId = await this.progress.create({
      type: ProgressType.MOVIE_GENERATION,
      title: "Generating WebM video",
    });

    try {
      // First pass: get dimensions from first frame
      const firstFrameResponse = await this.store.girderRest.get(urls[0].href, {
        responseType: "arraybuffer",
      });
      const firstFrameBlob = new Blob([firstFrameResponse.data], {
        type: "image/png",
      });
      const firstFrameUrl = URL.createObjectURL(firstFrameBlob);
      const firstImage = await new Promise<HTMLImageElement>(
        (resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = firstFrameUrl;
        },
      );
      URL.revokeObjectURL(firstFrameUrl);

      // Setup canvas and media recorder
      const canvas = document.createElement("canvas");
      canvas.width = firstImage.width;
      canvas.height = firstImage.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Failed to get canvas context");

      const stream = canvas.captureStream(params.fps);
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: "video/webm",
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

        // Download and process frame
        const { data } = await this.store.girderRest.get(
          urls[currentFrame].href,
          {
            responseType: "arraybuffer",
          },
        );
        const blob = new Blob([data], { type: "image/png" });
        const imageUrl = URL.createObjectURL(blob);

        // Draw frame
        await new Promise<void>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(imageUrl);
            resolve();
          };
          img.onerror = reject;
          img.src = imageUrl;
        });

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
          const blob = new Blob(chunks, { type: "video/webm" });
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
        download: `timelapse_${params.startTime}_${params.endTime}.webm`,
      });
      URL.revokeObjectURL(url);
    } finally {
      this.progress.complete(progressId);
    }
  }
}
</script>
