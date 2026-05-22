<template>
  <transition name="palette-fade">
    <!-- Use v-show so the body content stays mounted across open/close.
         This preserves child state (selected items, scroll position,
         watchers that fire on visibility) the same way the previous
         v-navigation-drawer did. -->
    <aside
      v-show="modelValue"
      class="floating-palette"
      :style="paletteStyle"
      @click.stop
    >
      <header class="palette-header">
        <span class="palette-grip" aria-hidden="true">
          <i></i><i></i><i></i>
        </span>
        <h4 class="palette-title">{{ title }}</h4>
        <div class="palette-actions">
          <slot name="actions" />
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
    </aside>
  </transition>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    width?: number | string;
    /** Distance from the right edge (px) when anchor is "right". */
    right?: number;
    /** Distance from the top (px), measured below the floating app bar. */
    top?: number;
    /** Optional max-height; defaults to fitting in the viewport. */
    maxHeight?: string;
  }>(),
  {
    width: 360,
    right: 16,
    top: 72,
    maxHeight: "calc(100vh - 88px)",
  },
);

defineEmits<{
  (e: "update:modelValue", value: boolean): void;
}>();

const paletteStyle = computed(() => ({
  width: typeof props.width === "number" ? `${props.width}px` : props.width,
  right: `${props.right}px`,
  top: `${props.top}px`,
  maxHeight: props.maxHeight,
}));
</script>

<style scoped lang="scss">
.floating-palette {
  position: fixed;
  z-index: 1006; // above v-app-bar (1004 in Vuetify) so palette sits in front
  background: rgba(18, 22, 30, 0.78);
  backdrop-filter: blur(28px) saturate(140%);
  -webkit-backdrop-filter: blur(28px) saturate(140%);
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
  transition: background 0.15s ease, color 0.15s ease;

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
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.palette-fade-enter-from,
.palette-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
</style>
