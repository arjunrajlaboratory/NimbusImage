<template>
  <v-container>
    <v-card class="pa-4 my-4">
      <v-subheader id="variables-tourstep" class="headline"
        >Variables</v-subheader
      >
      <v-divider class="my-2" />
      <div
        v-if="highlightedFilenameSegments.length > 0"
        class="filename-highlight-container mb-4 pa-3"
      >
        <div class="text-caption grey--text mb-1">
          Example filename with extracted variables:
        </div>
        <div class="filename-highlight-text">
          <span
            v-for="(segment, idx) in highlightedFilenameSegments"
            :key="idx"
            :class="segment.class"
            :style="segment.style"
            :title="segment.title"
            >{{ segment.text }}</span
          >
        </div>
        <div class="filename-highlight-legend mt-2">
          <span
            v-for="(legend, idx) in filenameLegend"
            :key="idx"
            class="legend-item mr-4"
          >
            <span
              class="legend-color"
              :style="{ backgroundColor: legend.color }"
            ></span>
            <span class="text-caption">
              {{ legend.label }}
              <span v-if="legend.showGuess" class="grey--text text--darken-1">
                (guessed: {{ legend.guess }})
              </span>
            </span>
          </span>
        </div>
      </div>
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
      <v-card-title class="d-flex align-center">
        <v-progress-circular
          :value="initProgressPercent"
          v-if="initTotal > 0 && !initError"
          class="mr-4"
        />
        <v-progress-circular
          indeterminate
          v-else-if="!initError"
          class="mr-4"
        />
        <span v-if="!initError">
          Computing variables: {{ initCompleted }} / {{ initTotal }} ({{
            initProgressPercent
          }}%)
        </span>
        <span v-else class="red--text">
          Failed on {{ initError.name }}: {{ initError.message }}
        </span>
      </v-card-title>
      <v-card-text v-if="!initError && initPending.length">
        <div class="mb-2">Pending files ({{ initPending.length }}):</div>
        <v-simple-table dense>
          <template v-slot:default>
            <tbody>
              <tr v-for="name in initPendingDisplay" :key="name">
                <td class="text-left d-flex align-center">
                  <span>{{ name }}</span>
                  <v-progress-circular
                    v-if="initInFlight.includes(name)"
                    indeterminate
                    size="16"
                    width="2"
                    class="ml-2"
                    color="primary"
                  />
                </td>
              </tr>
              <tr v-if="initPending.length > initPendingDisplay.length">
                <td class="text-left font-italic">
                  ... and
                  {{ initPending.length - initPendingDisplay.length }} more
                  files
                </td>
              </tr>
            </tbody>
          </template>
        </v-simple-table>
      </v-card-text>
      <v-card-text v-else-if="initError">
        <v-alert type="error" text dense>
          Processing stopped due to error.
        </v-alert>
      </v-card-text>
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
          v-if="transcodeProgress !== undefined"
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
import {
  IGeoJSPositionWithTransform,
  IJobEventData,
  IDimensionStrategy,
} from "@/store/model";
import { logError, logWarning } from "@/utils/log";
import { parseTranscodeOutput } from "@/utils/strings";
import { extractDimensionLabelsFromND2 } from "@/utils/ND2FileParsing";
import pLimit from "p-limit";
import pRetry, { AbortError } from "p-retry";

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

  // Store last generated config for reuse
  lastGeneratedConfig: any = null;

  // For progress tracking of the transcoding
  transcodeProgress: number | undefined = undefined;
  progressStatusText: string = "";
  totalFrames: number = 0;
  currentFrame: number = 0;

  isRGBFile: boolean = false;
  rgbBandCount: number = 0;

  splitRGBBands: boolean = true;

  // Progress tracking for initialization
  initTotal: number = 0;
  initCompleted: number = 0;
  initPending: string[] = [];
  initInFlight: string[] = [];
  initError: { name: string; message: string } | null = null;

  get isMultiBandRGBFile(): boolean {
    return this.isRGBFile && this.rgbBandCount > 1;
  }

  get initProgressPercent(): number {
    return this.initTotal > 0
      ? Math.round((this.initCompleted / this.initTotal) * 100)
      : 0;
  }

  get initPendingDisplay(): string[] {
    return this.initPending.slice(0, 5); // Show max 5 pending files
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

  // Colors for highlighting different variables in the filename
  readonly variableColors: { [key in TDimensions]: string } = {
    XY: "#4CAF50", // Green
    Z: "#2196F3", // Blue
    T: "#FF9800", // Orange
    C: "#9C27B0", // Purple
  };

  /**
   * Get the filename-sourced variables with their token positions and assignments
   */
  get filenameVariables(): {
    dimension: TAssignmentOption;
    tokenIndex: number;
    value: string;
    assignedTo: TUpDim | null; // The dimension this variable is actually assigned to
  }[] {
    if (!this.girderItems.length) return [];

    const exampleFilename = this.girderItems[0].name;
    const delimiterPattern = /[_\.\/]/;
    const tokens = exampleFilename.split(delimiterPattern);

    const result: {
      dimension: TAssignmentOption;
      tokenIndex: number;
      value: string;
      assignedTo: TUpDim | null;
    }[] = [];

    // Find filename-sourced dimensions and their token positions
    for (const dim of this.dimensions) {
      if (dim.source !== Sources.Filename || dim.size === 0) continue;

      const filenameData = dim.data as IFilenameSourceData;
      const valueIdx = filenameData.valueIdxPerFilename[exampleFilename];
      const value = filenameData.values[valueIdx];

      // Find which token matches this value
      const tokenIndex = tokens.findIndex((token) => token === value);
      if (tokenIndex !== -1) {
        // Find the actual assignment for this dimension
        let assignedTo: TUpDim | null = null;
        for (const [assignmentDim, assignment] of Object.entries(
          this.assignments,
        )) {
          if (assignment?.value.id === dim.id) {
            assignedTo = assignmentDim as TUpDim;
            break;
          }
        }
        result.push({ dimension: dim, tokenIndex, value, assignedTo });
      }
    }

    return result;
  }

  /**
   * Compute segments of the filename with highlighting information
   */
  get highlightedFilenameSegments(): {
    text: string;
    class: string;
    style: { backgroundColor?: string; color?: string };
    title: string;
  }[] {
    if (!this.girderItems.length || this.filenameVariables.length === 0) {
      return [];
    }

    const exampleFilename = this.girderItems[0].name;
    const delimiterPattern = /([_\.\/])/; // Capture delimiters
    const parts = exampleFilename.split(delimiterPattern);

    // Build a map of token index to variable info
    // Tokens are at even indices (0, 2, 4, ...), delimiters at odd indices
    const tokenToVariable = new Map<
      number,
      { guess: TDimensions; assignedTo: TUpDim | null; name: string }
    >();

    let tokenCount = 0;
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        // This is a token (not a delimiter)
        for (const varInfo of this.filenameVariables) {
          if (varInfo.tokenIndex === tokenCount) {
            tokenToVariable.set(i, {
              guess: varInfo.dimension.guess,
              assignedTo: varInfo.assignedTo,
              name: varInfo.dimension.name,
            });
          }
        }
        tokenCount++;
      }
    }

    // Build segments
    return parts.map((part, idx) => {
      const varInfo = tokenToVariable.get(idx);
      if (varInfo) {
        // Use assignment color if assigned, otherwise use guess color
        const colorKey = varInfo.assignedTo || varInfo.guess;
        const assignmentLabel = varInfo.assignedTo
          ? this.dimensionNames[varInfo.assignedTo]
          : "Unassigned";
        return {
          text: part,
          class: "filename-variable",
          style: {
            backgroundColor: this.variableColors[colorKey],
            color: "#ffffff",
          },
          title: `${varInfo.name} → ${assignmentLabel}`,
        };
      }
      return {
        text: part,
        class: "",
        style: {},
        title: "",
      };
    });
  }

  /**
   * Legend items for the highlighted variables, showing both guess and assignment
   */
  get filenameLegend(): {
    label: string;
    color: string;
    guess: string;
    showGuess: boolean;
  }[] {
    const legend: {
      label: string;
      color: string;
      guess: string;
      showGuess: boolean;
    }[] = [];

    for (const varInfo of this.filenameVariables) {
      const guess = varInfo.dimension.guess;
      const assignedTo = varInfo.assignedTo;
      // Use assignment color if assigned, otherwise use guess color
      const colorKey = assignedTo || guess;
      const assignmentLabel = assignedTo
        ? `${this.dimensionNames[assignedTo]} (${assignedTo})`
        : "Unassigned";
      const guessLabel = `${this.dimensionNames[guess]} (${guess})`;
      const showGuess = assignedTo !== null && assignedTo !== guess;

      legend.push({
        label: assignmentLabel,
        color: this.variableColors[colorKey],
        guess: guessLabel,
        showGuess,
      });
    }

    return legend;
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

  /**
   * Watch assignments and save to store when changed.
   * This allows NewDataset.vue to read the strategy from the store
   * instead of calling getDimensionStrategy() via $refs.
   */
  @Watch("assignments", { deep: true })
  onAssignmentsChange() {
    this.saveDimensionStrategyToStore();
  }

  @Watch("transcode")
  onTranscodeChange() {
    this.saveDimensionStrategyToStore();
  }

  /**
   * Save the current dimension strategy to the store.
   * Only saves when in batch mode for the first dataset.
   */
  saveDimensionStrategyToStore() {
    // Only save strategy during batch mode upload workflow for first dataset
    if (
      !this.store.uploadWorkflow.active ||
      !this.store.uploadWorkflow.batchMode ||
      !this.store.uploadIsFirstDataset
    ) {
      return;
    }

    const strategy = this.getDimensionStrategy();
    this.store.setUploadDimensionStrategy(strategy);
  }

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
    const names = items.map((item: IGirderItem) => item.name);

    // Enable transcoding by default except for ND2 files
    this.transcode = !names.every((name: string) =>
      name.toLowerCase().endsWith(".nd2"),
    );

    // Add variables from filenames if there is more than one file
    if (names.length > 1) {
      collectFilenameMetadata2(names).forEach((filenameData) => {
        this.addSizeToDimension(
          filenameData.guess,
          filenameData.values.length,
          {
            source: Sources.Filename,
            data: filenameData,
          },
        );
      });
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

    // Initialize progress tracking
    this.initTotal = items.length;
    this.initCompleted = 0;
    this.initPending = items.map((item: IGirderItem) => item.name);
    this.initInFlight = [];
    this.initError = null;

    const limit = pLimit(4);

    try {
      const promises = items.map((item: IGirderItem, idx: number) =>
        limit(async () => {
          try {
            // Mark file as in flight
            this.initInFlight.push(item.name);

            // Tiles metadata with retries and fixed delay depending on OIB
            const tilesMetadata = await pRetry(
              async () => {
                return this.store.api.getTiles(item);
              },
              {
                retries: hasOibFiles ? 15 : 10,
                onFailedAttempt: (error: any) => {
                  const attemptNumber = error?.attemptNumber || 0;
                  const message =
                    error?.response?.data?.message || error?.message || "";
                  logError(
                    `Error retrieving tiles for item ${item._id} (attempt ${attemptNumber}):`,
                    message,
                  );

                  // For non-OIB files:
                  // - Keep retrying when the large image isn't ready yet
                  // - Abort early for any other error
                  if (
                    !hasOibFiles &&
                    error?.response?.data?.message !==
                      "No large image file in this item."
                  ) {
                    throw new AbortError(message);
                  }
                },
                factor: 1,
                minTimeout: hasOibFiles ? 3000 : 1000,
                maxTimeout: hasOibFiles ? 3000 : 1000,
                randomize: false,
              },
            );

            // Internal metadata with modest retries
            const internalMetadata = await pRetry(
              async () => this.store.api.getTilesInternalMetadata(item),
              { retries: 3 },
            );

            // Update progress on successful completion
            this.initCompleted++;
            this.initPending = this.initPending.filter(
              (name) => name !== item.name,
            );
            this.initInFlight = this.initInFlight.filter(
              (name) => name !== item.name,
            );

            return { idx, tilesMetadata, internalMetadata };
          } catch (error: any) {
            // Remove from in-flight on error
            this.initInFlight = this.initInFlight.filter(
              (name) => name !== item.name,
            );

            // Set error state and stop processing
            this.initError = {
              name: item.name,
              message:
                error?.response?.data?.message ||
                error?.message ||
                "Unknown error",
            };
            throw error;
          }
        }),
      );

      const promiseResults = await Promise.all(promises);
      // Guarantee ordering when rebuilding arrays from concurrent work
      promiseResults.sort((a: any, b: any) => a.idx - b.idx);
      this.tilesMetadata = promiseResults.map((r: any) => r.tilesMetadata);
      this.tilesInternalMetadata = promiseResults.map(
        (r: any) => r.internalMetadata,
      );
    } catch (error) {
      // If any file failed completely, stop and show error
      logError("Failed to process tiles metadata:", error);
      throw error;
    }

    if (!this.tilesMetadata || !this.tilesInternalMetadata) {
      logError("Failed to retrieve tiles or internal metadata after retries");
      throw "Could not retrieve tiles from Girder";
    }

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
          const range = tile.IndexRange[indexDim];
          if (range) {
            this.addSizeToDimension(
              // We know that the keys of this.dimensionNames are of type TDimensions
              dim as TDimensions,
              range,
              {
                source: Sources.File,
                data: {
                  [tileIdx]: {
                    range: range,
                    stride: tile.IndexStride[indexDim],
                    values: dim === "C" ? tile.channels : null,
                  },
                },
              },
            );
          }
        }
      }
    });

    if (!hasFileVariable) {
      logWarning(
        `[MultiSourceConfig] No file variables found, adding Images dimension for Z with size=${maxFramesPerItem}`,
      );
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

    this.$emit("generatedJson", jsonId, this.lastGeneratedConfig);

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

    // Extract labels for other dimensions
    const xyLabels: string[] | null = this.extractDimensionLabels("XY");
    const zLabels: string[] | null = this.extractDimensionLabels("Z");
    const tLabels: string[] | null = this.extractDimensionLabels("T");

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

    // Build config data for potential reuse
    const configData = {
      channels,
      sources,
      uniformSources: true,
      singleBand: this.isMultiBandRGBFile,
    };

    // Store and emit the config data
    this.lastGeneratedConfig = configData;
    this.$emit("configData", configData);

    this.logs = "";
    this.isUploading = true;
    this.transcodeProgress = undefined;
    if (this.transcode) {
      this.progressStatusText = "Preparing transcoding";
    } else {
      this.progressStatusText = "Preparing dataset";
    }

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
        metadata: JSON.stringify(configData),
        transcode: this.transcode,
        eventCallback,
      });

      if (!itemId) {
        throw new Error("Failed to add multi source");
      }

      // Store dimension labels as separate metadata on the dataset folder
      try {
        const dimensionLabels = {
          xy: xyLabels,
          z: zLabels,
          t: tLabels,
        };
        await this.store.api.updateDatasetMetadata(datasetId, {
          dimensionLabels: dimensionLabels,
        });
        // Invalidate the folder cache so the updated metadata is fetched
        await this.store.girderResources.ressourceChanged(datasetId);
      } catch (labelError) {
        logError("Failed to store dimension labels (non-fatal):", labelError);
        // Don't fail the whole process if label storage fails
      }

      // Schedule caches after successful metadata upload
      this.store.scheduleTileFramesComputation(datasetId);
      this.store.scheduleMaxMergeCache(datasetId);
      this.store.scheduleHistogramCache(datasetId);

      return itemId;
    } catch (error) {
      logError("Failed to create multi source:", error);
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

  // Extract dimension labels for a given dimension
  extractDimensionLabels(dim: TUpDim): string[] | null {
    const assignment = this.assignments[dim]?.value;
    if (!assignment) return null;

    // Try to extract labels from ND2 metadata first (only for File source)
    if (assignment.source === Sources.File && this.tilesInternalMetadata) {
      const nd2Labels = extractDimensionLabelsFromND2(
        dim,
        this.tilesInternalMetadata,
        assignment.size,
      );
      if (nd2Labels) {
        return nd2Labels;
      }
    }

    // Fall back to original extraction logic
    switch (assignment.source) {
      case Sources.File:
        const fileData = assignment.data as IFileSourceData;
        const labelsPerIdx: string[][] = [];
        for (const itemIdx in fileData) {
          const values = fileData[itemIdx].values;
          if (values) {
            values.forEach((val, idx) => {
              if (!labelsPerIdx[idx]) labelsPerIdx[idx] = [];
              if (!labelsPerIdx[idx].includes(val)) {
                labelsPerIdx[idx].push(val);
              }
            });
          }
        }
        return labelsPerIdx.map((labels) => labels.join("/"));

      case Sources.Filename:
        return assignment.data.values;

      case Sources.Images:
        return Array.from({ length: assignment.size }, (_, i) => `${i + 1}`);
    }
  }

  // Copy log to clipboard
  copyLogToClipboard() {
    if (navigator.clipboard && this.logs) {
      navigator.clipboard.writeText(this.logs);
      this.showCopySnackbar = true;
    }
  }

  /**
   * Extract the current dimension assignment strategy.
   * Used internally by saveDimensionStrategyToStore() to save to the Vuex store
   * when assignments change. The store-based approach allows other components
   * (like NewDataset.vue) to read the strategy without using $refs.
   */
  getDimensionStrategy(): IDimensionStrategy {
    const strategy: IDimensionStrategy = {
      XY: null,
      Z: null,
      T: null,
      C: null,
      transcode: this.transcode,
    };

    for (const dim of ["XY", "Z", "T", "C"] as const) {
      const assignment = this.assignments[dim];
      if (assignment?.value) {
        strategy[dim] = {
          source: assignment.value.source,
          guess: assignment.value.guess,
        };
      }
    }

    return strategy;
  }

  // Reinitialize and apply strategy - handles race conditions with @Watch
  async reinitializeAndApplyStrategy(
    strategy: IDimensionStrategy,
  ): Promise<void> {
    // Wait for any pending initialization to complete first
    while (this.initializing) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Reset all internal state
    this.dimensions = [];
    this.assignments = { XY: null, Z: null, T: null, C: null };
    this.tilesMetadata = null;
    this.tilesInternalMetadata = null;
    this.girderItems = [];
    this.filenameVariableCount = 0;
    this.fileVariableCount = 0;
    this.imageVariableCount = 0;
    this.assignmentIdCount = 0;
    this.initTotal = 0;
    this.initCompleted = 0;
    this.initPending = [];
    this.initInFlight = [];
    this.initError = null;

    // Run initialization directly (not through initialize() to avoid the guard)
    this.initializing = true;
    try {
      await this.initializeImplementation();
    } finally {
      this.initializing = false;
    }

    // Now apply the strategy
    this.applyDimensionStrategy(strategy);
  }

  // Apply a saved strategy to current dimensions
  applyDimensionStrategy(strategy: IDimensionStrategy): void {
    // Set transcode setting
    this.transcode = strategy.transcode;

    // For each dimension axis, try to find a matching dimension option
    for (const dim of ["XY", "Z", "T", "C"] as const) {
      const savedStrategy = strategy[dim];

      if (!savedStrategy) {
        logWarning(
          `[MultiSourceConfig] No saved strategy for ${dim}, setting to null`,
        );
        this.assignments[dim] = null;
        continue;
      }

      // First, try to find exact match (same source and guess)
      let matchingDimension = this.dimensions.find(
        (d) =>
          d.source === savedStrategy.source &&
          d.guess === savedStrategy.guess &&
          d.size > 0,
      );

      // If no exact match, try matching just the guess (dimension type)
      if (!matchingDimension) {
        logWarning(
          `[MultiSourceConfig] No exact match for ${dim}, trying guess-only match`,
        );
        matchingDimension = this.dimensions.find(
          (d) => d.guess === savedStrategy.guess && d.size > 0,
        );
      }

      // If still no match, try matching just the source type
      if (!matchingDimension) {
        logWarning(
          `[MultiSourceConfig] No guess match for ${dim}, trying source-only match`,
        );
        matchingDimension = this.dimensions.find(
          (d) => d.source === savedStrategy.source && d.size > 0,
        );
      }

      if (matchingDimension) {
        this.assignments[dim] =
          this.assignmentOptionToAssignmentItem(matchingDimension);
      } else {
        logWarning(
          `[MultiSourceConfig] No match found for ${dim}, using default`,
        );
        // Fall back to default for this dimension
        this.assignments[dim] = this.getDefaultAssignmentItem(dim);
      }
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

.filename-highlight-container {
  background-color: rgba(0, 0, 0, 0.03);
  border-radius: 4px;
  border: 1px solid rgba(0, 0, 0, 0.1);
}

.filename-highlight-text {
  font-family: "Roboto Mono", "Consolas", "Monaco", monospace;
  font-size: 14px;
  padding: 8px 12px;
  background-color: rgba(0, 0, 0, 0.05);
  border-radius: 4px;
  overflow-x: auto;
  white-space: nowrap;
}

.filename-variable {
  padding: 2px 4px;
  border-radius: 3px;
  font-weight: 500;
}

.filename-highlight-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.legend-color {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  display: inline-block;
}
</style>
