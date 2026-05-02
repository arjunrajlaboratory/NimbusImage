<template>
  <div v-if="min !== max || isUnrolled" class="value-slider">
    <!-- Show unrolled message when unrolled -->
    <div v-if="isUnrolled" class="unrolled-message">
      {{ unrolledMessage }}
    </div>
    <!-- Show normal slider when not unrolled -->
    <template v-else>
      <!-- Row 1: Label, Text Input, "/max" suffix, Step arrows -->
      <div class="d-flex align-center">
        <div class="label-column text-right pa-0">{{ label }}:</div>
        <v-text-field
          :model-value="displayValue"
          class="mt-0 pt-0 no-underline flex-grow-1 ml-2"
          hide-details
          single-line
          type="text"
          density="compact"
          @update:model-value="handleInput"
          @blur="handleBlur"
        />
        <span class="counter-label ml-1">/{{ max + offset }}</span>
        <div class="step-arrows ml-1">
          <v-btn
            size="x-small"
            icon
            class="step-btn"
            :disabled="modelValue >= max"
            @click="increment"
          >
            <v-icon size="x-small">mdi-chevron-up</v-icon>
          </v-btn>
          <v-btn
            size="x-small"
            icon
            class="step-btn"
            :disabled="modelValue <= min"
            @click="decrement"
          >
            <v-icon size="x-small">mdi-chevron-down</v-icon>
          </v-btn>
        </div>
      </div>

      <!-- Row 2: Full-width slider (no left spacer — track extends under
           the label so it has the maximum pixels-per-step). -->
      <div ref="sliderRowRef" class="slider-row">
        <v-slider
          v-model="slider"
          :max="max + offset"
          :min="min + offset"
          :step="1"
          hide-details
          @start="onDragStart"
          @end="onDragEnd"
        />
        <!-- Single tooltip combining the caller-supplied description (count,
             hotkeys) with the Shift fine-adjust hint when the slider is dense
             enough to benefit. Anchored to the slider-row so it activates on
             hover of the track only, not the input field or arrows. Right
             side ("end") avoids covering the row above.
             FRAGILITY: relies on Vuetify's `activator="parent"` semantics
             (hover detection on the immediate `v-tooltip` parent element).
             See fragility point #7 in
             codebaseDocumentation/SLIDER_VUE3_VUETIFY4_FIX.md. -->
        <v-tooltip
          v-if="title || showFineHint"
          activator="parent"
          location="end"
          open-delay="600"
        >
          <div v-if="title">{{ title }}</div>
          <div v-if="showFineHint">Hold Shift for fine adjustment</div>
        </v-tooltip>
      </div>
    </template>
  </div>
</template>

<style scoped>
.value-slider {
  flex: 1;
  min-width: 0;
}

.label-column {
  width: 3em;
  min-width: 3em;
  flex-shrink: 0;
}

.counter-label {
  white-space: nowrap;
  flex-shrink: 0;
  font-size: 0.7rem;
  font-weight: 300;
  font-variant-numeric: tabular-nums;
  color: rgba(var(--v-theme-on-surface), 0.6);
}

.slider-row {
  /* Track gets the full ValueSlider width; no left label-column spacer so
     dense (>100-step) sliders have the most pixels-per-step possible. */
  width: 100%;
}

.slider-row :deep(.v-slider) {
  margin-top: 1px;
  margin-bottom: 0;
}

.unrolled-message {
  padding: 4px 0;
  font-size: inherit;
}

/* Kill the v-text-field underline (normal and focused) */
.no-underline :deep(.v-text-field__details) {
  display: none;
}

.no-underline :deep(.v-input__slot:before),
.no-underline :deep(.v-input__slot:after) {
  display: none;
}

/* Step arrows styling */
.step-arrows {
  display: flex;
  flex-direction: column;
  margin-left: 4px;
}

.step-btn {
  height: 14px;
  width: 14px;
  min-width: 14px;
}

.step-btn .v-icon {
  font-size: 14px;
}
</style>

<script setup lang="ts">
import {
  ref,
  computed,
  watch,
  nextTick,
  onMounted,
  onBeforeUnmount,
} from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: number;
    min: number;
    max: number;
    label: string;
    offset?: number;
    valueLabel?: string | null;
    isUnrolled?: boolean;
    // Caller-supplied tooltip description (e.g., "145 Time Values
    // (Hotkeys s/f)"). Declared as a prop so Vue consumes it instead of
    // applying it as a native HTML title attribute on the root element.
    title?: string;
  }>(),
  {
    offset: 0,
    valueLabel: null,
    isUnrolled: false,
    title: "",
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: number): void;
}>();

