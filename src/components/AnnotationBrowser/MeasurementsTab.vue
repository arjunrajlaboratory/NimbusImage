<template>
  <!-- The window item stays mounted once opened (hidden with v-show), so all
       content is gated on isActive: a hidden tab must not re-render — and so
       re-evaluate uncomputedCountByProperty — on every annotation change. -->
  <div v-if="isActive" class="measurements-tab">
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
      <compute-all-status v-if="properties.length > 0" />
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
          @click="entry.paths.length > 0 && toggleExpanded(entry.property.id)"
        >
          <!-- Invisible placeholder keeps names aligned when a group has no
               values to expand. -->
          <v-icon
            size="16"
            class="mr-1"
            :class="{ 'chevron-hidden': entry.paths.length === 0 }"
          >
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
        <!-- A failed Run must be visible here, not only in the Measure
             dialog: computeProperty fills the errorInfo we registered on the
             property's status. -->
        <v-alert
          v-for="(error, index) in errorsFor(entry.property.id)"
          :key="`error-${index}`"
          type="error"
          density="compact"
          class="group-alert"
        >
          {{ error.title }}: {{ error.error }}
        </v-alert>
        <v-alert
          v-for="(warning, index) in warningsFor(entry.property.id)"
          :key="`warning-${index}`"
          type="warning"
          density="compact"
          class="group-alert"
        >
          {{ warning.title }}: {{ warning.warning }}
        </v-alert>
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
import ComputeAllStatus from "@/components/AnnotationBrowser/AnnotationProperties/ComputeAllStatus.vue";
import { IAnnotationProperty, MessageType } from "@/store/model";
import {
  usePropertyEntries,
  isPathShown,
  togglePathVisibility,
  propertyValueName,
} from "@/utils/propertyEntries";
import { computePropertyWithStatus } from "@/utils/propertyCompute";

defineProps<{
  isActive: boolean;
}>();

// Survives tab switches: the component stays mounted, only the template is
// gated on isActive.
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
const propertyEntries = usePropertyEntries({ includeUncomputed: true });

function isRunning(propertyId: string): boolean {
  return propertyStore.propertyStatuses[propertyId]?.running ?? false;
}

function uncomputedCount(propertyId: string): number {
  return propertyStore.uncomputedCountByProperty[propertyId] ?? 0;
}

function compute(property: IAnnotationProperty) {
  // Registers errorInfo on the property's status so errorsFor/warningsFor
  // can render failures in this tab; no-ops while already running.
  computePropertyWithStatus(property);
}

function errorsFor(propertyId: string) {
  return (
    propertyStore.propertyStatuses[propertyId]?.errorInfo?.errors.filter(
      (error) => error.error && error.type === MessageType.ERROR,
    ) ?? []
  );
}

function warningsFor(propertyId: string) {
  return (
    propertyStore.propertyStatuses[propertyId]?.errorInfo?.errors.filter(
      (error) => error.warning && error.type === MessageType.WARNING,
    ) ?? []
  );
}

const isShown = isPathShown;
const togglePath = togglePathVisibility;
const subName = propertyValueName;

defineExpose({
  expanded,
  toggleExpanded,
  propertyEntries,
  compute,
  errorsFor,
  warningsFor,
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

.chevron-hidden {
  opacity: 0;
}

.group-alert {
  margin: 0 10px 8px;
  font-size: 12px;
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
