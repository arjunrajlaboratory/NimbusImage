<template>
  <v-tooltip
    v-if="enabled"
    :top="position === 'top'"
    :right="position === 'right'"
    :bottom="position === 'bottom'"
    :left="position === 'left'"
    :activator="activator"
    :open-delay="openDelay"
    content-class="nimbus-tooltip-overlay"
  >
    <span v-html="formattedTooltip(content)"></span>
  </v-tooltip>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    activator: Element | string;
    content: string;
    position?: string;
    openDelay?: number;
    enabled?: boolean;
  }>(),
  {
    position: "bottom",
    openDelay: 0,
    enabled: true,
  },
);

function formattedTooltip(text: string): string {
  return text.replace(/\n/g, "<br>");
}
</script>

<style>
.nimbus-tooltip-overlay {
  z-index: 10001 !important;
}
</style>
