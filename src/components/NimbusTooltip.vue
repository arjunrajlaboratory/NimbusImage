<template>
  <v-tooltip
    v-if="enabled"
    :location="(position as any)"
    :activator="(activator as any)"
    :open-delay="openDelay"
    content-class="nimbus-tooltip-overlay"
  >
    <span v-html="formattedTooltip(content)"></span>
  </v-tooltip>
</template>

<script setup lang="ts">
defineProps<{
  activator: Element | string;
  content: string;
  position?: string;
  openDelay?: number;
  enabled?: boolean;
}>();

function formattedTooltip(text: string): string {
  return text.replace(/\n/g, "<br>");
}
</script>

<style>
.nimbus-tooltip-overlay {
  z-index: 10001 !important;
}
</style>
