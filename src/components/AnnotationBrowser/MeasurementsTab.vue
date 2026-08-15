<template>
  <div class="measurements-tab">
    <div class="measurements-toolbar">
      <v-btn
        variant="flat"
        color="primary"
        size="small"
        prepend-icon="mdi-plus"
        @click="store.setIsAnalyzeDialogOpen(true)"
      >
        New measurement
      </v-btn>
      <v-spacer />
      <template v-if="properties.length > 0">
        <span
          v-if="uncomputedProperties.length <= 0"
          class="text-none px-2 text-success"
        >
          Computations done
          <v-icon size="small" color="success">mdi-check</v-icon>
        </span>
        <v-btn
          v-else
          variant="text"
          size="small"
          color="primary"
          class="text-none px-2"
          @click="computeUncomputedProperties"
          :disabled="uncomputedRunning > 0"
        >
          {{
            uncomputedRunning > 0
              ? "Running uncomputed properties"
              : "Compute all"
          }}
          <template v-if="uncomputedRunning > 0">
            <v-progress-circular
              indeterminate
              size="16"
              width="2"
              class="ml-1"
            />
          </template>
          <template v-else>
            <v-icon size="small" end>mdi-play-circle-outline</v-icon>
          </template>
        </v-btn>
      </template>
    </div>
    <div class="measurements-hint">
      Checked values appear as columns in the Objects tab and can be used in
      filters and plots.
    </div>
    <div v-if="properties.length === 0" class="measurements-empty">
      No measurements yet. Click "New measurement" to set up a computation
      (area, intensity, worker-based measurements, …).
    </div>
    <div v-else class="measurements-list">
      <div
        v-for="entry in propertyEntries"
        :key="entry.property.id"
        class="measurement-group"
      >
        <div
          class="group-header"
          :class="{ expandable: entry.paths.length > 0 }"
          @click="toggleExpanded(entry.property.id)"
        >
          <v-icon size="16" class="mr-1">
            {{
              expanded.has(entry.property.id)
                ? "mdi-chevron-down"
                : "mdi-chevron-right"
            }}
          </v-icon>
          <span class="group-name">{{ entry.property.name }}</span>
          <v-chip
            v-if="entry.shownCount > 0"
            size="x-small"
            variant="tonal"
            color="primary"
            class="ml-2"
          >
            {{ entry.shownCount }} shown
          </v-chip>
          <v-spacer />
          <span class="group-count">
            {{
              entry.paths.length > 0
                ? `${entry.paths.length} value${
                    entry.paths.length === 1 ? "" : "s"
                  }`
                : "not computed"
            }}
          </span>
          <v-btn
            size="x-small"
            variant="tonal"
            color="primary"
            class="ml-2"
            @click.stop="compute(entry.property)"
          >
            <template v-if="isRunning(entry.property.id)">
              <v-progress-circular indeterminate size="14" width="2" />
            </template>
            <template v-else>Run</template>
          </v-btn>
          <span
            v-if="uncomputedCount(entry.property.id) > 0"
            class="uncomputed-count ml-1"
          >
            {{ uncomputedCount(entry.property.id) }}
          </span>
        </div>
        <div
          v-if="expanded.has(entry.property.id) && entry.paths.length > 0"
          class="group-body"
        >
          <div
            v-for="path in entry.paths"
            :key="path.join('.')"
            class="value-row"
            @click="togglePath(path)"
          >
            <v-checkbox-btn
              :model-value="isShown(path)"
              density="compact"
              class="value-check"
              @click.stop="togglePath(path)"
            />
            <span class="value-name">{{ subName(path) }}</span>
            <v-spacer />
            <v-icon size="14" class="value-eye">
              {{ isShown(path) ? "mdi-eye" : "mdi-eye-off-outline" }}
            </v-icon>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from "vue";
