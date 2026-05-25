<template>
  <div class="filters-panel">
    <annotation-filters />
  </div>
</template>

<script setup lang="ts">
import AnnotationFilters from "@/components/AnnotationBrowser/AnnotationFilters.vue";
</script>

<style lang="scss" scoped>
.filters-panel {
  padding: 4px 0;

  /* Mirrors the section styling from SettingsPanel.vue so the two
     palettes feel like one design language. */
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
    gap: 8px;
  }
}
</style>
