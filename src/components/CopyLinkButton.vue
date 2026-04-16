<template>
  <v-tooltip :text="copied ? 'Copied!' : tooltip" location="bottom">
    <template #activator="{ props: activatorProps }">
      <v-btn
        v-bind="{ ...activatorProps, ...$attrs }"
        :icon="iconOnly"
        :size="size"
        :color="copied ? 'success' : color"
        :variant="variant"
        @click="copyLink"
      >
        <v-icon :size="iconSize">
          {{ copied ? "mdi-check" : "mdi-link-variant" }}
        </v-icon>
        <span v-if="!iconOnly" class="ml-1">{{ label }}</span>
      </v-btn>
    </template>
  </v-tooltip>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** The route path to generate the link for (e.g. /project/abc123) */
    routePath: string;
    /** Tooltip text */
    tooltip?: string;
    /** Button label (hidden when iconOnly) */
    label?: string;
    /** Render as icon-only button */
    iconOnly?: boolean;
    /** Button size */
    size?: string;
    /** Icon size */
    iconSize?: string;
    /** Button color */
    color?: string;
    /** Button variant */
    variant?: "flat" | "text" | "elevated" | "tonal" | "outlined" | "plain";
  }>(),
  {
    tooltip: "Copy shareable link",
    label: "Copy Link",
    iconOnly: false,
    size: "small",
    iconSize: "small",
    color: "primary",
    variant: "outlined",
  },
);

defineOptions({ inheritAttrs: false });

const copied = ref(false);
let resetTimer: ReturnType<typeof setTimeout> | null = null;

const fullUrl = computed(() => {
  const base = window.location.origin + window.location.pathname;
  return `${base}#${props.routePath}`;
});

async function copyLink() {
  try {
    await navigator.clipboard.writeText(fullUrl.value);
    copied.value = true;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    // Fallback for older browsers
    const textarea = document.createElement("textarea");
    textarea.value = fullUrl.value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    copied.value = true;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copied.value = false;
    }, 2000);
  }
}

defineExpose({ copied, fullUrl, copyLink });
</script>
