<template>
  <transition name="palette-fade">
    <!-- Use v-show so the body content stays mounted across open/close.
         This preserves child state (selected items, scroll position,
         watchers that fire on visibility) the same way the previous
         v-navigation-drawer did. -->
    <aside
      v-show="modelValue"
      ref="rootEl"
      class="floating-palette"
      :class="{
        'is-resizing': gesture?.kind === 'resize',
        'is-reordering': gesture?.kind === 'reorder',
        [`resizes-${resizeEdge}`]: !!resizeEdge,
      }"
      :data-panel-id="panelId"
      :style="paletteStyle"
      @click.stop
    >
      <header class="palette-header">
        <span
          class="palette-grip"
          :class="{ 'is-handle': reorderable }"
          v-bind="
            reorderable
              ? {
                  role: 'button',
                  tabindex: 0,
                  'aria-label': `Move ${title}: drag, or press the up and down arrow keys`,
                }
              : { 'aria-hidden': 'true' }
          "
          @keydown="onGripKey"
          @pointerdown="startReorder"
          @pointermove="moveGesture"
          @pointerup="endGesture"
          @pointercancel="cancelGesture"
          @lostpointercapture="cancelGesture"
        >
          <i></i><i></i><i></i>
        </span>
        <h4 class="palette-title">{{ title }}</h4>
        <div class="palette-actions">
          <slot name="actions" />
          <button
            v-if="minimizable"
            type="button"
            class="palette-close"
            aria-label="Minimize palette"
            title="Minimize"
            @click="$emit('minimize')"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M6 12h12" />
            </svg>
          </button>
          <button
            type="button"
            class="palette-close"
            aria-label="Close palette"
            @click="$emit('update:modelValue', false)"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </header>
      <div class="palette-body">
        <slot />
      </div>
      <!-- The zone's inner edge. Drag to resize the whole zone; double-click
           to go back to the default widths. -->
      <div
        v-if="resizeEdge"
        class="palette-resize-handle"
        :class="`edge-${resizeEdge}`"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel column: drag, or press the left and right arrow keys; Enter resets"
        title="Drag to resize. Double-click to reset."
        tabindex="0"
        :aria-valuenow="typeof width === 'number' ? width : undefined"
        @keydown="onHandleKey"
        @pointerdown="startResize"
        @pointermove="moveGesture"
        @pointerup="endGesture"
        @pointercancel="cancelGesture"
        @lostpointercapture="cancelGesture"
        @dblclick="$emit('resize-reset')"
      ></div>
    </aside>
  </transition>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    width?: number | string;
    /** Distance from the right edge (px). Ignored when `left` is set. */
    right?: number;
    /** Distance from the left edge (px). When set, the palette anchors left. */
    left?: number;
    /** Distance from the top (px), measured below the floating app bar. */
    top?: number;
    /** Optional max-height; defaults to fitting in the viewport. */
    maxHeight?: string;
    /** Show a minimize button; the parent collapses the palette to a chip. */
    minimizable?: boolean;
    /** Which edge resizes the palette's zone: the one facing the canvas. */
    resizeEdge?: "left" | "right";
    /** The grip drags the palette up and down within its stack. */
    reorderable?: boolean;
    /**
     * The palette's id in the panel registry, written to the DOM so code
     * holding only an element inside it (a tour's anchor) can ask for the
     * palette that contains it to be shown.
     */
    panelId?: string;
  }>(),
  {
    width: 360,
    right: 16,
    top: 72,
    maxHeight: "calc(100vh - 88px)",
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "minimize"): void;
  /** The width the drag has reached. Unclamped: the parent owns the limits. */
  (e: "resize", width: number): void;
  (e: "resize-end", width: number): void;
  (e: "resize-cancel"): void;
  (e: "resize-reset"): void;
  /** Dropped `offsetY` px from where the drag started. */
  (e: "reorder-end", offsetY: number): void;
  /** From the keyboard: one place up (-1) or down (1) the stack. */
  (e: "reorder-step", direction: -1 | 1): void;
}>();

// Exposed so a parent can measure the rendered palette height (e.g. to stack
// another palette beneath it). Always in the DOM thanks to v-show.
const rootEl = ref<HTMLElement>();
defineExpose({ rootEl });

