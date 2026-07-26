<template>
  <div
    class="progress-container"
    v-if="hasActiveProgresses || hasNotifications"
  >
    <!-- Notifications section -->
    <div v-if="hasNotifications" class="notifications-group">
      <v-alert
        v-for="notification in activeNotifications"
        :key="notification.id"
        :type="notification.type"
        density="compact"
        closable
        class="mb-2 notification"
        @click:close="dismissNotification(notification.id)"
      >
        <div class="notification-content">
          <div class="notification-title">{{ notification.title }}</div>
          <div class="notification-message">{{ notification.message }}</div>
          <div v-if="notification.info" class="notification-info">
            {{ notification.info }}
          </div>
        </div>
      </v-alert>
    </div>

    <!-- Progress bars section -->
    <div
      v-for="group in progressGroups"
      :key="group.type"
      class="progress-group"
    >
      <!-- Single progress or multiple indeterminate with same title -->
      <template v-if="group.display === 'single'">
        <div class="progress-item">
          <div class="progress-label">
            <span class="progress-title">{{ group.title }}</span>
            <span v-if="group.total !== undefined" class="progress-detail">
              {{ group.progress }}/{{ group.total }}
            </span>
            <span v-else-if="group.count > 1" class="progress-detail">
              {{ group.count }} remaining
            </span>
          </div>
          <v-progress-linear
            :indeterminate="group.indeterminate"
            :model-value="group.value"
            height="6"
            rounded-bar
          />
        </div>
      </template>

      <!-- Multiple progresses that need individual display -->
      <template v-else>
        <div class="stacked-progress">
          <div
            v-for="progress in group.items"
            :key="progress.id"
            class="progress-item"
          >
            <div class="progress-label">
              <span class="progress-title">{{ progress.title }}</span>
              <span v-if="progress.total > 0" class="progress-detail">
                {{ progress.progress }}/{{ progress.total }}
              </span>
            </div>
            <v-progress-linear
              :indeterminate="progress.total === 0"
              :model-value="
                progress.total ? (100 * progress.progress) / progress.total : 0
              "
              height="4"
              rounded-bar
            />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import progressStore from "@/store/progress";
import { ProgressType, IProgress, IProgressGroup } from "@/store/model";

const activeProgresses = computed(() => progressStore.activeProgresses);
const activeNotifications = computed(() => progressStore.activeNotifications);
const hasActiveProgresses = computed(() => progressStore.hasActiveProgresses);
const hasNotifications = computed(() => activeNotifications.value.length > 0);

function dismissNotification(id: string) {
  progressStore.dismissNotification(id);
}

const progressGroups = computed<IProgressGroup[]>(() => {
  const groupedByType = new Map<ProgressType, IProgress[]>();

  for (const progress of activeProgresses.value) {
    if (!groupedByType.has(progress.type)) {
      groupedByType.set(progress.type, []);
    }
    groupedByType.get(progress.type)!.push(progress);
  }

  return Array.from(groupedByType.entries()).map(([type, items]) => {
    if (items.length === 1) {
      const progress = items[0];
      const isIndeterminate = progress.total === 0;
      return {
        type,
        display: "single",
        title: progress.title,
        indeterminate: isIndeterminate,
        ...(isIndeterminate
          ? {}
          : {
              progress: progress.progress,
              total: progress.total,
              value: (100 * progress.progress) / progress.total,
            }),
        count: 1,
        items,
      };
    }

    const allIndeterminate = items.every((p) => p.total === 0);
    const allSameTitle = items.every((p) => p.title === items[0].title);

    if (allIndeterminate && allSameTitle) {
      return {
        type,
        display: "single",
        title: items[0].title,
        indeterminate: true,
        count: items.length,
        items,
      };
    }

    return {
      type,
      display: "stacked",
      title: "",
      indeterminate: false,
      count: items.length,
      items,
    };
  });
});

defineExpose({ hasNotifications, dismissNotification, progressGroups });
</script>

<style lang="scss" scoped>
.progress-container {
  position: absolute;
  // Sit just above the bottom-left button cluster (palette / lock / fit-to-window
  // at bottom:10px in ImageViewer) and align to its left edge, so progress bars
  // and notifications never land on top of the left palette stack (Tools panel).
  bottom: 56px;
  left: 10px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 400px;
  max-width: 400px;
  // Animate the palette-driven shift via transform (GPU-composited, doesn't
  // trigger layout) rather than `left`.
  transition: transform 0.2s ease;
}

/* When the whole left palette stack is open it reaches the bottom-left corner
   and would cover this stack; slide it right of the column, mirroring the
   bottom-left button cluster (same 10 px gap to the palette's right edge via
   `--nimbus-left-palette-clear-x`). `.left-palettes-open` is set on `<v-app>`
   by App.vue (an ancestor); scoped CSS adds the data-v attribute to the last
   compound selector only, so the ancestor class still matches. */
.left-palettes-open .progress-container {
  transform: translateX(calc(var(--nimbus-left-palette-clear-x) - 10px));
}

.progress-group {
  background: rgba(var(--v-theme-surface), 0.85);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.1);
  padding: 10px 14px;
  border-radius: 10px;
  color: rgb(var(--v-theme-on-surface));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}

.progress-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.progress-label {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  font-size: 0.8rem;
  line-height: 1.2;
}

.progress-title {
  font-weight: 500;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress-detail {
  color: rgb(var(--v-theme-on-surface-variant));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.notifications-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.notification {
  margin-bottom: 0;

  :deep(.v-alert__content) {
    display: flex;
    flex: 1;
  }
}

.notification-content {
  width: 100%;
}

.notification-title {
  font-weight: bold;
}

.notification-message {
  margin-top: 2px;
}

.notification-info {
  font-size: 0.85rem;
  margin-top: 2px;
  opacity: 0.85;
}

.stacked-progress {
  display: flex;
  flex-direction: column;
  gap: 10px;

  .progress-label {
    font-size: 0.75rem;
  }
}
</style>
