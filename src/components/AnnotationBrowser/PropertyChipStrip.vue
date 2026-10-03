<template>
  <div class="property-chip-strip">
    <div class="strip-header">
      <span class="strip-label">
        <v-icon size="14" class="mr-1">mdi-ruler-square</v-icon>
        Measurements
      </span>
      <!-- Pinned outside the scroll area so it stays visible no matter how
           many measurements a dataset has. -->
      <v-chip
        size="small"
        variant="outlined"
        class="chip-new chip-accent-primary"
        @click="store.setIsAnalyzeDialogOpen(true)"
      >
        <v-icon size="14" start>mdi-plus</v-icon>
        New measurement…
      </v-chip>
      <v-spacer />
      <v-text-field
        v-if="propertyEntries.length > 0"
        v-model="filterText"
        placeholder="Filter"
        prepend-inner-icon="mdi-magnify"
        density="compact"
        variant="outlined"
        hide-details
        single-line
        clearable
        class="strip-filter"
      />
    </div>
    <!-- Capped height + scroll: datasets can have a LOT of measurements and
         the strip must never take over the Objects tab. -->
    <div v-if="propertyEntries.length > 0" class="strip-chips">
      <template v-for="entry in filteredEntries" :key="entry.property.id">
        <!-- Single-value property: chip toggles the column directly -->
        <v-chip
          v-if="entry.paths.length === 1"
          size="small"
          :variant="entry.shownCount > 0 ? 'flat' : 'outlined'"
          :color="entry.shownCount > 0 ? 'primary' : undefined"
          :class="{ 'chip-off': entry.shownCount === 0 }"
          :disabled="!isShown(entry.paths[0]) && columnLimitReached"
          :aria-label="columnActionLabel(entry.paths[0])"
          @click="togglePath(entry.paths[0])"
        >
          <v-icon size="14" start>
            {{ entry.shownCount > 0 ? "mdi-eye" : "mdi-eye-off-outline" }}
          </v-icon>
          {{ entry.property.name }}
        </v-chip>
        <!-- Multi-value property: chip opens a small per-value checklist -->
        <v-menu v-else :close-on-content-click="false">
          <template v-slot:activator="{ props: menuProps }">
            <v-chip
              v-bind="menuProps"
              size="small"
              :variant="entry.shownCount > 0 ? 'flat' : 'outlined'"
              :color="entry.shownCount > 0 ? 'primary' : undefined"
              :class="{ 'chip-off': entry.shownCount === 0 }"
            >
              <v-icon size="14" start>
                {{ entry.shownCount > 0 ? "mdi-eye" : "mdi-eye-off-outline" }}
              </v-icon>
              {{ entry.property.name }}
              <span class="chip-count">
                {{ entry.shownCount }}/{{ entry.paths.length }}
              </span>
              <v-icon size="14" end>mdi-chevron-down</v-icon>
            </v-chip>
          </template>
          <v-card min-width="260" class="pa-2">
            <div class="menu-header">
              <span class="menu-title">{{ entry.property.name }}</span>
              <v-spacer />
              <v-btn
                variant="text"
                size="x-small"
                @click="showAll(entry)"
                :disabled="
                  entry.shownCount === entry.paths.length || columnLimitReached
                "
              >
                Show all
              </v-btn>
              <v-btn
                variant="text"
                size="x-small"
                @click="hideAll(entry)"
                :disabled="entry.shownCount === 0"
              >
                Hide all
              </v-btn>
            </div>
            <div
              v-if="columnLimitReached && entry.shownCount < entry.paths.length"
              class="path-limit"
            >
              {{ MAX_DISPLAYED_PROPERTY_PATHS }}-column limit reached. Hide a
              column to show another value.
            </div>
            <v-divider class="my-1" />
            <v-virtual-scroll
              :items="menuPaths(entry)"
              :height="Math.min(entry.paths.length * 36, 280)"
              item-height="36"
              class="path-list"
            >
              <template #default="{ item: path }">
                <v-list-item
                  :key="path.join('.')"
                  class="path-item"
                  :disabled="!isShown(path) && columnLimitReached"
                  @click="togglePath(path)"
                >
                  <template #prepend>
                    <v-checkbox-btn
                      :model-value="isShown(path)"
                      density="compact"
                      :disabled="!isShown(path) && columnLimitReached"
                      :aria-label="columnActionLabel(path)"
                      @click.stop="togglePath(path)"
                    />
                  </template>
                  <v-list-item-title class="path-title">
                    {{ subName(path) }}
                  </v-list-item-title>
                </v-list-item>
              </template>
            </v-virtual-scroll>
          </v-card>
        </v-menu>
      </template>
      <span v-if="filteredEntries.length === 0" class="strip-empty">
        No measurements match "{{ filterText }}"
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import store from "@/store";
import propertyStore from "@/store/properties";
import {
  IPropertyEntry,
  usePropertyEntries,
  isPathShown,
  togglePathVisibility,
  setPathsVisibility,
  propertyValueName,
  propertyColumnActionLabel,
} from "@/utils/propertyEntries";
import { MAX_DISPLAYED_PROPERTY_PATHS } from "@/store/constants";

