<template>
  <v-container>
    <v-card class="pa-4 my-4">
      <v-subheader id="variables-tourstep" class="headline"
        >Variables</v-subheader
      >
      <v-divider class="my-2" />
      <v-data-table :headers="headers" :items="items" item-key="key" />
      <v-checkbox
        v-if="isMultiBandRGBFile"
        v-model="splitRGBBands"
        label="Split RGB files into separate channels (otherwise, only the red channel will be used)"
        class="mt-4"
        hide-details
        dense
      />
    </v-card>
    <v-card v-if="initializing" class="my-4">
      <v-card-title>
        <v-progress-circular indeterminate class="mr-4" />
        Computing all variables from dataset information
      </v-card-title>
    </v-card>
    <v-card class="pa-4 my-4" v-else>
      <div class="d-flex">
        <v-subheader id="assignments-tourstep" class="headline"
          >Assignments</v-subheader
        >
        <v-spacer />
        <v-btn
          @click="resetDimensionsToDefault"
          :disabled="areDimensionsSetToDefault()"
          class="ml-4"
        >
          Reset to defaults
          <v-icon class="pl-1">mdi-reload</v-icon>
        </v-btn>
      </div>
      <v-divider class="my-2" />
      <v-container>
        <v-row
          v-for="[dimension, dimensionName] in dimesionNamesEntries"
          :key="dimension"
        >
          <v-col cols="2" class="body-1">
            {{ dimensionName }} ({{ dimension }})
          </v-col>
          <v-col>
            <v-combobox
              v-model="assignments[dimension]"
              :items="assignmentItems"
              :search-input.sync="searchInput"
              item-text="text"
              item-value="value"
              hide-selected
              hide-details
              dense
              :disabled="assignmentDisabled(dimension)"
            >
              <template v-slot:selection="{ item }">
                {{ item.text }}
                <template v-if="shouldDoCompositing && dimension === 'XY'">
                  (will be composited)
                </template>
              </template>
            </v-combobox>
          </v-col>
          <v-col v-if="canDoCompositing && dimension === 'XY'">
            <v-checkbox
              dense
              label="Composite positions into single image"
              class="d-inline-flex"
              v-model="enableCompositing"
            />
          </v-col>
          <v-col cols="2" class="d-flex">
            <v-spacer />
            <v-btn
              :disabled="clearDisabled(dimension)"
              @click="assignments[dimension] = null"
            >
              Clear
            </v-btn>
          </v-col>
        </v-row>
      </v-container>
    </v-card>
    <v-row>
      <v-col class="d-flex">
        <v-alert v-if="submitError" type="error" text dense class="mr-4">
          {{ submitError }}
        </v-alert>
        <v-spacer />
      </v-col>
      <v-col class="d-flex justify-end">
        <v-checkbox
          id="transcode-checkbox-tourstep"
          dense
          hide-details
          class="mr-8"
          v-model="transcode"
          label="Transcode into optimized TIFF file"
        />
        <v-btn
          id="submit-button-tourstep"
          v-tour-trigger="'submit-button-tourtrigger'"
          @click="submit"
          color="green"
          :disabled="!submitEnabled() || !isRGBAssignmentValid || isUploading"
        >
          <v-progress-circular size="16" v-if="isUploading" indeterminate />
          Submit
        </v-btn>
      </v-col>
    </v-row>

    <!-- Progress bar and status for transcoding -->
    <v-card class="mt-4" v-if="isUploading">
      <v-card-text>
        <div class="d-flex align-center mb-2">
          <div class="text-subtitle-1 mr-3">{{ progressStatusText }}</div>
          <v-spacer></v-spacer>
          <v-btn
            small
            text
            color="info"
            @click="showLogDialog = true"
            class="ml-2"
          >
            <v-icon small left>mdi-text-box-outline</v-icon>
            View Log
          </v-btn>
        </div>
        <v-progress-linear
          :value="transcodeProgress"
          height="20"
          striped
          color="primary"
        >
          <template v-slot:default>
            <span class="white--text">{{ Math.ceil(transcodeProgress) }}%</span>
          </template>
        </v-progress-linear>
      </v-card-text>
    </v-card>

    <!-- Log Dialog -->
    <v-dialog v-model="showLogDialog" max-width="800px">
      <v-card>
        <v-card-title class="headline">
          Transcoding Log
          <v-spacer></v-spacer>
          <v-tooltip bottom>
            <template v-slot:activator="{ on, attrs }">
              <v-btn icon v-bind="attrs" v-on="on" @click="copyLogToClipboard">
                <v-icon>mdi-content-copy</v-icon>
              </v-btn>
            </template>
            <span>Copy to clipboard</span>
          </v-tooltip>
          <v-btn icon @click="showLogDialog = false">
            <v-icon>mdi-close</v-icon>
          </v-btn>
        </v-card-title>
        <v-card-text>
          <pre class="job-log">{{ logs }}</pre>
        </v-card-text>
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn color="primary" text @click="showLogDialog = false"
            >Close</v-btn
          >
        </v-card-actions>
        <!-- Snackbar for copy notification -->
        <v-snackbar
          v-model="showCopySnackbar"
          :timeout="2000"
          color="success"
          top
        >
          Log copied to clipboard
        </v-snackbar>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script lang="ts">