const internalValue = ref(0);
const isDragging = ref(false);
const sliderRowRef = ref<HTMLElement | null>(null);

// At ~1.5–2px per step, Shift-drag fine adjust starts to noticeably help.
const showFineHint = computed(() => props.max - props.min >= 100);

const slider = computed({
  get: () => internalValue.value,
  set: (value: number) => {
    // One-shot suppression for the model.value write that Vuetify performs
    // inside its mouseup handler (onSliderEnd). That write is computed from
    // parseMouseMove(e) — the absolute cursor position — and would overwrite
    // the fine-adjusted value we just set during a Shift drag. See the
    // mouseup interceptor below.
    if (suppressNextSetterWrite) {
      suppressNextSetterWrite = false;
      return;
    }
    const numberValue = typeof value === "number" ? value : parseInt(value);
    if (numberValue === internalValue.value) {
      return;
    }
    internalValue.value = numberValue;
    emit("update:modelValue", numberValue - props.offset);
  },
});

const displayValue = computed(
  () => props.valueLabel || (props.modelValue + props.offset).toString(),
);

const unrolledMessage = computed(() => `${props.label} is unrolled`);

function updateInternalValue() {
  internalValue.value = props.modelValue + props.offset;
}

// Don't sync from props while user is actively dragging — Vuetify 3's v-slider
// re-emits stale values when its v-model changes externally during drag,
// creating a feedback loop that causes the slider to jump backwards.
watch(
  () => props.modelValue,
  () => {
    if (!isDragging.value) {
      updateInternalValue();
    }
  },
  { immediate: true },
);

function onDragStart() {
  isDragging.value = true;
  fineDragAnchor = null;
  suppressNextSetterWrite = false;
}

function onDragEnd() {
  isDragging.value = false;
  fineDragAnchor = null;
  // Safety reset in case the suppress flag was set on mouseup but the
  // setter wasn't actually called (e.g., disabled/readonly slider).
  suppressNextSetterWrite = false;
  // Vuetify focuses the thumb on mousedown and leaves it focused, producing
  // a persistent halo (.v-slider-thumb--focused). Blur it. @end only fires
  // for mouse/touch drags, not keyboard arrow nav, so this doesn't break
  // keyboard accessibility.
  //
  // FRAGILITY: relies on Vuetify's `.v-slider-thumb` class name. A rename
  // (or wrapping the thumb in another element) would cause this lookup to
  // return null and the halo would silently linger. See fragility point #5
  // in codebaseDocumentation/SLIDER_VUE3_VUETIFY4_FIX.md.
  const thumb = sliderRowRef.value?.querySelector(".v-slider-thumb");
  if (thumb instanceof HTMLElement) {
    thumb.blur();
  }
  // Defer the prop→internal resync to nextTick. The most recent setter's
  // emit has not yet propagated through the parent's render to props.modelValue,
  // so reading it now would briefly snap the thumb back to the previous value.
  nextTick(() => {
    if (!isDragging.value) {
      updateInternalValue();
    }
  });
}

// Shift-drag fine-adjust modifier.
//
// While Shift is held during a slider drag, scale mouse-to-value sensitivity
// down so each pixel of cursor travel maps to FINE_RATIO of a step. Standard
// Photoshop/Figma behavior; useful on dense (>150-step) sliders where each
// step is only 1–2 pixels wide.
//
// Vuetify's useSlider attaches its mousemove listener on `window` with
// { passive: true, capture: true } inside `onSliderMousedown`. We attach our
// listener at component mount (before any drag starts), so in capture phase
// on the same target ours fires first. When Shift is held during a drag, we
// stopImmediatePropagation to suppress Vuetify's listener, then write the
// fine-adjusted value via the same path Vuetify uses (internal value + emit).
// When Shift is not held we no-op and let Vuetify run normally — this avoids
// any change to non-shift drag behavior, including the recent bouncing fix.
//
// Touch events use touchmove (separate listener), so touch interactions are
// unaffected and continue to work without a Shift modifier.
//
// FRAGILITY: this whole mechanism reaches into Vuetify's private internals
// (mousemove registration options, mouseup handler, onSliderEnd write order,
// useProxiedModel controlled-mode getter, .v-slider-thumb class). Each
// Vuetify version bump should re-verify the touchpoints listed in
// codebaseDocumentation/SLIDER_VUE3_VUETIFY4_FIX.md ("Fragility — verify
// these on Vuetify version bumps"). Symptoms of a regression: thumb jumps
// on mouseup, fine drag doesn't engage, halo persists after release.
const FINE_RATIO = 0.1;
let fineDragAnchor: { clientX: number; value: number } | null = null;