// The one drag in progress, if any. A single object so that ending or
// cancelling cannot leave half of it behind, and so the two drags cannot
// overlap.
type TGesture = (
  | { kind: "resize"; startWidth: number }
  | { kind: "reorder"; offsetY: number }
) & {
  pointerId: number;
  startX: number;
  startY: number;
  // False until the pointer has travelled DRAG_THRESHOLD. A press that never
  // does is a click, and a click changes nothing: without this, clicking a
  // handle committed the width it already had (fixing the zone at one
  // palette's default) and clicking a grip re-sorted the stack.
  moved: boolean;
};
const gesture = ref<TGesture | null>(null);

/** How far (px) a press must travel before it is a drag rather than a click. */
const DRAG_THRESHOLD = 3;

function beginGesture(event: PointerEvent, next: TGesture) {
  if (gesture.value || event.button !== 0) {
    return;
  }
  event.preventDefault();
  // Capture, so the drag keeps arriving here when the pointer leaves the
  // handle. (Optional call: not every DOM implements it.)
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  window.addEventListener("keydown", cancelOnEscape, true);
  gesture.value = next;
}

function startResize(event: PointerEvent) {
  beginGesture(event, {
    kind: "resize",
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    startWidth: rootEl.value?.offsetWidth ?? 0,
  });
}

function startReorder(event: PointerEvent) {
  if (!props.reorderable) {
    return;
  }
  beginGesture(event, {
    kind: "reorder",
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    offsetY: 0,
  });
}

function resizedWidth(drag: TGesture & { kind: "resize" }, clientX: number) {
  const moved = clientX - drag.startX;
  // The handle is on the edge facing the canvas, so dragging toward the
  // canvas widens: rightward for a left palette, leftward for a right one.
  return drag.startWidth + (props.resizeEdge === "right" ? moved : -moved);
}

function moveGesture(event: PointerEvent) {
  const drag = gesture.value;
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }
  const travelled = Math.abs(
    drag.kind === "resize"
      ? event.clientX - drag.startX
      : event.clientY - drag.startY,
  );
  if (!drag.moved && travelled < DRAG_THRESHOLD) {
    return;
  }
  if (drag.kind === "resize") {
    gesture.value = { ...drag, moved: true };
    emit("resize", resizedWidth(drag, event.clientX));
  } else {
    gesture.value = {
      ...drag,
      moved: true,
      offsetY: event.clientY - drag.startY,
    };
  }
}

// Clears the gesture and returns it, so each exit acts on it exactly once:
// pointerup is followed by lostpointercapture, which then finds nothing.
function takeGesture(event?: PointerEvent): TGesture | null {
  const drag = gesture.value;
  if (!drag || (event && event.pointerId !== drag.pointerId)) {
    return null;
  }
  gesture.value = null;
  window.removeEventListener("keydown", cancelOnEscape, true);
  return drag;
}

function endGesture(event: PointerEvent) {
  const drag = takeGesture(event);
  if (!drag?.moved) {
    return;
  }
  if (drag.kind === "resize") {
    emit("resize-end", resizedWidth(drag, event.clientX));
  } else {
    emit("reorder-end", event.clientY - drag.startY);
  }
}

// Every way a drag ends without a drop: the pointer is cancelled or its
// capture lost, Escape, or the palette going away mid-drag.
function cancelGesture(event?: PointerEvent) {
  const drag = takeGesture(event);
  // Only a drag that reported a width has one to take back.
  if (drag?.kind === "resize" && drag.moved) {
    emit("resize-cancel");
  }
}

function cancelOnEscape(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    cancelGesture();
  }
}

// --- The same two changes from the keyboard ----------------------------------
//
// Each key press is one complete change (there is no drag to cancel), sent
// through the events a finished drag sends, so the parent clamps and stores
// it the same way. The keys are stopped here: the arrows are also viewer
// hotkeys.

/** Width change (px) per arrow press, and with Shift held. */
const KEY_RESIZE_STEP = 16;
const KEY_RESIZE_STEP_LARGE = 64;

