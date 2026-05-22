<template>
  <div class="settings-panel">
    <annotation-toggles />
    <viewer-settings />
    <ui-settings />
    <jobs-logs />
  </div>
</template>

<script setup lang="ts">
import AnnotationToggles from "@/components/AnnotationBrowser/AnnotationToggles.vue";
import ViewerSettings from "@/components/ViewerSettings.vue";
import UiSettings from "@/components/UISettings.vue";
import JobsLogs from "@/components/JobsLogs.vue";
</script>

<style lang="scss" scoped>
.settings-panel {
  padding: 4px 0;

  /* Section block: header + body, hairline divider between sections. */
  :deep(.settings-section) {
    padding: 4px 14px 14px;
    border-bottom: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.06));

    &:last-child {
      border-bottom: none;
    }
  }

  :deep(.settings-section-title) {
    font-family: var(--nimbus-font);
    font-size: 10.5px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--nimbus-text-muted, #8a8f98);
    margin: 14px 0 10px;
  }

  :deep(.settings-section-body) {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* Indented child group (for sub-toggles that depend on a parent toggle). */
  :deep(.settings-indent) {
    margin-left: 22px;
    padding-left: 10px;
    border-left: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.06));
    display: flex;
    flex-direction: column;
    gap: 2px;

    &.is-disabled {
      opacity: 0.6;
    }
  }

  /* Inline label + control row (e.g., "Scale bar style" + color picker). */
  :deep(.settings-inline) {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 0;
  }
  :deep(.settings-inline-label) {
    font-size: 13px;
    color: var(--nimbus-text-secondary, #d0d6e0);
    flex: 0 0 auto;
  }

  /* Hairline divider within a section. */
  :deep(.settings-divider) {
    margin: 8px 0;
    opacity: 0.6;
  }

  :deep(.settings-slider) {
    padding-top: 4px;
  }

  /* Tighten Vuetify control typography across the panel. */
  :deep(.v-selection-control .v-label),
  :deep(.v-switch .v-label),
  :deep(.v-checkbox .v-label),
  :deep(.v-slider .v-label),
  :deep(.v-field__input),
  :deep(.v-field-label) {
    font-size: 13px !important;
    letter-spacing: 0;
    line-height: 1.4;
  }

  /* Selection controls: tighter row height. */
  :deep(.v-selection-control--density-compact) {
    --v-selection-control-size: 28px;
    min-height: 28px;
  }
  :deep(.v-selection-control__wrapper) {
    margin-right: 4px;
  }

  /* Slider track + thumb sizing. */
  :deep(.v-slider) {
    .v-slider-track {
      --v-slider-track-size: 3px;
    }
  }

  /* Inputs/selects: smaller, less chrome. */
  :deep(.v-input--density-compact) {
    --v-input-control-height: 36px;
  }

  /* Buttons: smaller text. */
  :deep(.v-btn) {
    font-size: 12px;
    letter-spacing: 0.01em;
    text-transform: none;
  }
}
</style>
