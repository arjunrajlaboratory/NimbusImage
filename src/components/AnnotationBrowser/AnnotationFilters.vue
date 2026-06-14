<template>
  <div class="annotation-filters">
    <section class="settings-section">
      <h4 class="settings-section-title">Tags</h4>
      <div class="settings-section-body">
        <tag-filter-editor v-model="tagFilter" />
      </div>
    </section>

    <section class="settings-section advanced-section">
      <button
        type="button"
        class="advanced-toggle"
        :aria-expanded="propertyValuesOpen"
        @click="propertyValuesOpen = !propertyValuesOpen"
      >
        <v-icon size="14" class="advanced-chevron">
          {{ propertyValuesOpen ? "mdi-chevron-down" : "mdi-chevron-right" }}
        </v-icon>
        Property values
        <v-chip
          v-if="propertyPaths.length > 0"
          size="x-small"
          variant="flat"
          color="primary"
          class="ml-2"
        >
          {{ propertyPaths.length }}
        </v-chip>
      </button>
      <v-expand-transition>
        <div v-show="propertyValuesOpen" class="advanced-body">
          <div class="settings-section-body">
            <property-picker mode="filter">
              <template v-slot:activator="{ props: pickerProps }">
                <v-btn
                  v-bind="pickerProps"
                  variant="outlined"
                  color="primary"
                  size="small"
                  prepend-icon="mdi-plus"
                >
                  Add property filter
                </v-btn>
              </template>
            </property-picker>
            <property-filter-histogram
              v-for="(propertyPath, idx) in propertyPaths"
              :key="'property ' + idx"
              :propertyPath="propertyPath"
            />
          </div>
        </div>
      </v-expand-transition>
    </section>

    <section class="settings-section advanced-section">
      <button
        type="button"
        class="advanced-toggle"
        :aria-expanded="advancedOpen"
        @click="advancedOpen = !advancedOpen"
      >
        <v-icon size="14" class="advanced-chevron">
          {{ advancedOpen ? "mdi-chevron-down" : "mdi-chevron-right" }}
        </v-icon>
        Advanced
      </button>
      <v-expand-transition>
        <div v-show="advancedOpen" class="advanced-body">
          <div class="advanced-group">
            <h5 class="advanced-group-title">Scope</h5>
            <div class="settings-section-body">
              <v-switch
                v-model="onlyCurrentFrame"
                label="Current frame only"
                density="compact"
                hide-details
              />
              <v-switch
                v-model="showAnnotationsFromHiddenLayers"
                label="Show objects from hidden layers"
                density="compact"
                hide-details
              />
            </div>
          </div>
          <div class="advanced-group">
            <h5 class="advanced-group-title">Object ID &amp; region</h5>
            <div class="settings-section-body">
              <annotation-id-filters />
              <roi-filters />
            </div>
          </div>
          <div class="advanced-group">
            <h5 class="advanced-group-title">Selection</h5>
            <div class="settings-section-body">
              <v-btn
                v-if="selectionFilterEnabled"
                variant="outlined"
                color="primary"
                size="small"
                @click="clearSelection"
              >
                Clear selection filter
              </v-btn>
              <v-btn
                v-else
                variant="outlined"
                color="primary"
                size="small"
                @click="filterBySelection"
              >
                Use selection as filter
              </v-btn>
            </div>
          </div>
        </div>
      </v-expand-transition>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import filterStore from "@/store/filters";
import store from "@/store";
import { ITagAnnotationFilter } from "@/store/model";
import TagFilterEditor from "@/components/AnnotationBrowser/TagFilterEditor.vue";
import PropertyFilterHistogram from "@/components/AnnotationBrowser/AnnotationProperties/PropertyFilterHistogram.vue";
import RoiFilters from "@/components/AnnotationBrowser/ROIFilters.vue";
import AnnotationIdFilters from "@/components/AnnotationBrowser/AnnotationIdFilters.vue";
import PropertyPicker from "@/components/PropertyPicker.vue";

defineProps<{
  additionalTags?: string[];
}>();

const advancedOpen = ref(false);
const propertyValuesOpen = ref(filterStore.filterPaths.length > 0);

const selectionFilterEnabled = computed(
  () => filterStore.selectionFilter.enabled,
);

function clearSelection() {
  filterStore.clearSelection();
}

function filterBySelection() {
  filterStore.addSelectionAsFilter();
}

const tagFilter = computed({
  get() {
    return filterStore.tagFilter;
  },
  set(filter: ITagAnnotationFilter) {
    filterStore.setTagFilter(filter);
  },
});

const onlyCurrentFrame = computed({
  get() {
    return filterStore.onlyCurrentFrame;
  },
  set(value: boolean) {
    filterStore.setOnlyCurrentFrame(value);
  },
});

const propertyPaths = computed(() => filterStore.filterPaths);

const showAnnotationsFromHiddenLayers = computed({
  get() {
    return store.showAnnotationsFromHiddenLayers;
  },
  set(value: boolean) {
    store.setShowAnnotationsFromHiddenLayers(value);
  },
});

defineExpose({
  advancedOpen,
  propertyValuesOpen,
  tagFilter,
  onlyCurrentFrame,
  propertyPaths,
  showAnnotationsFromHiddenLayers,
  selectionFilterEnabled,
  clearSelection,
  filterBySelection,
});
</script>

<style lang="scss" scoped>
.advanced-section {
  /* The disclosure section omits the standard padding so the toggle
     button itself anchors the row. */
  padding: 4px 14px 14px;
}

.advanced-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 0;
  font-family: var(--nimbus-font);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--nimbus-text-muted, #8a8f98);
  background: transparent;
  border: none;
  cursor: pointer;

  &:hover {
    color: var(--nimbus-text-secondary, #d0d6e0);
  }
}

.advanced-chevron {
  transition: transform 0.15s ease;
}

.advanced-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 6px;
}

.advanced-group-title {
  font-family: var(--nimbus-font);
  font-size: 11px;
  font-weight: 500;
  color: var(--nimbus-text-secondary, #d0d6e0);
  margin: 0 0 6px;
}
</style>