import store from "@/store";
import propertyStore from "@/store/properties";
import { IAnnotationProperty, IErrorInfoList } from "@/store/model";
import { findIndexOfPath } from "@/utils/paths";

interface IPropertyEntry {
  property: IAnnotationProperty;
  paths: string[][];
  shownCount: number;
}

const expanded = reactive(new Set<string>());

function toggleExpanded(id: string) {
  if (expanded.has(id)) {
    expanded.delete(id);
  } else {
    expanded.add(id);
  }
}

const properties = computed(() => propertyStore.properties);

// Every property appears, including ones with no computed values yet — those
// are exactly the ones a user needs to find and Run.
const propertyEntries = computed((): IPropertyEntry[] => {
  const allPaths = propertyStore.computedPropertyPaths;
  const displayed = propertyStore.displayedPropertyPaths;
  return properties.value.map((property) => {
    const paths = allPaths.filter((path) => path[0] === property.id);
    const shownCount = displayed.filter(
      (path) => path[0] === property.id,
    ).length;
    return { property, paths, shownCount };
  });
});

const uncomputedProperties = computed(() => {
  const counts = propertyStore.uncomputedCountByProperty;
  return properties.value.filter((property) => (counts[property.id] ?? 0) > 0);
});

const uncomputedRunning = computed(() => {
  let value = 0;
  for (const property of uncomputedProperties.value) {
    if (propertyStore.propertyStatuses[property.id]?.running) {
      value++;
    }
  }
  return value;
});

function isRunning(propertyId: string): boolean {
  return propertyStore.propertyStatuses[propertyId]?.running ?? false;
}

function uncomputedCount(propertyId: string): number {
  return propertyStore.uncomputedCountByProperty[propertyId] ?? 0;
}

function compute(property: IAnnotationProperty) {
  if (isRunning(property.id)) {
    return;
  }
  const errorInfo: IErrorInfoList = { errors: [] };
  propertyStore.computeProperty({ property, errorInfo });
}

function computeUncomputedProperties() {
  for (const property of uncomputedProperties.value) {
    compute(property);
  }
}

function isShown(path: string[]): boolean {
  return findIndexOfPath(path, propertyStore.displayedPropertyPaths) >= 0;
}

function togglePath(path: string[]) {
  propertyStore.togglePropertyPathVisibility(path);
}

function subName(path: string[]): string {
  return propertyStore.getSubIdsNameFromPath(path) ?? path.slice(1).join(" / ");
}

defineExpose({
  expanded,
  toggleExpanded,
  propertyEntries,
  uncomputedProperties,
  uncomputedRunning,
  compute,
  computeUncomputedProperties,
  isShown,
  togglePath,
  subName,
});
</script>

<style lang="scss" scoped>
.measurements-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.measurements-toolbar {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  flex: 0 0 auto;
}

.measurements-hint {
  padding: 0 14px 8px;
  font-size: 12px;
  opacity: 0.6;
  flex: 0 0 auto;
}

.measurements-empty {
  padding: 16px 14px;
  font-size: 13px;
  opacity: 0.7;
}

.measurements-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.measurement-group {
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  margin-bottom: 6px;
  background: rgba(255, 255, 255, 0.02);
}

.group-header {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  cursor: pointer;
  user-select: none;

  &:hover {
    background: rgba(255, 255, 255, 0.04);
  }
}

.group-name {
  font-size: 13px;
  font-weight: 600;
}

.group-count {
  font-size: 11px;
  opacity: 0.55;
}

.group-body {
  padding: 2px 8px 8px 26px;
}

.value-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;

  &:hover {
    background: rgba(255, 255, 255, 0.05);
  }
}

.value-check {
  flex: 0 0 auto;
}

.value-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.value-eye {
  opacity: 0.5;
}

.uncomputed-count {
  font-size: 11px;
  font-weight: 500;
  color: #ffffff;
  background: rgb(var(--v-theme-error));
  border-radius: 9999px;
  min-width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
}
</style>