import { Vue, Component, Watch, Prop } from "vue-property-decorator";
import store from "@/store";

import {
  collectFilenameMetadata2,
  IVariableGuess,
  TDimensions,
} from "@/utils/parsing";
import { IGirderItem } from "@/girder";
import { ITileMeta } from "@/store/GirderAPI";
import { IGeoJSPositionWithTransform, IJobEventData } from "@/store/model";
import { logError } from "@/utils/log";
import { parseTranscodeOutput } from "@/utils/strings";

// Possible sources for variables
enum Sources {
  File = "file", // File metadata
  Filename = "filename", // Filenames parsing
  Images = "images", // All images from the items
}

interface IFileSourceData {
  [itemIdx: number]: {
    stride: number;
    range: number;
    values: string[] | null;
  };
}

interface IFilenameSourceData extends IVariableGuess {}

interface IBaseAssignmentOption {
  id: number;
  guess: TDimensions; // Guessed dimension
  size: number; // Number of elements on this dimension
  name: string; // Displayed name
}

interface IFileAssignmentOption extends IBaseAssignmentOption {
  source: Sources.File;
  data: IFileSourceData; // To compute which image should be taken from the tiles
}

interface IFilenameAssignementOption extends IBaseAssignmentOption {
  source: Sources.Filename;
  data: IFilenameSourceData; // To compute which image should be taken from the tiles
}

interface IImageAssinmentOption extends IBaseAssignmentOption {
  source: Sources.Images;
  data: null;
}

type TAssignmentOption =
  | IFileAssignmentOption
  | IFilenameAssignementOption
  | IImageAssinmentOption;

interface IAssignment {
  text: string;
  value: TAssignmentOption;
}

type TUpDim = "XY" | "Z" | "T" | "C";

type TLowDim = "xy" | "z" | "t" | "c";

type TFramesAsAxes = {
  [dim in TLowDim]?: number;
};

interface IBasicSource {
  path: string;
  xyValues?: number[];
  zValues?: number[];
  tValues?: number[];
  cValues?: number[];
  framesAsAxes?: TFramesAsAxes;
  style?: {
    bands: { band: number }[];
  };
  c?: number;
}

interface ICompositingSource {
  path: string;
  xySet: number;
  zSet: number;
  tSet: number;
  cSet: number;
  frames: number[];
  position?: {
    x: number;
    y: number;
    s11?: number;
    s12?: number;
    s21?: number;
    s22?: number;
  };
  style?: {
    bands: { band: number }[];
  };
}

@Component({
  components: {},
})
export default class MultiSourceConfiguration extends Vue {
  readonly store = store;

  @Prop({ required: true })
  datasetId!: string;

  @Prop({ default: true })
  autoDatasetRoute!: boolean;

  tilesInternalMetadata: { [key: string]: any }[] | null = null;
  tilesMetadata: ITileMeta[] | null = null;

  enableCompositing: boolean = false;

  transcode: boolean = false;

  isUploading: boolean = false;
  logs: string = "";

  // For the transcodinglog dialog
  showLogDialog: boolean = false;
  showCopySnackbar: boolean = false;

  // For progress tracking of the transcoding
  transcodeProgress: number = 0;
  progressStatusText: string = "";
  totalFrames: number = 0;
  currentFrame: number = 0;

  isRGBFile: boolean = false;
  rgbBandCount: number = 0;

  splitRGBBands: boolean = true;

  get isMultiBandRGBFile(): boolean {
    return this.isRGBFile && this.rgbBandCount > 1;
  }

  detectColorVsChannels(tileMeta: ITileMeta) {
    const bandCount = tileMeta.bandCount || 1;
    let isColor = false;

    // 1) Check photometricInterpretation first, if present
    const photo = tileMeta.metadata?.photometricInterpretation;
    if (photo === 2 || photo === "RGB") {
      isColor = true;
    }

    // 2) If we have an explicit channel dimension > 1,
    //    that means multi-channel, not a single-plane color.
    //    In that case, override isColor = false
    if (tileMeta.IndexRange?.IndexC > 1) {
      isColor = false;
    }

    // 3) If we still don't know, fallback to:
    //    - bandCount = 3 (or 4) => color
    //    - otherwise => multi-channel
    if (typeof photo === "undefined") {
      if (bandCount === 3 || bandCount === 4) {
        isColor = true;
      }
    }

    return isColor;
  }

