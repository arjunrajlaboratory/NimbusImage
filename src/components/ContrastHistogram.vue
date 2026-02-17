<template>
  <div
    ref="rootEl"
    :class="{
      histogram: true,
      'theme--light': !$vuetify.theme.dark,
      'theme--dark': $vuetify.theme.dark,
    }"
  >
    <switch-toggle
      v-model="mode"
      label="Mode: "
      true-label="Absolute"
      true-value="absolute"
      false-label="Percentile"
      false-value="percentile"
      :id="`input-${componentId}`"
    />
    <div class="wrapper">
      <svg :width="width" :height="height" ref="svg">
        <path class="path" :d="areaPath" ref="path" />
      </svg>
      <div
        class="min-hint"
        :style="{ width: toValue(currentContrast, 'black') }"
      />
      <div
        class="max-hint"
        :style="{ width: toValue(currentContrast, 'white') }"
      />
      <div
        ref="min"
        class="min"
        :style="{ left: toValue(currentContrast, 'black') }"
        :title="toLabel(currentContrast.blackPoint)"
      />
      <div
        class="saved-min"
        :style="{ left: toValue(configurationContrast, 'black') }"
        :title="`Saved: ${toLabel(configurationContrast.blackPoint)}`"
      />
      <div
        ref="max"
        class="max"
        :style="{ right: toValue(currentContrast, 'white') }"
        :title="toLabel(currentContrast.whitePoint)"
      />
      <div
        class="saved-max"
        :style="{ right: toValue(configurationContrast, 'white') }"
        :title="`Saved: ${toLabel(configurationContrast.whitePoint)}`"
      />
      <resize-observer @notify="handleResize" />
    </div>
    <div class="sub">
      <v-text-field
        type="number"
        v-model="editBlackPoint"
        @keydown="validateCachedBlackPoint"
        :append-icon="editIcon"
        hide-details
        dense
      />
      <v-text-field
        type="number"
        v-model="editWhitePoint"
        @keydown="validateCachedWhitePoint"
        :append-icon="editIcon"
        hide-details
        dense
      />
    </div>
    <div class="toolbar">
      <v-btn
        x-small
        @click="reset"
        color="secondary"
        title="Reset to histogram limits"
      >
        Reset
      </v-btn>
      <v-btn
        x-small
        @click="revertSaved"
        color="secondary"
        title="Revert to saved points"
      >
        Revert to saved
      </v-btn>
      <v-btn
        x-small
        @click="saveCurrent"
        color="secondary"
        title="Save current points"
        >Save</v-btn
      >
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed, watch, onMounted } from "vue";
import SwitchToggle from "./SwitchToggle.vue";
import { IContrast } from "../store/model";
import { ITileHistogram } from "../store/images";
import { scaleLinear, scalePoint } from "d3-scale";
import { area, curveStep } from "d3-shape";
import { select, selectAll, event as d3Event } from "d3-selection";
import { drag, D3DragEvent } from "d3-drag";
import { throttle } from "lodash";
import { zoom, D3ZoomEvent, ZoomBehavior } from "d3-zoom";

function roundPer(v: number) {
  return Math.round(v * 100) / 100;
}

function roundAbs(v: number) {
  return Math.round(v);
}

// This is debounced elsewhere
const THROTTLE = 1; // ms

let uidCounter = 0;
const componentId = uidCounter++;

const props = defineProps<{
  configurationContrast: IContrast;
  viewContrast: IContrast | null;
  histogram: Promise<ITileHistogram>;
}>();

const emit = defineEmits<{
  (e: "change", value: IContrast): void;
  (e: "revert"): void;
  (e: "commit", value: IContrast): void;
}>();

// Template refs
const rootEl = ref<HTMLElement>();
const min = ref<HTMLElement>();
const max = ref<HTMLElement>();
const svg = ref<HTMLElement>();
const path = ref<HTMLElement>();

// Data
const width = ref(100);
const height = 80;

const histData = ref<ITileHistogram | null>(null);
const scale = ref(1);
const translation = ref(0);

// For typing contrast in text fields and hitting "Enter"
const cachedBlackPoint = ref<number | null>(null);
const cachedWhitePoint = ref<number | null>(null);

let _zoomBehavior: ZoomBehavior<HTMLElement, any> | null = null;

// Computeds
const currentContrast = computed(() => {
  return props.viewContrast || props.configurationContrast;
});

const editMin = computed(() => {
  return mode.value === "percentile" || !histData.value
    ? 0
    : histData.value.min;
});

const editMax = computed(() => {
  return mode.value === "percentile" || !histData.value
    ? 100
    : histData.value.max;
});

const editIcon = computed(() => {
  switch (mode.value) {
    case "percentile":
      return "mdi-percent";
    default:
      return undefined;
  }
});

const pixelRange = computed(() => {
  return [translation.value, translation.value + scale.value * width.value];
});

const histToPixel = computed(() => {
  const s = scaleLinear().domain([0, 100]).range(pixelRange.value);
  if (histData.value) {
    s.domain([histData.value.min, histData.value.max]);
  }
  return s;
});

