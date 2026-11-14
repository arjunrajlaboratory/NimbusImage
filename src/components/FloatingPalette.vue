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
      }"
      :style="paletteStyle"
      @click.stop
    >
      <header class="palette-header">
        <span
          class="palette-grip"
          :class="{ 'is-handle': reorderable }"
          aria-hidden="true"
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
        aria-label="Resize panel column"
        title="Drag to resize. Double-click to reset."
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
}>();

// Exposed so a parent can measure the rendered palette height (e.g. to stack
// another palette beneath it). Always in the DOM thanks to v-show.
const rootEl = ref<HTMLElement>();
defineExpose({ rootEl });

// The one drag in progress, if any. A single object so that ending or
// cancelling cannot leave half of it behind, and so the two drags cannot
// overlap.
type TGesture =
  | { kind: "resize"; pointerId: number; startX: number; startWidth: number }
  | { kind: "reorder"; pointerId: number; startY: number; offsetY: number };
const gesture = ref<TGesture | null>(null);

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
    startY: event.clientY,
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
  if (drag.kind === "resize") {
    emit("resize", resizedWidth(drag, event.clientX));
  } else {
    gesture.value = { ...drag, offsetY: event.clientY - drag.startY };
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
  if (drag?.kind === "resize") {
    emit("resize-end", resizedWidth(drag, event.clientX));
  } else if (drag?.kind === "reorder") {
    emit("reorder-end", event.clientY - drag.startY);
  }
}

// Every way a drag ends without a drop: the pointer is cancelled or its
// capture lost, Escape, or the palette going away mid-drag.
function cancelGesture(event?: PointerEvent) {
  if (takeGesture(event)?.kind === "resize") {
    emit("resize-cancel");
  }
}

function cancelOnEscape(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    cancelGesture();
  }
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