  // Call join on the array, cutting out elements or the first word if too long and adding hyphens
  // Output is always shorter than maxChars
  // For example: ["foo", "bar", "foobar", "barfoo"] => "foo, bar, foobar..."
  sliceAndJoin(arr: string[], maxChars: number = 16, sep: string = ", ") {
    if (arr.length <= 0) {
      return "";
    }
    // First element is too long
    if (
      arr[0].length > maxChars ||
      (arr[0].length === maxChars && arr.length > 1)
    ) {
      return arr[0].slice(0, maxChars - 1) + "…";
    }
    // Add words until the limit of characters is reached or exceeded
    let nWords = 1;
    let nChars = arr[0].length;
    while (nChars < maxChars && nWords < arr.length) {
      nChars += sep.length + arr[nWords].length;
      ++nWords;
    }
    // The whole string fits
    if (nChars <= maxChars && nWords === arr.length) {
      return arr.join(sep);
    }
    // Remove the last word and add hyphens
    return arr.slice(0, nWords - 1).join(sep) + "…";
  }

  get canDoCompositing() {
    return (
      this.tilesInternalMetadata !== null &&
      this.tilesInternalMetadata.length === 1 &&
      this.tilesInternalMetadata[0].nd2_frame_metadata &&
      this.tilesMetadata !== null &&
      this.tilesMetadata.length === 1
    );
  }

  get shouldDoCompositing() {
    return this.canDoCompositing && this.enableCompositing;
  }

  get items() {
    return this.dimensions
      .filter((dim) => dim.size > 0)
      .map((dim: TAssignmentOption) => {
        let values = "";
        switch (dim.source) {
          case Sources.Filename:
            values = this.sliceAndJoin(
              (dim.data as IFilenameSourceData).values,
            );
            break;
          case Sources.File:
            values = "From metadata";
            break;
        }
        return {
          ...dim,
          values,
          key: `${dim.id}_${dim.guess}_${dim.source}`,
        };
      });
  }

  dimensions: TAssignmentOption[] = [];

  headers = [
    {
      text: "Variable",
      value: "name",
    },
    {
      text: "Values",
      value: "values",
    },
    {
      text: "Guess",
      value: "guess",
    },
    {
      text: "Source",
      value: "source",
    },
    {
      text: "Size",
      value: "size",
    },
  ];

  readonly dimensionNames: { [dim in TUpDim]: string } = {
    XY: "Positions",
    Z: "Z",
    T: "Time",
    C: "Channels",
  };

  readonly dimesionNamesEntries = Object.entries(this.dimensionNames) as [
    TUpDim,
    string,
  ][];

  assignmentOptionToAssignmentItem(dimension: TAssignmentOption): IAssignment {
    return {
      text: dimension.name,
      value: dimension,
    };
  }

  get assignmentItems() {
    const assignedDimensions = Object.entries(this.assignments).reduce(
      (assignedDimensions, [, assignment]) =>
        assignment
          ? [...assignedDimensions, assignment.value.id]
          : assignedDimensions,
      [] as number[],
    );

    const isNotAssigned = (dimension: TAssignmentOption) =>
      !assignedDimensions.includes(dimension.id);
    return this.items
      .filter(isNotAssigned)
      .map(this.assignmentOptionToAssignmentItem);
  }

  assignments: { [dimension in TUpDim]: IAssignment | null } = {
    XY: null,
    Z: null,
    T: null,
    C: null,
  };

  searchInput: string = "";
  filenameVariableCount = 0;
  fileVariableCount = 0;
  imageVariableCount = 0;
  assignmentIdCount = 0;

  addSizeToDimension(
    guess: TDimensions,
    size: number,
    sourceData:
      | {
          source: Sources.File;
          data: IFileSourceData;
        }
      | {
          source: Sources.Filename;
          data: IFilenameSourceData;
        }
      | {
          source: Sources.Images;
          data: null;
        },
    name: string | null = null,
  ): void {
    if (size === 0) {
      return;
    }
    const { source, data } = sourceData;

    // Merge the dimension when the source is file and source and guess match
    const dim =
      source === Sources.File &&
      this.dimensions.find(
        (dimension) => dimension.source === source && dimension.guess === guess,
      );
    if (dim) {
      dim.data = {
        ...(dim.data as IFileSourceData),
        ...(data as IFileSourceData),
      };
      dim.size = Math.max(dim.size, size);
      return;
    }

    // If no merge, compute the name if needed and add to this.dimensions
    let computedName = name;
    if (!computedName) {
      computedName = "";
      switch (source) {
        case Sources.Filename:
          computedName = `Filename variable ${++this.filenameVariableCount}`;
          break;
        case Sources.File:
          computedName = `Metadata ${++this.fileVariableCount} (${
            this.dimensionNames[guess]
          })`;
          break;
        case Sources.Images:
          computedName = `Image variable ${++this.imageVariableCount}`;
          break;
      }
    }
    const newDimension: TAssignmentOption = {
      id: this.assignmentIdCount++,
      guess,
      size,
      name: computedName,
      ...sourceData,
    };
    this.dimensions = [...this.dimensions, newDimension];
  }