function onHandleKey(event: KeyboardEvent) {
  if (event.key === "Enter") {
    emit("resize-reset");
  } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    const step = event.shiftKey ? KEY_RESIZE_STEP_LARGE : KEY_RESIZE_STEP;
    // Toward the canvas widens, as with the drag.
    const towardCanvas =
      props.resizeEdge === "right" ? "ArrowRight" : "ArrowLeft";
    emit(
      "resize-end",
      (rootEl.value?.offsetWidth ?? 0) +
        (event.key === towardCanvas ? step : -step),
    );
  } else {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

function onGripKey(event: KeyboardEvent) {
  if (
    !props.reorderable ||
    (event.key !== "ArrowUp" && event.key !== "ArrowDown")
  ) {
    return;
  }
  emit("reorder-step", event.key === "ArrowUp" ? -1 : 1);
  event.preventDefault();
  event.stopPropagation();
}

onBeforeUnmount(() => cancelGesture());

const paletteStyle = computed(() => ({
  width: typeof props.width === "number" ? `${props.width}px` : props.width,
  ...(props.left != null
    ? { left: `${props.left}px` }
    : { right: `${props.right}px` }),
  top: `${props.top}px`,
  maxHeight: props.maxHeight,
  ...(gesture.value?.kind === "reorder"
    ? { transform: `translateY(${gesture.value.offsetY}px)` }
    : {}),
}));
</script>

<style scoped lang="scss">
.floating-palette {
  position: fixed;
  z-index: 1006; // above v-app-bar (1004 in Vuetify) so palette sits in front
  background: var(--nimbus-glass-bg);
  backdrop-filter: var(--nimbus-glass-filter);
  -webkit-backdrop-filter: var(--nimbus-glass-filter);
  border: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.08));
  border-radius: var(--nimbus-radius-lg, 12px);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.04) inset,
    0 0 0 0.5px rgba(255, 255, 255, 0.06),
    0 20px 40px -16px rgba(0, 0, 0, 0.7),
    0 8px 16px -8px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.palette-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 8px 10px 14px;
  border-bottom: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.06));
  cursor: default;
  flex: 0 0 auto;
}

.palette-grip {
  display: inline-flex;
  flex-direction: column;
  gap: 2.5px;
  padding-right: 2px;

  i {
    width: 12px;
    height: 1.5px;
    background: var(--nimbus-text-faint, #62666d);
    border-radius: 2px;
    display: block;
  }
}

.palette-grip.is-handle {
  cursor: grab;
  // A larger target than the three hairlines, without moving them.
  padding: 6px 6px 6px 4px;
  margin: -6px -4px -6px -4px;
  touch-action: none;
}

.palette-grip.is-handle:focus-visible,
.palette-resize-handle:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -1px;
  border-radius: 3px;
}

.palette-resize-handle:focus-visible {
  background: rgba(var(--v-theme-primary), 0.55);
}

.floating-palette.is-reordering {
  z-index: 1007; // above its neighbors while it is carried past them
  opacity: 0.92;
  transition: none;

  .palette-grip.is-handle {
    cursor: grabbing;
  }
}

.palette-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  touch-action: none;
  transition: background 0.15s ease;

  &.edge-left {
    left: 0;
  }
  &.edge-right {
    right: 0;
  }
  &:hover,
  .is-resizing > & {
    background: rgba(var(--v-theme-primary), 0.55);
  }
}

.palette-title {
  flex: 1;
  font-family: var(--nimbus-font);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--nimbus-text-secondary, #d0d6e0);
  margin: 0;
}

.palette-actions {
  display: flex;
  gap: 2px;
  align-items: center;
}

.palette-close {
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--nimbus-text-muted, #8a8f98);
  cursor: pointer;
  display: grid;
  place-items: center;
  transition:
    background 0.15s ease,
    color 0.15s ease;

  svg {
    width: 14px;
    height: 14px;
  }

  &:hover {
    background: rgba(255, 255, 255, 0.06);
    color: var(--nimbus-text-secondary, #f3f5f7);
  }
}

.palette-body {
  flex: 1 1 auto;
  overflow: auto;
  min-height: 0;
}

// The resize handle lies over the palette's edge. Keep the body, and so its
// scrollbar, out from under it: otherwise grabbing the scrollbar's outer
// edge resizes the zone instead of scrolling.
.resizes-right > .palette-body {
  margin-right: 6px;
}
.resizes-left > .palette-body {
  margin-left: 6px;
}

.palette-fade-enter-active,
.palette-fade-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}
.palette-fade-enter-from,
.palette-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
</style>