// Set true by our mouseup capture handler when a fine drag is in progress;
// consumed by the slider setter to ignore the cursor-based value Vuetify
// writes inside onSliderEnd.
let suppressNextSetterWrite = false;

function onWindowMouseMoveCapture(e: MouseEvent) {
  if (!isDragging.value) {
    fineDragAnchor = null;
    return;
  }
  if (!e.shiftKey) {
    // Reset on shift release so the next shift press re-anchors at the
    // current cursor (no thumb jump back to where shift was last held).
    fineDragAnchor = null;
    return;
  }

  // Block Vuetify's mousemove listener (also on window/capture, registered
  // later) so it does not overwrite our fine-adjusted value.
  e.stopImmediatePropagation();

  if (!fineDragAnchor) {
    // First Shift-held event of this shift session. internalValue here
    // reflects the previous frame's post-Vuetify value (Vuetify's listener
    // ran in the previous event's capture phase before this event fired),
    // so anchoring at (current cursor X, current internal value) means no
    // visible jump on shift press.
    fineDragAnchor = { clientX: e.clientX, value: internalValue.value };
    return;
  }

  const sliderMin = props.min + props.offset;
  const sliderMax = props.max + props.offset;
  const pixelDelta = e.clientX - fineDragAnchor.clientX;
  const newValue = fineDragAnchor.value + Math.round(pixelDelta * FINE_RATIO);
  const clamped = Math.max(sliderMin, Math.min(sliderMax, newValue));

  if (clamped !== internalValue.value) {
    internalValue.value = clamped;
    emit("update:modelValue", clamped - props.offset);
  }
}

// Capture mouseup before Vuetify's bubble-phase listener. When a fine drag
// is active, Vuetify's mouseup → handleStop → onSliderEnd writes
// parseMouseMove(e) (the cursor-based absolute value) into model.value,
// which would overwrite the fine-adjusted value. We can't cleanly cancel
// Vuetify's mouseup (it cleans up listeners and updates internal state),
// so instead we mark the slider setter to suppress the one cursor-based
// write that's about to come through.
//
// FRAGILITY: depends on (a) Vuetify's mouseup listener being in bubble
// phase (so our capture-phase fires first), (b) onSliderEnd writing
// model.value before emitting @end (so the setter consumes the suppress
// flag before onDragEnd clears it), and (c) useProxiedModel returning
// props.modelValue from its getter when controlled (so the rendered thumb
// stays at the fine value despite Vuetify's stale internal write). See
// fragility points #2, #3, #4 in
// codebaseDocumentation/SLIDER_VUE3_VUETIFY4_FIX.md.
function onWindowMouseUpCapture() {
  if (!isDragging.value) return;
  if (fineDragAnchor) {
    suppressNextSetterWrite = true;
  }
}

onMounted(() => {
  // capture: true required to fire before Vuetify's listener and to be able
  // to stopImmediatePropagation it. Non-passive (the default) is required
  // for stopImmediatePropagation to actually suppress Vuetify.
  window.addEventListener("mousemove", onWindowMouseMoveCapture, {
    capture: true,
  });
  // Vuetify's mouseup is registered with passive: false, no capture (bubble).
  // Capture phase runs first, so this fires before Vuetify gets a chance to
  // overwrite the fine value.
  window.addEventListener("mouseup", onWindowMouseUpCapture, {
    capture: true,
  });
});

// If the slider unmounts mid-drag (dataset transition, min===max change),
// @end never fires. Reset so prop sync isn't permanently blocked.
onBeforeUnmount(() => {
  isDragging.value = false;
  fineDragAnchor = null;
  suppressNextSetterWrite = false;
  window.removeEventListener("mousemove", onWindowMouseMoveCapture, {
    capture: true,
  });
  window.removeEventListener("mouseup", onWindowMouseUpCapture, {
    capture: true,
  });
});

function handleInput(value: string) {
  const numValue = parseInt(value);
  if (!isNaN(numValue)) {
    slider.value = numValue;
    return;
  }
  if (props.valueLabel && value === props.valueLabel) {
    return;
  }
}

function handleBlur() {
  updateInternalValue();
}

function increment() {
  if (props.modelValue < props.max) {
    emit("update:modelValue", props.modelValue + 1);
  }
}

function decrement() {
  if (props.modelValue > props.min) {
    emit("update:modelValue", props.modelValue - 1);
  }
}

defineExpose({ slider, displayValue, unrolledMessage, increment, decrement });
</script>