  girderItems: IGirderItem[] = [];

  getDefaultAssignmentItem(assignment: string) {
    const assignmentOption =
      this.dimensions.find(
        ({ guess, source, size }) =>
          source === Sources.File && size > 0 && guess === assignment,
      ) ||
      this.dimensions.find(
        ({ guess, size }) => size > 0 && guess === assignment,
      ) ||
      null;
    if (assignmentOption) {
      return this.assignmentOptionToAssignmentItem(assignmentOption);
    } else {
      return null;
    }
  }

  // Used by other component to check if this one is initialized
  public initialized: Promise<void> | null = null;

  mounted() {
    this.initialized = this.initialize();
  }

  initializing = false;
  reinitialize = false;
  @Watch("datasetId")
  async initialize() {
    if (this.initializing) {
      this.reinitialize = true;
      return;
    }
    this.initializing = true;
    do {
      this.reinitialize = false;
      await this.initializeImplementation();
    } while (this.reinitialize);
    this.initializing = false;
  }

  async initializeImplementation() {
    // Get tile information
    const items = await this.store.api.getItems(this.datasetId);
    this.girderItems = items;

    //  Get info from filename
    const names = items.map((item) => item.name);

    // Enable transcoding by default except for ND2 files
    this.transcode = !names.every((name: string) =>
      name.toLowerCase().endsWith("nd2"),
    );

    // Add variables from filenames if there is more than one file
    if (names.length > 1) {
      collectFilenameMetadata2(names).forEach((filenameData) =>
        this.addSizeToDimension(
          filenameData.guess,
          filenameData.values.length,
          {
            source: Sources.Filename,
            data: filenameData,
          },
        ),
      );
    }

    // Check for OIB files; for whatever reason, these need to be
    // explicitly turned into large images before we can get information from it
    const fileExtensions = names.map((name: string) => {
      const parts = name.split(".");
      return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
    });
    const hasOibFiles = fileExtensions.includes("oib");

    // For OIB files, explicitly try to create a large image first
    if (hasOibFiles) {
      try {
        // Process each OIB file to ensure it has a large image
        for (const item of items) {
          if (item.name.toLowerCase().endsWith(".oib")) {
            try {
              await this.store.api.createLargeImage(item);
              // Wait longer for OIB processing
              await new Promise((r) => setTimeout(r, 5000));
            } catch (createError) {
              logError(
                `Error creating large image for ${item.name}:`,
                createError,
              );
              // Continue anyway - the item might already have a large image
            }
          }
        }
      } catch (error) {
        logError("Error in OIB pre-processing:", error);
      }
    }

    let retries = 0;
    const maxRetries = hasOibFiles ? 15 : 10; // More retries for OIB files

    // Get info from file
    // The getTiles API from large_image expects the field large_image to be set when recovering the tiles,
    // but due to the S3 assetstore, that field can take a bit of time to be set.
    // Retry that function a few times if it fails to wait for that field to be set.
    while (retries < maxRetries) {
      try {
        this.tilesMetadata = await Promise.all(
          items.map(async (item) => {
            return this.store.api.getTiles(item);
          }),
        );

        break;
      } catch (error: any) {
        logError(
          `Error retrieving tiles (attempt ${retries + 1}):`,
          error?.response?.data?.message || error.message,
        );

        // Handle OIB files specially
        if (hasOibFiles) {
          await new Promise((r) => setTimeout(r, 3000)); // 3-second delay for OIB files
          retries++;
          continue;
        }

        // Standard error handling
        if (
          error?.response?.data?.message != "No large image file in this item."
        ) {
          throw error;
        }
        await new Promise((r) => setTimeout(r, 1000));
        retries++;
      }
    }

    // If we still couldn't get tiles metadata after all retries
    if (!this.tilesMetadata) {
      logError("Failed to retrieve tiles metadata after maximum retries");
      throw "Could not retrieve tiles from Girder";
    }

    this.tilesInternalMetadata = await Promise.all(
      items.map((item) => this.store.api.getTilesInternalMetadata(item)),
    );

    // Check for RGB bands
    const firstItem = this.tilesMetadata[0];
    this.rgbBandCount = firstItem?.bandCount || 0;
    this.isRGBFile = this.detectColorVsChannels(firstItem);

    let maxFramesPerItem = 0;
    let hasFileVariable = false;
    this.tilesMetadata.forEach((tile, tileIdx) => {
      const frames: number = tile.frames?.length || 1;
      maxFramesPerItem = Math.max(maxFramesPerItem, frames);
      if (tile.IndexRange && tile.IndexStride) {
        hasFileVariable = true;
        for (const dim in this.dimensionNames) {
          const indexDim = `Index${dim}`;
          this.addSizeToDimension(
            // We know that the keys of this.dimensionNames are of type TDimensions
            dim as TDimensions,
            tile.IndexRange[indexDim],
            {
              source: Sources.File,
              data: {
                [tileIdx]: {
                  range: tile.IndexRange[indexDim],
                  stride: tile.IndexStride[indexDim],
                  values: dim === "C" ? tile.channels : null,
                },
              },
            },
          );
        }
      }
    });

    if (!hasFileVariable) {
      this.addSizeToDimension(
        "Z",
        maxFramesPerItem,
        {
          source: Sources.Images,
          data: null,
        },
        "All frames per item",
      );
    }

    this.resetDimensionsToDefault();
  }

