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
defineProps({
  activator: { required: true },
  content: { type: String, required: true },
  position: { type: String, default: "bottom" },
  openDelay: { type: Number, default: 0 },
  enabled: { type: Boolean, default: true },
});

function formattedTooltip(text: string): string {
  return text.replace(/\n/g, "<br>");
}
</script>

<style>
.nimbus-tooltip-overlay {
  z-index: 10001 !important;
}
</style>
