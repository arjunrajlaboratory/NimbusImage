<template>
  <v-tooltip
    v-if="enabled"
    :top="position === 'top'"
    :right="position === 'right'"
    :bottom="position === 'bottom'"
    :left="position === 'left'"
    :activator="activator"
    :open-delay="open_delay"
    content-class="nimbus-tooltip-overlay"
  >
    <span v-html="formattedTooltip(content)"></span>
  </v-tooltip>
</template>

<script lang="ts">
import Vue from "vue";

export default Vue.extend({
  name: "NimbusTooltip",
  props: {
    activator: { required: true },
    content: { type: String, required: true },
    position: { type: String, required: false, default: "bottom" },
    open_delay: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
  },

  methods: {
    formattedTooltip(text: string): string {
      return text.replace(/\n/g, "<br>");
    },
  },
});
</script>

<style>
.nimbus-tooltip-overlay {
  z-index: 10001 !important;
}
</style>
