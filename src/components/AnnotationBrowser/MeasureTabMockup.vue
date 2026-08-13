<template>
  <div class="measure-tab">
    <div class="measure-toolbar">
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
      <span class="text-none px-2 text-success">
        Computations done
        <v-icon size="small" color="success">mdi-check</v-icon>
      </span>
    </div>
    <div class="measure-hint">
      Checked values appear as columns in the Objects tab and can be used in
      filters and plots.
    </div>
    <div class="measure-list">
      <div
        v-for="entry in propertyEntries"
        :key="entry.property.id"
        class="measure-group"
      >
        <div class="group-header" @click="toggleExpanded(entry.property.id)">
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
          <span class="group-count">{{ entry.paths.length }} values</span>
          <v-btn
            size="x-small"
            variant="tonal"
            color="primary"
            class="ml-2"
            @click.stop
          >
            Run
          </v-btn>
        </div>
        <div v-if="expanded.has(entry.property.id)" class="group-body">
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
import { IAnnotationProperty } from "@/store/model";
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

const propertyEntries = computed((): IPropertyEntry[] => {
  const allPaths = propertyStore.computedPropertyPaths;
  const displayed = propertyStore.displayedPropertyPaths;
  return propertyStore.properties
    .map((property) => {
      const paths = allPaths.filter((path) => path[0] === property.id);
      const shownCount = displayed.filter(
        (path) => path[0] === property.id,
      ).length;
      return { property, paths, shownCount };
    })
    .filter((entry) => entry.paths.length > 0);
});

function isShown(path: string[]): boolean {
  return findIndexOfPath(path, propertyStore.displayedPropertyPaths) >= 0;
}

function togglePath(path: string[]) {
  propertyStore.togglePropertyPathVisibility(path);
}

function subName(path: string[]): string {
  return propertyStore.getSubIdsNameFromPath(path) ?? path.slice(1).join(" / ");
}
</script>

<style lang="scss" scoped>
.measure-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.measure-toolbar {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  flex: 0 0 auto;
}

.measure-hint {
  padding: 0 14px 8px;
  font-size: 12px;
  opacity: 0.6;
  flex: 0 0 auto;
}

.measure-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.measure-group {
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
</style>