  resetDimensionsToDefault() {
    for (const dim in this.dimensionNames) {
      this.assignments[dim as TUpDim] = this.getDefaultAssignmentItem(dim);
    }
  }

  areDimensionsSetToDefault() {
    return Object.keys(this.dimensionNames).every(
      (dim) =>
        this.getDefaultAssignmentItem(dim)?.value ===
        this.assignments[dim as TUpDim]?.value,
    );
  }

  isAssignmentImmutable(assignment: IAssignment) {
    // Assignemnt is immutable when it comes from the metadata of an nd2 file
    const value = assignment.value;
    if (!(value.source === Sources.File)) {
      return false;
    }
    const itemIndices = Object.keys(value.data).map(Number);
    const allItemsAreNd2 = itemIndices.every((idx) =>
      this.girderItems[idx].name.toLowerCase().endsWith(".nd2"),
    );
    return allItemsAreNd2;
  }

  assignmentDisabled(dimension: TUpDim) {
    const currentAssignment = this.assignments[dimension];
    return (
      (currentAssignment && this.isAssignmentImmutable(currentAssignment)) ||
      this.assignmentItems.length === 0
    );
  }

  clearDisabled(dimension: TUpDim) {
    const currentAssignment = this.assignments[dimension];
    return !currentAssignment || this.isAssignmentImmutable(currentAssignment);
  }

  submitEnabled() {
    const filledAssignments = Object.values(this.assignments).reduce(
      (count, assignment) => (assignment ? ++count : count),
      0,
    );
    return (
      !this.initializing &&
      (filledAssignments >= this.items.length || filledAssignments >= 4)
    );
  }

  getValueFromAssignments(
    dim: TDimensions,
    itemIdx: number,
    frameIdx: number,
  ): number {
    const assignmentValue = this.assignments[dim]?.value;
    if (!assignmentValue) {
      return 0;
    }
    switch (assignmentValue.source) {
      case Sources.File:
        const fileData = assignmentValue.data as IFileSourceData;
        return fileData[itemIdx]
          ? Math.floor(frameIdx / fileData[itemIdx].stride) %
              fileData[itemIdx].range
          : 0;
      case Sources.Filename:
        const filenameData = assignmentValue.data as IFilenameSourceData;
        const filename = this.girderItems[itemIdx].name;
        return filenameData.valueIdxPerFilename[filename];
      case Sources.Images:
        return frameIdx;
    }
  }

  getCompositingValueFromAssignments(
    dim: TDimensions,
    itemIdx: number,
    frameIdx: number,
  ): number {
    const assignmentValue = this.assignments[dim]?.value;
    if (!assignmentValue) {
      return 0;
    }
    switch (assignmentValue.source) {
      case Sources.File:
        const fileData = assignmentValue.data as IFileSourceData;
        return fileData[itemIdx]
          ? Math.floor(frameIdx / fileData[itemIdx].stride) %
              fileData[itemIdx].range
          : 0;
      case Sources.Filename:
        const filenameData = assignmentValue.data as IFilenameSourceData;
        const filename = this.girderItems[itemIdx].name;
        return filenameData.valueIdxPerFilename[filename];
      case Sources.Images:
        return frameIdx;
    }
  }

  async submit() {
    const jsonId = await this.generateJson();

    this.$emit("generatedJson", jsonId);

    if (!jsonId) {
      return;
    }
    if (this.autoDatasetRoute) {
      this.$router.push({
        name: "dataset",
        params: { datasetId: this.datasetId },
      });
    }
  }