const percentageToPixel = computed(() => {
  return scaleLinear().domain([0, 100]).range(pixelRange.value);
});

const toValue = computed(() => {
  const clamp = (x: number) => Math.min(width.value, Math.max(0, x));
  return (contrast: IContrast, color: "white" | "black") => {
    const convert =
      contrast.mode === "percentile"
        ? percentageToPixel.value
        : histToPixel.value;
    switch (color) {
      case "white":
        return `${clamp(width.value - convert(contrast.whitePoint))}px`;
      case "black":
        return `${clamp(convert(contrast.blackPoint))}px`;
    }
  };
});

function toLabel(value: number) {
  switch (mode.value) {
    case "percentile":
      return `${Math.round(value * 100) / 100}%`;
    default:
      return Math.round(value).toString();
  }
}

const emitChange = throttle((value: IContrast) => {
  emit("change", value);
}, THROTTLE);

const mode = computed({
  get: () => {
    return props.viewContrast?.mode || props.configurationContrast.mode;
  },
  set: (value: "percentile" | "absolute") => {
    const copy = Object.assign({}, currentContrast.value);
    copy.mode = value;

    const absToPer = (v: number) =>
      roundPer(percentageToPixel.value.invert(histToPixel.value(v)));
    const perToAbs = (v: number) =>
      roundAbs(histToPixel.value.invert(percentageToPixel.value(v)));
    const converter = value === "percentile" ? absToPer : perToAbs;

    copy.blackPoint = converter(copy.blackPoint);
    copy.whitePoint = converter(copy.whitePoint);

    emitChange(copy);
  },
});

const editBlackPoint = computed({
  get: () => currentContrast.value.blackPoint,
  set: (value: number) => {
    const copy = Object.assign({}, currentContrast.value);
    copy.blackPoint = typeof value === "string" ? parseInt(value, 10) : value;
    if (copy.blackPoint <= copy.whitePoint) {
      emitChange(copy);
      cachedBlackPoint.value = null;
    } else {
      cachedBlackPoint.value = copy.blackPoint;
    }
  },
});

function validateCachedBlackPoint(event: KeyboardEvent) {
  if (
    event.key === "Enter" &&
    cachedBlackPoint.value !== null &&
    cachedBlackPoint.value > editWhitePoint.value
  ) {
    editBlackPoint.value = editWhitePoint.value;
  }
}

const editWhitePoint = computed({
  get: () => currentContrast.value.whitePoint,
  set: (value: number) => {
    const copy = Object.assign({}, currentContrast.value);
    copy.whitePoint = typeof value === "string" ? parseInt(value, 10) : value;
    if (copy.blackPoint <= copy.whitePoint) {
      emitChange(copy);
      cachedWhitePoint.value = null;
    } else {
      cachedWhitePoint.value = copy.whitePoint;
    }
  },
});

function validateCachedWhitePoint(event: KeyboardEvent) {
  if (
    event.key === "Enter" &&
    cachedWhitePoint.value !== null &&
    editBlackPoint.value > cachedWhitePoint.value
  ) {
    editWhitePoint.value = editBlackPoint.value;
  }
}

function updatePoint(which: "blackPoint" | "whitePoint", pixel: number) {
  const copy = Object.assign({}, currentContrast.value);

  switch (mode.value) {
    case "percentile":
      copy[which] = roundPer(percentageToPixel.value.invert(pixel));
      break;
    default:
      copy[which] = roundAbs(histToPixel.value.invert(pixel));
      break;
  }
  if (which === "blackPoint") {
    copy.blackPoint = Math.min(copy.blackPoint, copy.whitePoint);
  } else {
    copy.whitePoint = Math.max(copy.whitePoint, copy.blackPoint);
  }
  emitChange(copy);
}

function updatePanAndZoom() {
  const evt = d3Event as D3ZoomEvent<HTMLElement, any>;
  const transform = evt.transform;
  translation.value = transform.x;
  scale.value = transform.k;
  const transformString =
    "translate(" + translation.value + ",0" + ") scale(" + scale.value + ",1)";
  select(path.value!).attr("transform", transformString);
}

function getZoomBehavior() {
  if (!_zoomBehavior) {
    _zoomBehavior = zoom<HTMLElement, any>()
      .scaleExtent([1, 32])
      .on("zoom", updatePanAndZoom);
  }
  return _zoomBehavior.translateExtent([
    [0, 0],
    [width.value, 0],
  ]);
}

watch(width, () => {
  getZoomBehavior();
});

function reset() {
  const copy = Object.assign({}, currentContrast.value);
  const s =
    mode.value === "percentile" ? percentageToPixel.value : histToPixel.value;
  copy.blackPoint = s.invert(0);
  copy.whitePoint = s.invert(width.value);
  emitChange(copy);
}

function revertSaved() {
  emit("revert");
}

function saveCurrent() {
  const copy = Object.assign({}, currentContrast.value);
  emit("commit", copy);
}

