<template>
  <v-container>
    <v-card class="pa-4 my-4">
      <v-subheader id="variables-tourstep" class="headline"
        >Variables</v-subheader
      >
      <v-divider class="my-2" />
      <!-- Summary stats -->
      <div class="variables-summary mb-4">
        <div class="variables-summary__item">
          <span class="variables-summary__value">{{ fileCount }}</span>
          <span class="variables-summary__label">{{
            fileCount === 1 ? "file" : "files"
          }}</span>
        </div>
        <div class="variables-summary__divider">×</div>
        <div class="variables-summary__item">
          <span class="variables-summary__value">{{ framesPerFile }}</span>
          <span class="variables-summary__label">{{
            framesPerFile === 1 ? "frame/file" : "frames/file"
          }}</span>
        </div>
        <div class="variables-summary__divider">=</div>
        <div class="variables-summary__item variables-summary__item--total">
          <span class="variables-summary__value">{{ datasetTotalFrames }}</span>
          <span class="variables-summary__label">total frames</span>
        </div>
      </div>
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
      <!-- Variables list -->
      <div class="variables-list">
        <div
          v-for="item in items"
          :key="item.key"
          class="variable-row"
          :class="{
            'variable-row--assigned': isVariableAssigned(item),
          }"
          :style="{ '--row-accent-color': getAssignedDimensionColor(item) }"
        >
          <div class="variable-row__accent"></div>
          <div class="variable-row__name">{{ item.name }}</div>
          <div class="variable-row__values">
            <span>{{ item.values || `${item.size} values` }}</span>
            <v-menu
              v-if="item.allValues && item.allValues.length > 1"
              offset-y
              :close-on-content-click="false"
              max-height="300"
            >
              <template v-slot:activator="{ on, attrs }">
                <v-icon
                  x-small
                  class="variable-row__values-icon"
                  v-bind="attrs"
                  v-on="on"
                >
                  mdi-information-outline
                </v-icon>
              </template>
              <v-card class="values-popover">
                <v-card-title class="values-popover__title">
                  {{ item.name }}
                  <span class="values-popover__count"
                    >({{ item.allValues.length }} values)</span
                  >
                </v-card-title>
                <v-divider />
                <div class="values-popover__list">
                  <div
                    v-for="(val, idx) in item.allValues"
                    :key="idx"
                    class="values-popover__item"
                  >
                    <span class="values-popover__index">{{ idx + 1 }}.</span>
                    <span class="values-popover__value">{{ val }}</span>
                  </div>
                </div>
              </v-card>
            </v-menu>
          </div>
          <div class="variable-row__source">
            <v-icon x-small class="mr-1">{{
              item.source === "filename" ? "mdi-file-document" : "mdi-image"
            }}</v-icon>
            {{ item.source }}
          </div>
          <div class="variable-row__size">
            {{ item.size }} {{ item.size === 1 ? "value" : "values" }}
          </div>
          <div class="variable-row__assignment">
            <span
              v-if="isVariableAssigned(item)"
              class="variable-row__assignment-tag"
              :style="{
                backgroundColor: getAssignedDimensionColor(item),
              }"
            >
              {{ getAssignedDimension(item) }}
            </span>
            <span v-else class="variable-row__unassigned">—</span>
          </div>
        </div>
        <div v-if="items.length === 0" class="variables-list-empty">
          No variables detected
        </div>
      </div>
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
      <div class="assignment-slots-container">
        <div
          v-for="[dimension, dimensionName] in dimesionNamesEntries"
          :key="dimension"
          class="assignment-slot-row"
        >
          <!-- Dimension label with color indicator -->
          <div
            class="assignment-slot__label"
            :style="{ borderLeftColor: variableColors[dimension] }"
          >
            <span class="assignment-slot__dimension-name">{{
              dimensionName
            }}</span>
            <span class="assignment-slot__dimension-code">{{ dimension }}</span>
          </div>

          <!-- The slot container -->
          <div
            class="assignment-slot"
            :class="getSlotClasses(dimension)"
            :style="getSlotStyle(dimension)"
          >
            <!-- Filled state: show badge -->
            <template v-if="assignments[dimension]">
              <div
                class="assignment-slot__badge"
                :style="getAssignmentBadgeStyleForSlot(dimension)"
              >
                <span class="assignment-slot__badge-name">
                  {{ getAssignmentText(dimension) }}
                </span>
                <span class="assignment-slot__badge-values">
                  {{ getAssignmentValues(dimension) }}
                </span>
                <span class="assignment-slot__badge-size">
                  ({{ getAssignmentSize(dimension) }})
                </span>
                <template v-if="shouldDoCompositing && dimension === 'XY'">
                  <v-chip x-small outlined class="ml-2">composited</v-chip>
                </template>
                <!-- Lock icon for immutable -->
                <v-tooltip
                  v-if="isAssignmentImmutableForDimension(dimension)"
                  bottom
                >
                  <template v-slot:activator="{ on, attrs }">
                    <v-icon small class="ml-2" v-bind="attrs" v-on="on">
                      mdi-lock
                    </v-icon>
                  </template>
                  <span>This assignment is locked (from file metadata)</span>
                </v-tooltip>
              </div>
            </template>

            <!-- Empty state: dropdown trigger -->
            <template v-else>
              <v-menu offset-y :disabled="assignmentItems.length === 0">
                <template v-slot:activator="{ on, attrs }">
                  <div class="assignment-slot__empty" v-bind="attrs" v-on="on">
                    <span class="assignment-slot__placeholder">
                      {{
                        assignmentItems.length > 0
                          ? "Select variable..."
                          : "No variables available"
                      }}
                    </span>
                    <v-icon v-if="assignmentItems.length > 0" small
                      >mdi-menu-down</v-icon
                    >
                  </div>
                </template>
                <v-list dense>
                  <v-list-item
                    v-for="item in assignmentItems"
                    :key="item.value.id"
                    @click="assignments[dimension] = item"
                  >
                    <v-list-item-content>
                      <div class="dropdown-item-content">
                        <span class="dropdown-item-name">{{ item.text }}</span>
                        <span class="dropdown-item-values">{{
                          getItemValues(item.value)
                        }}</span>
                      </div>
                    </v-list-item-content>
                  </v-list-item>
                </v-list>
              </v-menu>
            </template>
          </div>

          <!-- Actions -->
          <div class="assignment-slot__actions">
            <v-tooltip
              v-if="assignments[dimension] && !clearDisabled(dimension)"
              bottom
            >
              <template v-slot:activator="{ on, attrs }">
                <v-btn
                  icon
                  small
                  v-bind="attrs"
                  v-on="on"
                  @click="assignments[dimension] = null"
                >
                  <v-icon small>mdi-close</v-icon>
                </v-btn>
              </template>
              <span>Clear assignment</span>
            </v-tooltip>
            <v-checkbox
              v-if="canDoCompositing && dimension === 'XY'"
              dense
              hide-details
              label="Composite"
              class="mt-0 ml-4"
              v-model="enableCompositing"
            />
          </div>
        </div>
      </div>
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

