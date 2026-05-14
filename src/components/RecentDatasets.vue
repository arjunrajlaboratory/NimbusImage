<template>
  <div class="recent-datasets-container">
    <v-list class="recent-list scrollable py-0" :lines="false">
      <div
        v-for="(d, index) in datasetViewItems"
        :key="d.datasetView.id"
        class="recent-item-wrapper"
      >
        <div v-if="index > 0" class="recent-divider" aria-hidden="true" />
        <v-tooltip
          location="top"
          :disabled="!d.datasetInfo.description && !d.configInfo.description"
        >
          <template #activator="{ props: activatorProps }">
            <button
              type="button"
              class="recent-item"
              v-bind="activatorProps"
              :title="formatDateNumber(d.datasetView.lastViewed)"
              @click="handleDatasetClick(d.datasetView.id)"
            >
              <span class="recent-item__name">
                {{
                  d.datasetInfo.name ? d.datasetInfo.name : "Unnamed dataset"
                }}
              </span>
              <span class="recent-item__date">
                {{ formatDayShort(d.datasetView.lastViewed) }}
              </span>
              <span class="recent-item__meta">
                <span class="recent-item__config">
                  {{
                    d.configInfo.name
                      ? d.configInfo.name
                      : "Unnamed configuration"
                  }}
                </span>
                <template v-if="d.datasetInfo.creatorId">
                  <span class="recent-item__sep" aria-hidden="true">·</span>
                  <span class="recent-item__owner">
                    <v-icon
                      size="13"
                      class="recent-item__owner-icon"
                      aria-hidden="true"
                    >
                      mdi-account-outline
                    </v-icon>
                    {{ getUserShortName(d.datasetInfo.creatorId) }}
                  </span>
                </template>
              </span>
              <span class="recent-item__time">
                {{ formatTimeOfDay(d.datasetView.lastViewed) }}
              </span>
              <v-icon size="16" class="recent-item__chevron" aria-hidden="true">
                mdi-chevron-right
              </v-icon>
            </button>
          </template>
          <div v-if="d.datasetInfo.description">
            {{ d.datasetInfo.description }}
          </div>
          <v-divider
            v-if="d.datasetInfo.description && d.configInfo.description"
          />
          <div v-if="d.configInfo.description">
            {{ d.configInfo.description }}
          </div>
        </v-tooltip>
      </div>
    </v-list>
  </div>
</template>

<script setup lang="ts">
import { IRecentDatasetViewItem } from "@/store/model";
import { formatDayShort, formatTimeOfDay } from "@/utils/date";

defineProps<{
  datasetViewItems: IRecentDatasetViewItem[];
  getUserDisplayName: (creatorId: string) => string;
  getUserShortName: (creatorId: string) => string;
  formatDateNumber: (date: number) => string;
}>();

const emit = defineEmits<{
  (e: "dataset-clicked", datasetViewId: string): void;
}>();

function handleDatasetClick(datasetViewId: string) {
  emit("dataset-clicked", datasetViewId);
}
</script>

<style scoped lang="scss">
.recent-datasets-container {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.scrollable {
  overflow-y: auto;
  flex-grow: 1;
  min-height: 0;
}

.recent-list {
  background: transparent;
}

.recent-divider {
  height: 1px;
  margin: 0 12px;
  background: rgb(var(--v-theme-on-surface) / 0.06);
}

.recent-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  grid-template-rows: auto auto;
  column-gap: 12px;
  row-gap: 2px;
  align-items: baseline;
  width: 100%;
  padding: 10px 14px 10px 16px;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  position: relative;
  color: inherit;
  font: inherit;
  transition:
    background-color 120ms ease,
    padding-left 120ms ease;

  &::before {
    content: "";
    position: absolute;
    left: 0;
    top: 6px;
    bottom: 6px;
    width: 2px;
    border-radius: 2px;
    background: rgb(var(--v-theme-primary));
    opacity: 0;
    transform: scaleY(0.4);
    transform-origin: center;
    transition:
      opacity 140ms ease,
      transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  &:hover,
  &:focus-visible {
    background: rgb(var(--v-theme-on-surface) / 0.045);
    padding-left: 18px;
    outline: none;

    &::before {
      opacity: 1;
      transform: scaleY(1);
    }

    .recent-item__chevron {
      opacity: 0.7;
      transform: translateX(0);
    }
  }

  &:active {
    background: rgb(var(--v-theme-on-surface) / 0.07);
  }
}

.recent-item__name {
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.9375rem;
  font-weight: 600;
  letter-spacing: -0.005em;
  color: rgb(var(--v-theme-on-surface));
  line-height: 1.35;
}

.recent-item__date {
  grid-column: 2;
  grid-row: 1;
  justify-self: end;
  font-size: 0.75rem;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: rgb(var(--v-theme-on-surface-variant));
  line-height: 1.35;
  white-space: nowrap;
}

.recent-item__meta {
  grid-column: 1;
  grid-row: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.recent-item__time {
  grid-column: 2;
  grid-row: 2;
  justify-self: end;
  font-size: 0.75rem;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  color: rgb(var(--v-theme-on-surface-variant) / 0.75);
  line-height: 1.4;
  white-space: nowrap;
}

.recent-item__config {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8125rem;
  font-weight: 400;
  color: rgb(var(--v-theme-on-surface-variant));
  line-height: 1.4;
}

.recent-item__sep {
  flex: 0 0 auto;
  color: rgb(var(--v-theme-on-surface-variant) / 0.6);
  user-select: none;
}

.recent-item__owner {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8125rem;
  font-weight: 400;
  color: rgb(var(--v-theme-on-surface-variant));
  white-space: nowrap;
}

.recent-item__owner-icon {
  opacity: 0.7;
}

.recent-item__chevron {
  grid-column: 3;
  grid-row: 1 / -1;
  align-self: center;
  margin-left: 4px;
  color: rgb(var(--v-theme-on-surface-variant));
  opacity: 0;
  transform: translateX(-4px);
  transition:
    opacity 140ms ease,
    transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
</style>