function handleResize() {
  if (rootEl.value) {
    const { width: w } = rootEl.value.getBoundingClientRect();
    width.value = w;
  }
}

const areaPath = computed(() => {
  if (!histData.value) {
    return "";
  }
  const bins = histData.value.hist;
  let maxValue = bins.reduce((acc, v) => Math.max(acc, v), 0);
  const secondMax = bins.reduce(
    (acc, v) => Math.max(acc, v !== maxValue ? v : 0),
    0,
  );
  maxValue = Math.min(maxValue, secondMax * 1.5);
  const scaleY = scaleLinear().domain([0, maxValue]).range([height, 0]);
  const scaleX = scalePoint<number>()
    .domain(bins.map((_, i) => i))
    .range([0, width.value]);

  const gen = area<number>()
    .curve(curveStep)
    .x((_, i) => scaleX(i)!)
    .y0((d) => scaleY(d)!)
    .y1(scaleY(0));
  return gen(bins) || undefined;
});

// Watch histogram prop
watch(
  () => props.histogram,
  (hist) => {
    histData.value = null;
    hist.then((data) => (histData.value = data));
  },
);

// Created equivalent — load histogram
props.histogram.then((data) => (histData.value = data));

onMounted(() => {
  handleResize();

  selectAll([min.value!, max.value!])
    .data(["blackPoint", "whitePoint"])
    .call(
      drag<HTMLElement, any>().on(
        "drag",
        (which: "blackPoint" | "whitePoint") => {
          const evt = d3Event as D3DragEvent<HTMLElement, any, any>;
          updatePoint(which, Math.max(0, Math.min(evt.x, width.value)));
        },
      ),
    );

  select(svg.value!).call(getZoomBehavior());
});

defineExpose({
  width,
  histData,
  scale,
  translation,
  cachedBlackPoint,
  cachedWhitePoint,
  currentContrast,
  mode,
  editMin,
  editMax,
  editIcon,
  pixelRange,
  histToPixel,
  percentageToPixel,
  toValue,
  toLabel,
  editBlackPoint,
  editWhitePoint,
  validateCachedBlackPoint,
  validateCachedWhitePoint,
  reset,
  revertSaved,
  saveCurrent,
  handleResize,
  areaPath,
});
</script>

<style lang="scss" scoped>
.histogram {
  margin: 0.5em 0 1em 0;
  position: relative;
  display: flex;
  flex-direction: column;
}

.wrapper {
  margin-top: 0.5em;
  position: relative;
  display: flex;

  &:hover {
    > .min {
      border-right-width: 5px;
    }

    > .max {
      border-left-width: 5px;
    }
  }
}

.toolbar {
  display: flex;
  justify-content: space-evenly;
}

.min,
.max {
  position: absolute;
  top: 0;
  height: 100%;
  transition: border-width 0.2s ease;
  width: 1px;
  cursor: ew-resize;
}

.max {
  right: 0;
  border-right: none;
}

$savedHint: 7px;

.saved-min,
.saved-max {
  position: absolute;
  top: -$savedHint;
  width: 0;
  height: 0;
  border-left: $savedHint solid transparent;
  border-right: $savedHint solid transparent;
  transform: translateX(#{-$savedHint});

  transition: all 250ms ease;

  &:hover {
    border-left: $savedHint * 1.25 solid transparent;
    border-right: $savedHint * 1.25 solid transparent;
    transform: translateX(#{-$savedHint * 1.25});
  }
}

.saved-max {
  transform: translateX(#{$savedHint});

  &:hover {
    transform: translateX(#{$savedHint * 1.25});
  }
}

.min-hint,
.max-hint {
  position: absolute;
  top: 0;
  height: 100%;
  user-select: none;
  pointer-events: none;
}

.min-hint {
  left: 0;
}

.max-hint {
  right: 0;
}

.sub {
  display: flex;
  justify-content: space-between;
  margin-bottom: 2px;

  > div:first-of-type {
    margin-right: 1em;
  }
}

.theme--dark {
  .path {
    fill: #c2c2c2;
  }

  .min {
    border-right: 1px solid lightgray;
  }

  .max {
    border-left: 1px solid lightgray;
  }

  .saved-min,
  .saved-max {
    border-top: $savedHint solid lightgray;
  }

  .min-hint,
  .max-hint {
    background: repeating-linear-gradient(
      -45deg,
      rgba(255, 255, 255, 0.5),
      rgba(255, 255, 255, 0.5) 5px,
      #696969 5px,
      #696969 10px
    );
  }
}

.theme--light {
  .path {
    fill: #c2c2c2;
  }

  .min {
    border-right: 1px solid darkgray;
  }

  .max {
    border-left: 1px solid darkgray;
  }

  .saved-min,
  .saved-max {
    border-top: $savedHint solid darkgray;
  }

  .min-hint,
  .max-hint {
    background: repeating-linear-gradient(
      -45deg,
      rgba(255, 255, 255, 0.5),
      rgba(255, 255, 255, 0.5) 5px,
      #bdbdbd 5px,
      #bdbdbd 10px
    );
  }
}
</style>
