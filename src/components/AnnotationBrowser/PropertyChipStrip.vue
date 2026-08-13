<template>
  <div class="property-chip-strip">
    <span class="strip-label">
      <v-icon size="14" class="mr-1">mdi-ruler-square</v-icon>
      Measurements
    </span>
    <template v-for="entry in propertyEntries" :key="entry.property.id">
      <!-- Single-value property: chip toggles the column directly -->
      <v-chip
        v-if="entry.paths.length === 1"
        size="small"
        :variant="entry.shownCount > 0 ? 'flat' : 'outlined'"
        :color="entry.shownCount > 0 ? 'primary' : undefined"
        :class="{ 'chip-off': entry.shownCount === 0 }"
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
              :disabled="entry.shownCount === entry.paths.length"
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
          <v-divider class="my-1" />
          <v-list density="compact" class="path-list">
            <v-list-item
              v-for="path in entry.paths"
              :key="path.join('.')"
              class="path-item"
              @click="togglePath(path)"
            >
              <template #prepend>
                <v-checkbox-btn
                  :model-value="isShown(path)"
                  density="compact"
                  @click.stop="togglePath(path)"
                />
              </template>
              <v-list-item-title class="path-title">
                {{ subName(path) }}
              </v-list-item-title>
            </v-list-item>
          </v-list>
        </v-card>
      </v-menu>
    </template>
    <v-chip
      size="small"
      variant="outlined"
      class="chip-new"
      @click="store.setIsAnalyzeDialogOpen(true)"
    >
      <v-icon size="14" start>mdi-plus</v-icon>
      New measurement…
    </v-chip>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import store from "@/store";
import propertyStore from "@/store/properties";
import { IAnnotationProperty } from "@/store/model";
import { findIndexOfPath } from "@/utils/paths";

interface IPropertyEntry {
  property: IAnnotationProperty;
  paths: string[][];
  shownCount: number;
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

function showAll(entry: IPropertyEntry) {
  for (const path of entry.paths) {
    if (!isShown(path)) {
      propertyStore.togglePropertyPathVisibility(path);
    }
  }
}

function hideAll(entry: IPropertyEntry) {
  for (const path of entry.paths) {
    if (isShown(path)) {
      propertyStore.togglePropertyPathVisibility(path);
    }
  }
}

function subName(path: string[]): string {
  return propertyStore.getSubIdsNameFromPath(path) ?? path.slice(1).join(" / ");
}
</script>

<style lang="scss" scoped>
.property-chip-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  margin-bottom: 8px;
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
  border-style: dashed;
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
  overflow-y: auto;
}

.path-title {
  font-size: 13px;
}
</style>