  async generateJson(): Promise<string | null> {
    // Find the channel names
    let channels: string[] | null = null;
    const channelAssignment = this.assignments.C?.value;
    if (channelAssignment) {
      switch (channelAssignment.source) {
        case Sources.File:
          // For each channel index, find the possible different channel names
          const fileData = channelAssignment.data as IFileSourceData;
          const channelsPerIdx = [] as string[][];
          for (const itemIdx in fileData) {
            const values = fileData[itemIdx].values;
            if (values) {
              for (let chanIdx = 0; chanIdx < values.length; ++chanIdx) {
                if (!channelsPerIdx[chanIdx]) {
                  channelsPerIdx[chanIdx] = [];
                }
                if (!channelsPerIdx[chanIdx].includes(values[chanIdx])) {
                  channelsPerIdx[chanIdx].push(values[chanIdx]);
                }
              }
            }
          }
          channels = [];
          for (const channelsAtIdx of channelsPerIdx) {
            channels.push(channelsAtIdx.join("/"));
          }
          break;
        case Sources.Filename:
          const filenameData = channelAssignment.data as IFilenameSourceData;
          channels = filenameData.values;
          break;
        case Sources.Images:
          channels = [...Array(channelAssignment.size).keys()].map(
            (id) => `Default ${id}`,
          );
          break;
      }
    }
    if (channels === null || channels.length === 0) {
      channels = ["Default"];
    }

    // Handle RGB expansion
    if (this.isMultiBandRGBFile && this.splitRGBBands) {
      // Assuming 3 bands (R,G,B), adjust as needed if dynamic
      const bandSuffixes = [" - Red", " - Green", " - Blue"];
      const expandedChannels: string[] = [];
      for (const ch of channels) {
        for (let b = 0; b < this.rgbBandCount; b++) {
          expandedChannels.push(`${ch}${bandSuffixes[b] || `_band${b}`}`);
        }
      }
      channels = expandedChannels;
    }

    // See specifications of multi source here:
    // https://girder.github.io/large_image/multi_source_specification.html
    // The sources have two possible interfaces depending on compositing
    const sources: ICompositingSource[] | IBasicSource[] = [];

    if (this.shouldDoCompositing) {
      // Compositing
      const compositingSources: ICompositingSource[] =
        sources as ICompositingSource[];
      if (!this.tilesMetadata) {
        return null;
      }
      // For each frame, find (XY, Z, T, C)
      for (let itemIdx = 0; itemIdx < this.girderItems.length; ++itemIdx) {
        const item = this.girderItems[itemIdx];
        const nFrames = this.tilesMetadata[itemIdx].frames?.length || 1;

        if (this.isMultiBandRGBFile && this.splitRGBBands) {
          // For RGB files, create separate sources for each band
          for (let frameIdx = 0; frameIdx < nFrames; ++frameIdx) {
            for (let bandIdx = 0; bandIdx < this.rgbBandCount; bandIdx++) {
              compositingSources.push({
                path: item.name,
                xySet: this.getValueFromAssignments("XY", itemIdx, frameIdx),
                zSet: this.getValueFromAssignments("Z", itemIdx, frameIdx),
                tSet: this.getValueFromAssignments("T", itemIdx, frameIdx),
                cSet: bandIdx, // Map each band to its corresponding channel
                frames: [frameIdx],
                style: {
                  bands: [{ band: bandIdx + 1 }],
                },
              });
            }
          }
        } else {
          for (let frameIdx = 0; frameIdx < nFrames; ++frameIdx) {
            compositingSources.push({
              path: item.name,
              xySet: this.getCompositingValueFromAssignments(
                "XY",
                itemIdx,
                frameIdx,
              ),
              zSet: this.getCompositingValueFromAssignments(
                "Z",
                itemIdx,
                frameIdx,
              ),
              tSet: this.getCompositingValueFromAssignments(
                "T",
                itemIdx,
                frameIdx,
              ),
              cSet: this.getCompositingValueFromAssignments(
                "C",
                itemIdx,
                frameIdx,
              ),
              frames: [frameIdx],
            });
          }
        }
      }
      const { mm_x, mm_y } = this.tilesMetadata![0];
      const { sizeX, sizeY } = this.tilesMetadata![0];
      const framesMetadata = this.tilesInternalMetadata![0].nd2_frame_metadata;
      const coordinates: IGeoJSPositionWithTransform[] = framesMetadata.map(
        (f: any) => {
          const framePos = f.position.stagePositionUm;
          const pos = {
            x: framePos[0] / (mm_x * 1000),
            y: framePos[1] / (mm_y * 1000),
            s11: 1,
            s12: 0,
            s21: 0,
            s22: 1,
          };
          if (
            this.tilesInternalMetadata![0].nd2 &&
            this.tilesInternalMetadata![0].nd2.channels
          ) {
            const chan = this.tilesInternalMetadata![0].nd2.channels;
            const chan0 =
              chan.volume !== undefined ? chan.volume : chan[0].volume;
            /* 
            // In David's version, if it was close to an inversion, 
            // it would just invert the position, but this ends up being inverted
            // from what the transformation would do. Keeping for posterity.
            if (
              chan0.cameraTransformationMatrix &&
              Math.abs(chan0.cameraTransformationMatrix[0] - -1) < 0.01 &&
              Math.abs(chan0.cameraTransformationMatrix[3] - -1)
            ) {
              // pos.x *= -1;
              // pos.y *= -1;
            }
            */
            if (
              // If close to the identity matrix, then we don't need to apply the transform
              // Only apply transform if it's not close to the identity matrix
              chan0.cameraTransformationMatrix &&
              (Math.abs(chan0.cameraTransformationMatrix[0] - 1) > 0.01 ||
                Math.abs(chan0.cameraTransformationMatrix[3] - 1) > 0.01)
            ) {
              // If close to an inversion matrix, then just round to inversion
              if (
                Math.abs(chan0.cameraTransformationMatrix[0] - -1) < 0.01 &&
                Math.abs(chan0.cameraTransformationMatrix[3] - -1) < 0.01
              ) {
                pos.s11 = -1.0;
                pos.s12 = 0.0;
                pos.s21 = 0.0;
                pos.s22 = -1.0;
              } else {
                // Otherwise, apply the matrix
                // AR note: I wonder if we should apply the matrix to the position itself as well
                // It is hard to say without an example with a more egregious transformation
                pos.s11 = chan0.cameraTransformationMatrix[0];
                pos.s12 = chan0.cameraTransformationMatrix[1];
                pos.s21 = chan0.cameraTransformationMatrix[2];
                pos.s22 = chan0.cameraTransformationMatrix[3];
              }
            }
          }
          return pos;
        },
      );
      // We need to find the bounding box.
      // The offset of the tile positions will depend on the transformation.
      // First, define the corners of a single tile.
      const corners = [
        { x: 0, y: 0 },
        { x: sizeX, y: 0 },
        { x: 0, y: sizeY },
        { x: sizeX, y: sizeY },
      ];
      // Apply the transformation to all corners
      const transformedCorners = corners.map((corner) => ({
        x:
          (coordinates[0]?.s11 ?? 1) * corner.x +
          (coordinates[0]?.s12 ?? 0) * corner.y,
        y:
          (coordinates[0]?.s21 ?? 0) * corner.x +
          (coordinates[0]?.s22 ?? 1) * corner.y,
      }));
      // Find the minimum and maximum x and y values for the transformed corners
      const offsetMin = {
        x: Math.min(...transformedCorners.map((c) => c.x)),
        y: Math.min(...transformedCorners.map((c) => c.y)),
      };
      const offsetMax = {
        x: Math.max(...transformedCorners.map((c) => c.x)),
        y: Math.max(...transformedCorners.map((c) => c.y)),
      };
      // Find the minimum and maximum x and y values for the coordinates
      const minCoordinate = {
        x:
          Math.min(...coordinates.map((coordinate) => coordinate.x)) +
          offsetMin.x,
        y:
          Math.min(...coordinates.map((coordinate) => coordinate.y)) -
          offsetMax.y, // Notice that the math is a little funny here. That's because Y is inverted.
      };
      const maxCoordinate = {
        x:
          Math.max(...coordinates.map((coordinate) => coordinate.x)) +
          offsetMax.x,
        y:
          Math.max(...coordinates.map((coordinate) => coordinate.y)) -
          offsetMin.y, // Notice that the math is a little funny here. That's because Y is inverted.
      };
      let finalCoordinates = coordinates.map((coordinate) => ({
        x: Math.round(coordinate.x - minCoordinate.x),
        y: Math.round(maxCoordinate.y - coordinate.y),
        s11: coordinate.s11,
        s12: coordinate.s12,
        s21: coordinate.s21,
        s22: coordinate.s22,
      }));
      compositingSources.forEach((source, sourceIdx) => {
        source.position =
          finalCoordinates[Math.floor(sourceIdx / channels!.length)];
        source.xySet = 0;
      });
    } else {
      // No compositing
      const basicSources: IBasicSource[] = sources as IBasicSource[];
      for (let itemIdx = 0; itemIdx < this.girderItems.length; ++itemIdx) {
        const item = this.girderItems[itemIdx];
        if (!this.tilesMetadata || !this.tilesInternalMetadata) {
          continue;
        }

        if (this.isMultiBandRGBFile && this.splitRGBBands) {
          const nFrames = this.tilesMetadata[itemIdx].frames?.length || 1;
          for (let frameIdx = 0; frameIdx < nFrames; ++frameIdx) {
            // For RGB files, create separate sources for each band
            for (let bandIdx = 0; bandIdx < this.rgbBandCount; bandIdx++) {
              basicSources.push({
                path: item.name,
                style: {
                  bands: [{ band: bandIdx + 1 }],
                },
                c: bandIdx,
                tValues: [this.getValueFromAssignments("T", itemIdx, frameIdx)],
                zValues: [this.getValueFromAssignments("Z", itemIdx, frameIdx)],
                xyValues: [
                  this.getValueFromAssignments("XY", itemIdx, frameIdx),
                ],
              });
            }
          }
        } else {
          const framesAsAxes: TFramesAsAxes = {};
          const dimValues: { [dim in TLowDim]?: number } = {};

          for (const dim in this.assignments) {
            const upDim = dim as TUpDim;
            const lowDim = dim.toLowerCase() as TLowDim;
            const assignment = this.assignments[upDim];
            // Add file strides
            if (!assignment) {
              continue;
            }
            let dimValue = 0;
            switch (assignment.value.source) {
              case Sources.File:
                const fileSource = assignment.value.data;
                framesAsAxes[lowDim] = fileSource[itemIdx].stride;
                break;

              case Sources.Filename:
                const filenameSource = assignment.value.data;
                dimValue = filenameSource.valueIdxPerFilename[item.name];
                break;

              case Sources.Images:
                framesAsAxes[lowDim] = 1;
                break;
            }
            dimValues[lowDim] = dimValue;
          }
          const newSource: IBasicSource = {
            path: item.name,
            framesAsAxes,
          };
          for (const dim in dimValues) {
            const lowDim = dim as TLowDim;
            newSource[`${lowDim}Values`] = [dimValues[lowDim]!];
          }
          basicSources.push(newSource);
        }
      }
    }

    this.logs = "";
    this.isUploading = true;
    this.transcodeProgress = 0;
    this.progressStatusText = "Preparing transcoding";

    const eventCallback = (jobData: IJobEventData) => {
      if (jobData.text) {
        this.logs += jobData.text;
        this.$emit("log", this.logs);
        const progress = parseTranscodeOutput(jobData.text);
        this.progressStatusText = progress.progressStatusText;
        if (progress.transcodeProgress !== undefined)
          this.transcodeProgress = progress.transcodeProgress;
        if (progress.currentFrame !== undefined)
          this.currentFrame = progress.currentFrame;
        if (progress.totalFrames !== undefined)
          this.totalFrames = progress.totalFrames;
      }
    };

    const datasetId = this.datasetId;
    try {
      const itemId = await this.store.addMultiSourceMetadata({
        parentId: datasetId,
        metadata: JSON.stringify({
          channels,
          sources,
          uniformSources: true,
          singleBand: this.isMultiBandRGBFile,
        }),
        transcode: this.transcode,
        eventCallback,
      });
      // Schedule caches after adding multisource (and transcoding)
      this.store.scheduleTileFramesComputation(datasetId);
      this.store.scheduleMaxMergeCache(datasetId);
      this.store.scheduleHistogramCache(datasetId);

      if (!itemId) {
        throw new Error("Failed to add multi source");
      }
      return itemId;
    } catch (error) {
      logError((error as Error).message);
      return null;
    }
  }

  get submitError(): string | null {
    if (!this.submitEnabled()) {
      return "Not all variables are assigned";
    }

    if (!this.isRGBAssignmentValid) {
      return "If splitting RGB file into channels, then filenames must be assigned to another variable";
    }
    return null;
  }

  get isRGBAssignmentValid(): boolean {
    if (this.isMultiBandRGBFile && this.splitRGBBands) {
      return this.assignments.C === null;
    }
    return true;
  }

  // Copy log to clipboard
  copyLogToClipboard() {
    if (navigator.clipboard && this.logs) {
      navigator.clipboard.writeText(this.logs);
      this.showCopySnackbar = true;
    }
  }
}
</script>

<style lang="scss">
.code-container {
  display: flex;
  flex-direction: column-reverse;
  margin: 20px 0;
  width: 100%;
  min-height: 0px;
  max-height: 300px;
  overflow-y: scroll;
}

.code-block {
  white-space: pre-wrap;
  width: 100%;
}

.job-log {
  max-height: 400px;
  min-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  font-family: monospace;
  font-size: 12px;
  background-color: rgba(0, 0, 0, 0.05);
  padding: 12px;
  border-radius: 4px;
  width: 100%;
  color: rgba(255, 255, 255, 0.85);
}
</style>