const filterText = ref<string | null>(null);

const propertyEntries = usePropertyEntries({ includeUncomputed: false });

const query = computed(() => filterText.value?.trim().toLowerCase() ?? "");
const columnLimitReached = computed(
  () =>
    propertyStore.displayedPropertyPaths.length >= MAX_DISPLAYED_PROPERTY_PATHS,
);

// A property matches when its name or any of its value names contains the
// query, so e.g. a gene name finds the property that computed it.
const filteredEntries = computed((): IPropertyEntry[] => {
  if (!query.value) {
    return propertyEntries.value;
  }
  return propertyEntries.value.filter(
    (entry) =>
      entry.property.name.toLowerCase().includes(query.value) ||
      entry.paths.some((path) =>
        subName(path).toLowerCase().includes(query.value),
      ),
  );
});

// Inside a chip whose property name doesn't itself match, narrow the value
// checklist to the values that do — typing "TCF7" should surface that value
// directly rather than the full list.
function menuPaths(entry: IPropertyEntry): string[][] {
  if (!query.value || entry.property.name.toLowerCase().includes(query.value)) {
    return entry.paths;
  }
  return entry.paths.filter((path) =>
    subName(path).toLowerCase().includes(query.value),
  );
}

const isShown = isPathShown;
const togglePath = togglePathVisibility;
const subName = propertyValueName;
const columnActionLabel = propertyColumnActionLabel;

function showAll(entry: IPropertyEntry) {
  setPathsVisibility(entry.paths, true);
}

function hideAll(entry: IPropertyEntry) {
  setPathsVisibility(entry.paths, false);
}

defineExpose({
  filterText,
  propertyEntries,
  filteredEntries,
  menuPaths,
  isShown,
  togglePath,
  showAll,
  hideAll,
  subName,
  columnLimitReached,
  columnActionLabel,
});
</script>

<style lang="scss" scoped>
.property-chip-strip {
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  margin-bottom: 8px;
}

.strip-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.strip-label {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.6;
  margin-right: 4px;
  flex: 0 0 auto;
}

.strip-filter {
  flex: 0 1 170px;
  min-width: 90px;

  :deep(.v-field__input) {
    min-height: 26px;
    padding-top: 2px;
    padding-bottom: 2px;
    font-size: 12px;
  }

  :deep(.v-field__prepend-inner .v-icon),
  :deep(.v-field__clearable .v-icon) {
    font-size: 14px;
  }
}

.strip-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  /* Roughly three chip rows — beyond that the strip scrolls instead of
     growing, so many-measurement datasets keep their object list. */
  max-height: 96px;
  overflow-y: auto;
}

.strip-empty {
  font-size: 12px;
  opacity: 0.6;
  padding: 2px 4px;
}

.chip-off {
  opacity: 0.55;
}

.chip-count {
  margin-left: 6px;
  font-size: 10px;
  opacity: 0.75;
}

.chip-new {
  /* Dashed border and primary tinge come from .chip-accent-primary in
     style.scss (scoped rules can't outrank the global chip overrides). */
  flex: 0 0 auto;
}

.menu-header {
  display: flex;
  align-items: center;
  padding: 2px 6px;
}

.menu-title {
  font-size: 12px;
  font-weight: 600;
}

.path-list {
  max-height: 280px;
}

.path-limit {
  padding: 2px 6px 4px;
  color: rgb(var(--v-theme-warning));
  font-size: 11px;
}

.path-title {
  font-size: 13px;
}
</style>