<script setup lang="ts">
import {
  ref,
  reactive,
  computed,
  watch,
  onMounted,
  getCurrentInstance,
} from "vue";
import store from "@/store";

import {
  collectFilenameMetadata2,
  filenameDelimiterPattern,
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
  data: IFileSourceData;
}

interface IFilenameAssignementOption extends IBaseAssignmentOption {
  source: Sources.Filename;
  data: IFilenameSourceData;
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

interface IFilenameVariable {
  dimension: TAssignmentOption;
  tokenIndex: number;
  value: string;
  assignedTo: TUpDim | null;
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

// --- Props & Emits ---

const props = withDefaults(
  defineProps<{
    datasetId: string;
    autoDatasetRoute?: boolean;
  }>(),
  { autoDatasetRoute: true },
);

const emit = defineEmits<{
  (e: "generatedJson", jsonId: string | null, config: any): void;
  (e: "configData", data: any): void;
  (e: "log", logs: string): void;
}>();

const instance = getCurrentInstance()!.proxy!;

// --- Reactive state ---

const tilesInternalMetadata = ref<{ [key: string]: any }[] | null>(null);
const tilesMetadata = ref<ITileMeta[] | null>(null);

const enableCompositing = ref(false);
const transcode = ref(false);

const isUploading = ref(false);
const logs = ref("");

const showLogDialog = ref(false);
const showCopySnackbar = ref(false);

const lastGeneratedConfig = ref<any>(null);

const transcodeProgress = ref<number | undefined>(undefined);
const progressStatusText = ref("");
const totalFrames = ref(0);
const currentFrame = ref(0);

const isRGBFile = ref(false);
const rgbBandCount = ref(0);

const splitRGBBands = ref(true);

const initTotal = ref(0);
const initCompleted = ref(0);
const initPending = ref<string[]>([]);
const initInFlight = ref<string[]>([]);
const initError = ref<{ name: string; message: string } | null>(null);

const dimensions = ref<TAssignmentOption[]>([]);

const assignments = reactive<{ [dimension in TUpDim]: IAssignment | null }>({
  XY: null,
  Z: null,
  T: null,
  C: null,
});

const searchInput = ref("");
let filenameVariableCount = 0;
let fileVariableCount = 0;
let imageVariableCount = 0;
let assignmentIdCount = 0;

const girderItems = ref<IGirderItem[]>([]);

const initialized = ref<Promise<void> | null>(null);
const initializing = ref(false);
let reinitializeFlag = false;

// --- Constants ---

const dimensionNames: { [dim in TUpDim]: string } = {
  XY: "Positions",
  Z: "Z",
  T: "Time",
  C: "Channels",
};

const dimesionNamesEntries = Object.entries(dimensionNames) as [
  TUpDim,
  string,
][];

const variableColors: { [key in TDimensions]: string } = {
  XY: "#4CAF50",
  Z: "#2196F3",
  T: "#FF9800",
  C: "#9C27B0",
};

// --- Computed ---

const isMultiBandRGBFile = computed(
  () => isRGBFile.value && rgbBandCount.value > 1,
);

const initProgressPercent = computed(() =>
  initTotal.value > 0
    ? Math.round((initCompleted.value / initTotal.value) * 100)
    : 0,
);

const initPendingDisplay = computed(() => initPending.value.slice(0, 5));

const canDoCompositing = computed(
  () =>
    tilesInternalMetadata.value !== null &&
    tilesInternalMetadata.value.length === 1 &&
    tilesInternalMetadata.value[0].nd2_frame_metadata &&
    tilesMetadata.value !== null &&
    tilesMetadata.value.length === 1,
);

const shouldDoCompositing = computed(
  () => canDoCompositing.value && enableCompositing.value,
);

const fileCount = computed(() => girderItems.value.length);

const framesPerFile = computed(() => {
  if (!tilesMetadata.value) return 1;
  return Math.max(
    ...tilesMetadata.value.map((tile) => tile.frames?.length || 1),
  );
});

const datasetTotalFrames = computed(() => {
  if (!tilesMetadata.value) return fileCount.value;
  return tilesMetadata.value.reduce(
    (sum, tile) => sum + (tile.frames?.length || 1),
    0,
  );
});

const items = computed(() =>
  dimensions.value
    .filter((dim) => dim.size > 0)
    .map((dim: TAssignmentOption) => {
      let values = "";
      let allValues: string[] = [];
      switch (dim.source) {
        case Sources.Filename:
          allValues = (dim.data as IFilenameSourceData).values;
          values = sliceAndJoin(allValues);
          break;
        case Sources.File:
          allValues = extractFileSourceValues(dim.data as IFileSourceData);
          values =
            allValues.length > 0
              ? sliceAndJoin(allValues, 24)
              : "From metadata";
          break;
        case Sources.Images:
          allValues = Array.from({ length: dim.size }, (_, i) => `${i + 1}`);
          values = "";
          break;
      }
      return {
        ...dim,
        values,
        allValues,
        key: `${dim.id}_${dim.guess}_${dim.source}`,
      };
    }),
);

const filenameVariables = computed((): IFilenameVariable[] => {
  if (!girderItems.value.length) return [];

  const exampleFilename = girderItems.value[0].name;
  const tokens = exampleFilename.split(filenameDelimiterPattern);

  const result: IFilenameVariable[] = [];

  for (const dim of dimensions.value) {
    if (dim.source !== Sources.Filename || dim.size === 0) continue;

    const filenameData = dim.data as IFilenameSourceData;
    const valueIdx = filenameData.valueIdxPerFilename[exampleFilename];
    const value = filenameData.values[valueIdx];

    const tokenIndex = tokens.findIndex((token) => token === value);
    if (tokenIndex !== -1) {
      let assignedTo: TUpDim | null = null;
      for (const [assignmentDim, assignment] of Object.entries(assignments)) {
        if (assignment?.value.id === dim.id) {
          assignedTo = assignmentDim as TUpDim;
          break;
        }
      }
      result.push({ dimension: dim, tokenIndex, value, assignedTo });
    }
  }

  return result;
});

const highlightedFilenameSegments = computed(() => {
  if (!girderItems.value.length || filenameVariables.value.length === 0) {
    return [];
  }

  const exampleFilename = girderItems.value[0].name;
  const capturingPattern = new RegExp(`(${filenameDelimiterPattern.source})`);
  const parts = exampleFilename.split(capturingPattern);

  const tokenToVariable = new Map<
    number,
    { guess: TDimensions; assignedTo: TUpDim | null; name: string }
  >();

  let tokenCount = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      for (const varInfo of filenameVariables.value) {
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

  return parts.map((part, idx) => {
    const varInfo = tokenToVariable.get(idx);
    if (varInfo) {
      const colorKey = varInfo.assignedTo || varInfo.guess;
      const assignmentLabel = varInfo.assignedTo
        ? dimensionNames[varInfo.assignedTo]
        : "Unassigned";
      return {
        text: part,
        class: "filename-variable",
        style: {
          backgroundColor: variableColors[colorKey],
          color: "#ffffff",
        },
        title: `${varInfo.name} → ${assignmentLabel}`,
      };
    }
    return { text: part, class: "", style: {}, title: "" };
  });
});

const filenameLegend = computed(() => {
  const legend: {
    label: string;
    color: string;
    guess: string;
    showGuess: boolean;
  }[] = [];

  for (const varInfo of filenameVariables.value) {
    const guess = varInfo.dimension.guess;
    const assignedTo = varInfo.assignedTo;
    const colorKey = assignedTo || guess;
    const assignmentLabel = assignedTo
      ? `${dimensionNames[assignedTo]} (${assignedTo})`
      : "Unassigned";
    const guessLabel = `${dimensionNames[guess]} (${guess})`;
    const showGuess = assignedTo !== null && assignedTo !== guess;

    legend.push({
      label: assignmentLabel,
      color: variableColors[colorKey],
      guess: guessLabel,
      showGuess,
    });
  }

  return legend;
});

const assignmentItems = computed(() => {
  const assignedDimensions = Object.entries(assignments).reduce(
    (acc, [, assignment]) => (assignment ? [...acc, assignment.value.id] : acc),
    [] as number[],
  );

  const isNotAssigned = (dimension: TAssignmentOption) =>
    !assignedDimensions.includes(dimension.id);
  return items.value
    .filter(isNotAssigned)
    .map(assignmentOptionToAssignmentItem);
});

const submitError = computed((): string | null => {
  if (!submitEnabled()) {
    return "Not all variables are assigned";
  }
  if (!isRGBAssignmentValid.value) {
    return "If splitting RGB file into channels, then filenames must be assigned to another variable";
  }
  return null;
});

const isRGBAssignmentValid = computed(() => {
  if (isMultiBandRGBFile.value && splitRGBBands.value) {
    return assignments.C === null;
  }
  return true;
});

// --- Methods ---

function extractFileSourceValues(data: IFileSourceData): string[] {
  const allValues: string[] = [];
  for (const itemIdx in data) {
    const itemValues = data[itemIdx].values;
    if (itemValues) {
      itemValues.forEach((v) => {
        if (!allValues.includes(v)) allValues.push(v);
      });
    }
  }
  return allValues;
}

function detectColorVsChannels(tileMeta: ITileMeta) {
  const bandCount = tileMeta.bandCount || 1;
  let isColor = false;

  const photo = tileMeta.metadata?.photometricInterpretation;
  if (photo === 2 || photo === "RGB") {
    isColor = true;
  }

  if (tileMeta.IndexRange?.IndexC > 1) {
    isColor = false;
  }

  if (typeof photo === "undefined") {
    if (bandCount === 3 || bandCount === 4) {
      isColor = true;
    }
  }

  return isColor;
}

function sliceAndJoin(
  arr: string[],
  maxChars: number = 16,
  sep: string = ", ",
) {
  if (arr.length <= 0) {
    return "";
  }
  if (
    arr[0].length > maxChars ||
    (arr[0].length === maxChars && arr.length > 1)
  ) {
    return arr[0].slice(0, maxChars - 1) + "…";
  }
  let nWords = 1;
  let nChars = arr[0].length;
  while (nChars < maxChars && nWords < arr.length) {
    nChars += sep.length + arr[nWords].length;
    ++nWords;
  }
  if (nChars <= maxChars && nWords === arr.length) {
    return arr.join(sep);
  }
  return arr.slice(0, nWords - 1).join(sep) + "…";
}

function assignmentOptionToAssignmentItem(
  dimension: TAssignmentOption,
): IAssignment {
  return { text: dimension.name, value: dimension };
}

function addSizeToDimension(
  guess: TDimensions,
  size: number,
  sourceData:
    | { source: Sources.File; data: IFileSourceData }
    | { source: Sources.Filename; data: IFilenameSourceData }
    | { source: Sources.Images; data: null },
  name: string | null = null,
): void {
  if (size === 0) {
    return;
  }
  const { source, data } = sourceData;

  const dim =
    source === Sources.File &&
    dimensions.value.find(
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

  let computedName = name;
  if (!computedName) {
    computedName = "";
    switch (source) {
      case Sources.Filename:
        computedName = `Filename variable ${++filenameVariableCount}`;
        break;
      case Sources.File:
        computedName = `Metadata ${++fileVariableCount} (${dimensionNames[guess]})`;
        break;
      case Sources.Images:
        computedName = `Image variable ${++imageVariableCount}`;
        break;
    }
  }
  const newDimension: TAssignmentOption = {
    id: assignmentIdCount++,
    guess,
    size,
    name: computedName,
    ...sourceData,
  };
  dimensions.value = [...dimensions.value, newDimension];
}

function getDefaultAssignmentItem(assignment: string) {
  const assignmentOption =
    dimensions.value.find(
      ({ guess, source, size }) =>
        source === Sources.File && size > 0 && guess === assignment,
    ) ||
    dimensions.value.find(
      ({ guess, size }) => size > 0 && guess === assignment,
    ) ||
    null;
  if (assignmentOption) {
    return assignmentOptionToAssignmentItem(assignmentOption);
  }
  return null;
}

function resetDimensionsToDefault() {
  for (const dim in dimensionNames) {
    assignments[dim as TUpDim] = getDefaultAssignmentItem(dim);
  }
}

function areDimensionsSetToDefault() {
  return Object.keys(dimensionNames).every(
    (dim) =>
      getDefaultAssignmentItem(dim)?.value ===
      assignments[dim as TUpDim]?.value,
  );
}

function isAssignmentImmutable(assignment: IAssignment) {
  const value = assignment.value;
  if (!(value.source === Sources.File)) {
    return false;
  }
  const itemIndices = Object.keys(value.data).map(Number);
  return itemIndices.every((idx) =>
    girderItems.value[idx].name.toLowerCase().endsWith(".nd2"),
  );
}

function assignmentDisabled(dimension: TUpDim) {
  const currentAssignment = assignments[dimension];
  return (
    (currentAssignment && isAssignmentImmutable(currentAssignment)) ||
    assignmentItems.value.length === 0
  );
}

function clearDisabled(dimension: TUpDim) {
  const currentAssignment = assignments[dimension];
  return !currentAssignment || isAssignmentImmutable(currentAssignment);
}

function isVariableAssigned(item: TAssignmentOption): boolean {
  return Object.values(assignments).some(
    (assignment) => assignment?.value.id === item.id,
  );
}

function getAssignedDimension(item: TAssignmentOption): string | null {
  for (const [dim, assignment] of Object.entries(assignments)) {
    if (assignment?.value.id === item.id) {
      return dim;
    }
  }
  return null;
}

function getAssignedDimensionColor(item: TAssignmentOption): string {
  const dim = getAssignedDimension(item);
  if (dim && dim in variableColors) {
    return variableColors[dim as TUpDim];
  }
  return "rgba(255, 255, 255, 0.3)";
}

function getSlotClasses(dimension: TUpDim): Record<string, boolean> {
  const hasAssignment = !!assignments[dimension];
  const hasAvailableVariables = assignmentItems.value.length > 0;
  const isImmutable =
    hasAssignment && isAssignmentImmutable(assignments[dimension]!);

  return {
    "assignment-slot--filled": hasAssignment,
    "assignment-slot--empty-available": !hasAssignment && hasAvailableVariables,
    "assignment-slot--empty-none": !hasAssignment && !hasAvailableVariables,
    "assignment-slot--immutable": isImmutable,
  };
}

function getSlotStyle(dimension: TUpDim): Record<string, string> {
  const color = variableColors[dimension];
  const hasAssignment = !!assignments[dimension];
  const hasAvailableVariables = assignmentItems.value.length > 0;

  if (!hasAssignment && !hasAvailableVariables) {
    return {
      backgroundColor: `${color}15`,
      borderColor: `${color}40`,
    };
  }
  return {};
}

function getAssignmentBadgeStyleForSlot(
  dimension: TUpDim,
): Record<string, string> {
  const assignment = assignments[dimension];
  if (!assignment) return {};

  const dimensionColor = variableColors[dimension];
  return {
    borderLeftColor: dimensionColor,
    backgroundColor: `${dimensionColor}15`,
  };
}

function getAssignmentText(dimension: TUpDim): string {
  return assignments[dimension]?.text ?? "";
}

function getAssignmentValues(dimension: TUpDim): string {
  const assignment = assignments[dimension];
  if (!assignment) return "";
  return getItemValues(assignment.value);
}

function getAssignmentSize(dimension: TUpDim): number {
  return assignments[dimension]?.value.size ?? 0;
}

function getItemValues(item: TAssignmentOption): string {
  switch (item.source) {
    case Sources.Filename:
      return sliceAndJoin((item.data as IFilenameSourceData).values, 24);
    case Sources.File: {
      const allValues = extractFileSourceValues(item.data as IFileSourceData);
      if (allValues.length > 0) {
        return sliceAndJoin(allValues, 24);
      }
      return `${item.size} values`;
    }
    case Sources.Images:
      return `${item.size} values`;
    default:
      return "";
  }
}

function isAssignmentImmutableForDimension(dimension: TUpDim): boolean {
  const assignment = assignments[dimension];
  return assignment ? isAssignmentImmutable(assignment) : false;
}

function submitEnabled() {
  const filledAssignments = Object.values(assignments).reduce(
    (count, assignment) => (assignment ? ++count : count),
    0,
  );
  return (
    !initializing.value &&
    (filledAssignments >= items.value.length || filledAssignments >= 4)
  );
}

function getValueFromAssignments(
  dim: TDimensions,
  itemIdx: number,
  frameIdx: number,
): number {
  const assignmentValue = assignments[dim]?.value;
  if (!assignmentValue) {
    return 0;
  }
  switch (assignmentValue.source) {
    case Sources.File: {
      const fileData = assignmentValue.data as IFileSourceData;
      return fileData[itemIdx]
        ? Math.floor(frameIdx / fileData[itemIdx].stride) %
            fileData[itemIdx].range
        : 0;
    }
    case Sources.Filename: {
      const filenameData = assignmentValue.data as IFilenameSourceData;
      const filename = girderItems.value[itemIdx].name;
      return filenameData.valueIdxPerFilename[filename];
    }
    case Sources.Images:
      return frameIdx;
  }
}

function getCompositingValueFromAssignments(
  dim: TDimensions,
  itemIdx: number,
  frameIdx: number,
): number {
  const assignmentValue = assignments[dim]?.value;
  if (!assignmentValue) {
    return 0;
  }
  switch (assignmentValue.source) {
    case Sources.File: {
      const fileData = assignmentValue.data as IFileSourceData;
      return fileData[itemIdx]
        ? Math.floor(frameIdx / fileData[itemIdx].stride) %
            fileData[itemIdx].range
        : 0;
    }
    case Sources.Filename: {
      const filenameData = assignmentValue.data as IFilenameSourceData;
      const filename = girderItems.value[itemIdx].name;
      return filenameData.valueIdxPerFilename[filename];
    }
    case Sources.Images:
      return frameIdx;
  }
}

function extractDimensionLabels(dim: TUpDim): string[] | null {
  const assignment = assignments[dim]?.value;
  if (!assignment) return null;

  if (assignment.source === Sources.File && tilesInternalMetadata.value) {
    const nd2Labels = extractDimensionLabelsFromND2(
      dim,
      tilesInternalMetadata.value,
      assignment.size,
    );
    if (nd2Labels) {
      return nd2Labels;
    }
  }

  switch (assignment.source) {
    case Sources.File: {
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
    }
    case Sources.Filename:
      return assignment.data.values;

    case Sources.Images:
      return Array.from({ length: assignment.size }, (_, i) => `${i + 1}`);
  }
}

function copyLogToClipboard() {
  if (navigator.clipboard && logs.value) {
    navigator.clipboard.writeText(logs.value);
    showCopySnackbar.value = true;
  }
}

function getDimensionStrategy(): IDimensionStrategy {
  const strategy: IDimensionStrategy = {
    XY: null,
    Z: null,
    T: null,
    C: null,
    transcode: transcode.value,
  };

  for (const dim of ["XY", "Z", "T", "C"] as const) {
    const assignment = assignments[dim];
    if (assignment?.value) {
      strategy[dim] = {
        source: assignment.value.source,
        guess: assignment.value.guess,
      };
    }
  }

  return strategy;
}

function saveDimensionStrategyToStore() {
  if (
    !store.uploadWorkflow.active ||
    !store.uploadWorkflow.batchMode ||
    !store.uploadIsFirstDataset
  ) {
    return;
  }

  const strategy = getDimensionStrategy();
  store.setUploadDimensionStrategy(strategy);
}

async function initialize() {
  if (initializing.value) {
    reinitializeFlag = true;
    return;
  }
  initializing.value = true;
  do {
    reinitializeFlag = false;
    await initializeImplementation();
  } while (reinitializeFlag);
  initializing.value = false;
}

async function initializeImplementation() {
  const fetchedItems = await store.api.getItems(props.datasetId);

  girderItems.value = fetchedItems;

  const names = fetchedItems.map((item: IGirderItem) => item.name);

  transcode.value = !names.every((name: string) =>
    name.toLowerCase().endsWith(".nd2"),
  );

  if (names.length > 1) {
    collectFilenameMetadata2(names).forEach((filenameData) => {
      addSizeToDimension(filenameData.guess, filenameData.values.length, {
        source: Sources.Filename,
        data: filenameData,
      });
    });
  }

  const fileExtensions = names.map((name: string) => {
    const parts = name.split(".");
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
  });
  const hasOibFiles = fileExtensions.includes("oib");

  if (hasOibFiles) {
    try {
      for (const item of fetchedItems) {
        if (item.name.toLowerCase().endsWith(".oib")) {
          try {
            await store.api.createLargeImage(item);
            await new Promise((r) => setTimeout(r, 5000));
          } catch (createError) {
            logError(
              `Error creating large image for ${item.name}:`,
              createError,
            );
          }
        }
      }
    } catch (error) {
      logError("Error in OIB pre-processing:", error);
    }
  }

  initTotal.value = fetchedItems.length;
  initCompleted.value = 0;
  initPending.value = fetchedItems.map((item: IGirderItem) => item.name);
  initInFlight.value = [];
  initError.value = null;

  const limit = pLimit(4);

  try {
    const promises = fetchedItems.map((item: IGirderItem, idx: number) =>
      limit(async () => {
        try {
          initInFlight.value.push(item.name);

          const tilesMeta = await pRetry(async () => store.api.getTiles(item), {
            retries: hasOibFiles ? 15 : 10,
            onFailedAttempt: (error: any) => {
              const attemptNumber = error?.attemptNumber || 0;
              const message =
                error?.response?.data?.message || error?.message || "";
              logError(
                `Error retrieving tiles for item ${item._id} (attempt ${attemptNumber}):`,
                message,
              );

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
          });

          const internalMetadata = await pRetry(
            async () => store.api.getTilesInternalMetadata(item),
            { retries: 3 },
          );

          initCompleted.value++;
          initPending.value = initPending.value.filter(
            (name) => name !== item.name,
          );
          initInFlight.value = initInFlight.value.filter(
            (name) => name !== item.name,
          );

          return { idx, tilesMetadata: tilesMeta, internalMetadata };
        } catch (error: any) {
          initInFlight.value = initInFlight.value.filter(
            (name) => name !== item.name,
          );

          initError.value = {
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
    promiseResults.sort((a: any, b: any) => a.idx - b.idx);
    tilesMetadata.value = promiseResults.map((r: any) => r.tilesMetadata);
    tilesInternalMetadata.value = promiseResults.map(
      (r: any) => r.internalMetadata,
    );
  } catch (error) {
    logError("Failed to process tiles metadata:", error);
    throw error;
  }

  if (!tilesMetadata.value || !tilesInternalMetadata.value) {
    logError("Failed to retrieve tiles or internal metadata after retries");
    throw "Could not retrieve tiles from Girder";
  }

  const firstItem = tilesMetadata.value[0];
  rgbBandCount.value = firstItem?.bandCount || 0;
  isRGBFile.value = detectColorVsChannels(firstItem);

  let maxFramesPerItem = 0;
  let hasFileVariable = false;
  tilesMetadata.value.forEach((tile, tileIdx) => {
    const frames: number = tile.frames?.length || 1;
    maxFramesPerItem = Math.max(maxFramesPerItem, frames);
    if (tile.IndexRange && tile.IndexStride) {
      hasFileVariable = true;
      for (const dim in dimensionNames) {
        const indexDim = `Index${dim}`;
        const range = tile.IndexRange[indexDim];
        if (range) {
          addSizeToDimension(dim as TDimensions, range, {
            source: Sources.File,
            data: {
              [tileIdx]: {
                range: range,
                stride: tile.IndexStride[indexDim],
                values: dim === "C" ? tile.channels : null,
              },
            },
          });
        }
      }
    }
  });

  if (!hasFileVariable) {
    logWarning(
      `[MultiSourceConfig] No file variables found, adding Images dimension for Z with size=${maxFramesPerItem}`,
    );
    addSizeToDimension(
      "Z",
      maxFramesPerItem,
      { source: Sources.Images, data: null },
      "All frames per item",
    );
  }

  resetDimensionsToDefault();
}

async function submit() {
  const jsonId = await generateJson();

  emit("generatedJson", jsonId, lastGeneratedConfig.value);

  if (!jsonId) {
    return;
  }
  if (props.autoDatasetRoute) {
    (instance as any).$router.push({
      name: "dataset",
      params: { datasetId: props.datasetId },
    });
  }
}

async function generateJson(): Promise<string | null> {
  let channels: string[] | null = null;
  const channelAssignment = assignments.C?.value;
  if (channelAssignment) {
    switch (channelAssignment.source) {
      case Sources.File: {
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
      }
      case Sources.Filename: {
        const filenameData = channelAssignment.data as IFilenameSourceData;
        channels = filenameData.values;
        break;
      }
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

  const xyLabels: string[] | null = extractDimensionLabels("XY");
  const zLabels: string[] | null = extractDimensionLabels("Z");
  const tLabels: string[] | null = extractDimensionLabels("T");

  if (isMultiBandRGBFile.value && splitRGBBands.value) {
    const bandSuffixes = [" - Red", " - Green", " - Blue"];
    const expandedChannels: string[] = [];
    for (const ch of channels) {
      for (let b = 0; b < rgbBandCount.value; b++) {
        expandedChannels.push(`${ch}${bandSuffixes[b] || `_band${b}`}`);
      }
    }
    channels = expandedChannels;
  }

  const sources: ICompositingSource[] | IBasicSource[] = [];

  if (shouldDoCompositing.value) {
    const compositingSources: ICompositingSource[] =
      sources as ICompositingSource[];
    if (!tilesMetadata.value) {
      return null;
    }
    for (let itemIdx = 0; itemIdx < girderItems.value.length; ++itemIdx) {
      const item = girderItems.value[itemIdx];
      const nFrames = tilesMetadata.value[itemIdx].frames?.length || 1;

      if (isMultiBandRGBFile.value && splitRGBBands.value) {
        for (let frameIdx = 0; frameIdx < nFrames; ++frameIdx) {
          for (let bandIdx = 0; bandIdx < rgbBandCount.value; bandIdx++) {
            compositingSources.push({
              path: item.name,
              xySet: getValueFromAssignments("XY", itemIdx, frameIdx),
              zSet: getValueFromAssignments("Z", itemIdx, frameIdx),
              tSet: getValueFromAssignments("T", itemIdx, frameIdx),
              cSet: bandIdx,
              frames: [frameIdx],
              style: { bands: [{ band: bandIdx + 1 }] },
            });
          }
        }
      } else {
        for (let frameIdx = 0; frameIdx < nFrames; ++frameIdx) {
          compositingSources.push({
            path: item.name,
            xySet: getCompositingValueFromAssignments("XY", itemIdx, frameIdx),
            zSet: getCompositingValueFromAssignments("Z", itemIdx, frameIdx),
            tSet: getCompositingValueFromAssignments("T", itemIdx, frameIdx),
            cSet: getCompositingValueFromAssignments("C", itemIdx, frameIdx),
            frames: [frameIdx],
          });
        }
      }
    }
    const { mm_x, mm_y } = tilesMetadata.value![0];
    const { sizeX, sizeY } = tilesMetadata.value![0];
    const framesMetadata = tilesInternalMetadata.value![0].nd2_frame_metadata;
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
          tilesInternalMetadata.value![0].nd2 &&
          tilesInternalMetadata.value![0].nd2.channels
        ) {
          const chan = tilesInternalMetadata.value![0].nd2.channels;
          const chan0 =
            chan.volume !== undefined ? chan.volume : chan[0].volume;
          if (
            chan0.cameraTransformationMatrix &&
            (Math.abs(chan0.cameraTransformationMatrix[0] - 1) > 0.01 ||
              Math.abs(chan0.cameraTransformationMatrix[3] - 1) > 0.01)
          ) {
            if (
              Math.abs(chan0.cameraTransformationMatrix[0] - -1) < 0.01 &&
              Math.abs(chan0.cameraTransformationMatrix[3] - -1) < 0.01
            ) {
              pos.s11 = -1.0;
              pos.s12 = 0.0;
              pos.s21 = 0.0;
              pos.s22 = -1.0;
            } else {
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
    const corners = [
      { x: 0, y: 0 },
      { x: sizeX, y: 0 },
      { x: 0, y: sizeY },
      { x: sizeX, y: sizeY },
    ];
    const transformedCorners = corners.map((corner) => ({
      x:
        (coordinates[0]?.s11 ?? 1) * corner.x +
        (coordinates[0]?.s12 ?? 0) * corner.y,
      y:
        (coordinates[0]?.s21 ?? 0) * corner.x +
        (coordinates[0]?.s22 ?? 1) * corner.y,
    }));
    const offsetMin = {
      x: Math.min(...transformedCorners.map((c) => c.x)),
      y: Math.min(...transformedCorners.map((c) => c.y)),
    };
    const offsetMax = {
      x: Math.max(...transformedCorners.map((c) => c.x)),
      y: Math.max(...transformedCorners.map((c) => c.y)),
    };
    const minCoordinate = {
      x:
        Math.min(...coordinates.map((coordinate) => coordinate.x)) +
        offsetMin.x,
      y:
        Math.min(...coordinates.map((coordinate) => coordinate.y)) -
        offsetMax.y,
    };
    const maxCoordinate = {
      x:
        Math.max(...coordinates.map((coordinate) => coordinate.x)) +
        offsetMax.x,
      y:
        Math.max(...coordinates.map((coordinate) => coordinate.y)) -
        offsetMin.y,
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
    const basicSources: IBasicSource[] = sources as IBasicSource[];
    for (let itemIdx = 0; itemIdx < girderItems.value.length; ++itemIdx) {
      const item = girderItems.value[itemIdx];
      if (!tilesMetadata.value || !tilesInternalMetadata.value) {
        continue;
      }

      if (isMultiBandRGBFile.value && splitRGBBands.value) {
        const nFrames = tilesMetadata.value[itemIdx].frames?.length || 1;
        for (let frameIdx = 0; frameIdx < nFrames; ++frameIdx) {
          for (let bandIdx = 0; bandIdx < rgbBandCount.value; bandIdx++) {
            basicSources.push({
              path: item.name,
              style: { bands: [{ band: bandIdx + 1 }] },
              c: bandIdx,
              tValues: [getValueFromAssignments("T", itemIdx, frameIdx)],
              zValues: [getValueFromAssignments("Z", itemIdx, frameIdx)],
              xyValues: [getValueFromAssignments("XY", itemIdx, frameIdx)],
            });
          }
        }
      } else {
        const framesAsAxes: TFramesAsAxes = {};
        const dimValues: { [dim in TLowDim]?: number } = {};

        for (const dim in assignments) {
          const upDim = dim as TUpDim;
          const lowDim = dim.toLowerCase() as TLowDim;
          const assignment = assignments[upDim];
          if (!assignment) {
            continue;
          }
          let dimValue = 0;
          switch (assignment.value.source) {
            case Sources.File: {
              const fileSource = assignment.value.data;
              framesAsAxes[lowDim] = fileSource[itemIdx].stride;
              break;
            }
            case Sources.Filename: {
              const filenameSource = assignment.value.data;
              dimValue = filenameSource.valueIdxPerFilename[item.name];
              break;
            }
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

  const configData = {
    channels,
    sources,
    uniformSources: true,
    singleBand: isMultiBandRGBFile.value,
  };

  lastGeneratedConfig.value = configData;
  emit("configData", configData);

  logs.value = "";
  isUploading.value = true;
  transcodeProgress.value = undefined;
  if (transcode.value) {
    progressStatusText.value = "Preparing transcoding";
  } else {
    progressStatusText.value = "Preparing dataset";
  }

  const eventCallback = (jobData: IJobEventData) => {
    if (jobData.text) {
      logs.value += jobData.text;
      emit("log", logs.value);
      const progress = parseTranscodeOutput(jobData.text);
      progressStatusText.value = progress.progressStatusText;
      if (progress.transcodeProgress !== undefined)
        transcodeProgress.value = progress.transcodeProgress;
      if (progress.currentFrame !== undefined)
        currentFrame.value = progress.currentFrame;
      if (progress.totalFrames !== undefined)
        totalFrames.value = progress.totalFrames;
    }
  };

  const datasetId = props.datasetId;
  try {
    const itemId = await store.addMultiSourceMetadata({
      parentId: datasetId,
      metadata: JSON.stringify(configData),
      transcode: transcode.value,
      eventCallback,
    });

    if (!itemId) {
      throw new Error("Failed to add multi source");
    }

    try {
      const dimensionLabels = {
        xy: xyLabels,
        z: zLabels,
        t: tLabels,
      };
      await store.api.updateDatasetMetadata(datasetId, {
        dimensionLabels: dimensionLabels,
      });
      await store.girderResources.ressourceChanged(datasetId);
    } catch (labelError) {
      logError("Failed to store dimension labels (non-fatal):", labelError);
    }

    store.scheduleTileFramesComputation(datasetId);
    store.scheduleMaxMergeCache(datasetId);
    store.scheduleHistogramCache(datasetId);

    return itemId;
  } catch (error) {
    logError("Failed to create multi source:", error);
    return null;
  }
}

async function reinitializeAndApplyStrategy(
  strategy: IDimensionStrategy,
): Promise<void> {
  while (initializing.value) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  dimensions.value = [];
  assignments.XY = null;
  assignments.Z = null;
  assignments.T = null;
  assignments.C = null;
  tilesMetadata.value = null;
  tilesInternalMetadata.value = null;
  girderItems.value = [];
  filenameVariableCount = 0;
  fileVariableCount = 0;
  imageVariableCount = 0;
  assignmentIdCount = 0;
  initTotal.value = 0;
  initCompleted.value = 0;
  initPending.value = [];
  initInFlight.value = [];
  initError.value = null;

  initializing.value = true;
  try {
    await initializeImplementation();
  } finally {
    initializing.value = false;
  }

  applyDimensionStrategy(strategy);
}

function applyDimensionStrategy(strategy: IDimensionStrategy): void {
  transcode.value = strategy.transcode;

  for (const dim of ["XY", "Z", "T", "C"] as const) {
    const savedStrategy = strategy[dim];

    if (!savedStrategy) {
      logWarning(
        `[MultiSourceConfig] No saved strategy for ${dim}, setting to null`,
      );
      assignments[dim] = null;
      continue;
    }

    let matchingDimension = dimensions.value.find(
      (d) =>
        d.source === savedStrategy.source &&
        d.guess === savedStrategy.guess &&
        d.size > 0,
    );

    if (!matchingDimension) {
      logWarning(
        `[MultiSourceConfig] No exact match for ${dim}, trying guess-only match`,
      );
      matchingDimension = dimensions.value.find(
        (d) => d.guess === savedStrategy.guess && d.size > 0,
      );
    }

    if (!matchingDimension) {
      logWarning(
        `[MultiSourceConfig] No guess match for ${dim}, trying source-only match`,
      );
      matchingDimension = dimensions.value.find(
        (d) => d.source === savedStrategy.source && d.size > 0,
      );
    }

    if (matchingDimension) {
      assignments[dim] = assignmentOptionToAssignmentItem(matchingDimension);
    } else {
      logWarning(
        `[MultiSourceConfig] No match found for ${dim}, using default`,
      );
      assignments[dim] = getDefaultAssignmentItem(dim);
    }
  }
}

// --- Watchers ---

watch(
  () => assignments,
  () => saveDimensionStrategyToStore(),
  { deep: true },
);

watch(
  () => transcode.value,
  () => saveDimensionStrategyToStore(),
);

watch(
  () => props.datasetId,
  () => initialize(),
);

// --- Lifecycle ---

onMounted(() => {
  initialized.value = initialize();
});

// --- Expose for parent components and tests ---

defineExpose({
  // Refs
  tilesInternalMetadata,
  tilesMetadata,
  enableCompositing,
  transcode,
  isUploading,
  logs,
  showLogDialog,
  showCopySnackbar,
  lastGeneratedConfig,
  transcodeProgress,
  progressStatusText,
  totalFrames,
  currentFrame,
  isRGBFile,
  rgbBandCount,
  splitRGBBands,
  initTotal,
  initCompleted,
  initPending,
  initInFlight,
  initError,
  dimensions,
  assignments,
  girderItems,
  initialized,
  initializing,
  // Computed
  isMultiBandRGBFile,
  initProgressPercent,
  initPendingDisplay,
  canDoCompositing,
  shouldDoCompositing,
  fileCount,
  framesPerFile,
  datasetTotalFrames,
  items,
  filenameVariables,
  highlightedFilenameSegments,
  filenameLegend,
  assignmentItems,
  submitError,
  isRGBAssignmentValid,
  // Methods
  detectColorVsChannels,
  sliceAndJoin,
  assignmentOptionToAssignmentItem,
  addSizeToDimension,
  getDefaultAssignmentItem,
  resetDimensionsToDefault,
  areDimensionsSetToDefault,
  isAssignmentImmutable,
  assignmentDisabled,
  clearDisabled,
  isVariableAssigned,
  getAssignedDimension,
  getAssignedDimensionColor,
  getSlotClasses,
  getSlotStyle,
  getAssignmentBadgeStyleForSlot,
  getAssignmentText,
  getAssignmentValues,
  getAssignmentSize,
  getItemValues,
  isAssignmentImmutableForDimension,
  submitEnabled,
  getValueFromAssignments,
  getCompositingValueFromAssignments,
  submit,
  generateJson,
  extractDimensionLabels,
  copyLogToClipboard,
  getDimensionStrategy,
  saveDimensionStrategyToStore,
  initialize,
  reinitializeAndApplyStrategy,
  applyDimensionStrategy,
  // Constants
  dimensionNames,
  dimesionNamesEntries,
  variableColors,
});
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

/* Variables Summary */
.variables-summary {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.variables-summary__item {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.variables-summary__item--total {
  padding-left: 8px;
  border-left: 1px solid rgba(255, 255, 255, 0.15);
}

.variables-summary__value {
  font-size: 20px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
}

.variables-summary__label {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.5);
}

.variables-summary__divider {
  font-size: 16px;
  color: rgba(255, 255, 255, 0.3);
}

/* Variables List */
.variables-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 0;
}

.variables-list-empty {
  color: rgba(255, 255, 255, 0.5);
  font-style: italic;
  padding: 16px;
}

/* Variable Row */
.variable-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 4px;
  transition: background 0.15s ease;
}

.variable-row:hover {
  background: rgba(255, 255, 255, 0.05);
}

.variable-row__accent {
  width: 4px;
  height: 28px;
  border-radius: 2px;
  background-color: var(--row-accent-color);
  flex-shrink: 0;
}

.variable-row__name {
  font-weight: 500;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.9);
  min-width: 160px;
  flex-shrink: 0;
}

.variable-row__values {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.variable-row__values-icon {
  color: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.15s ease;
}

.variable-row__values-icon:hover {
  color: rgba(255, 255, 255, 0.8);
}

.variable-row__source {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  display: flex;
  align-items: center;
  text-transform: capitalize;
  min-width: 90px;
  flex-shrink: 0;
}

.variable-row__size {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  font-weight: 500;
  min-width: 70px;
  flex-shrink: 0;
  text-align: right;
}

.variable-row__assignment {
  min-width: 50px;
  flex-shrink: 0;
  text-align: center;
}

.variable-row__assignment-tag {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 4px;
  color: white;
}

.variable-row__unassigned {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.25);
}

/* Assignment Slots Container */
.assignment-slots-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 0;
}

.assignment-slot-row {
  display: flex;
  align-items: center;
  gap: 16px;
}

/* Dimension Label */
.assignment-slot__label {
  min-width: 100px;
  padding: 8px 12px;
  border-left: 4px solid;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 0 4px 4px 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.assignment-slot__dimension-name {
  font-weight: 500;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.9);
}

.assignment-slot__dimension-code {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  font-family: monospace;
}

/* The Slot */
.assignment-slot {
  flex: 1;
  min-height: 44px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  transition: all 0.2s ease;
}

.assignment-slot--filled {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.assignment-slot--empty-available {
  border: 2px dashed rgba(255, 255, 255, 0.3);
  background: transparent;
  cursor: pointer;
}

.assignment-slot--empty-available:hover {
  border-color: rgba(255, 255, 255, 0.5);
  background: rgba(255, 255, 255, 0.05);
}

.assignment-slot--empty-none {
  border: 1px solid;
  cursor: default;
}

.assignment-slot--immutable {
  background: rgba(255, 255, 255, 0.02);
}

/* Badge inside slot */
.assignment-slot__badge {
  display: flex;
  align-items: center;
  padding: 8px 14px;
  border-left: 3px solid;
  border-radius: 4px;
  margin: 4px;
  flex: 1;
}

.assignment-slot__badge-name {
  font-weight: 500;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.9);
}

.assignment-slot__badge-values {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  margin-left: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assignment-slot__badge-size {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  margin-left: 8px;
  font-weight: 500;
}

/* Empty slot content */
.assignment-slot__empty {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 14px;
  cursor: pointer;
}

.assignment-slot__placeholder {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.4);
  font-style: italic;
}

/* Actions */
.assignment-slot__actions {
  display: flex;
  align-items: center;
  min-width: 80px;
}

/* Dropdown menu items */
.dropdown-item-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dropdown-item-name {
  font-weight: 500;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.9);
}

.dropdown-item-values {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
}

/* Values Popover */
.values-popover {
  min-width: 200px;
  max-width: 350px;
}

.values-popover__title {
  font-size: 14px !important;
  font-weight: 500;
  padding: 12px 16px !important;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.values-popover__count {
  font-size: 12px;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.5);
}

.values-popover__list {
  max-height: 240px;
  overflow-y: auto;
  padding: 8px 0;
}

.values-popover__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
}

.values-popover__index {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  min-width: 24px;
  font-family: monospace;
}

.values-popover__value {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
}
</style>
