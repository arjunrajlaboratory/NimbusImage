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
        <!-- Indeterminate: show whimsical animation + title -->
        <div v-if="group.indeterminate" class="indeterminate-group">
          <WhimsicalLoader size="md" color="light" />
          <div class="indeterminate-info">
            <strong>{{ group.title }}</strong>
            <template v-if="group.count > 1">
              <span class="remaining-count">({{ group.count }} remaining)</span>
            </template>
          </div>
        </div>
        <!-- Determinate: show progress bar as before -->
        <v-progress-linear
          v-else
          :model-value="group.value"
          color="primary"
          height="16"
        >
          <strong>
            {{ group.title }}
            <template v-if="group.total !== undefined">
              ({{ group.progress }}/{{ group.total }})
            </template>
            <template v-if="group.count > 1">
              ({{ group.count }} remaining)
            </template>
          </strong>
        </v-progress-linear>
      </template>

      <!-- Multiple progresses that need individual display -->
      <template v-else>
        <div class="stacked-progress">
          <template v-for="progress in group.items" :key="progress.id">
            <!-- Indeterminate item in stack -->
            <div v-if="progress.total === 0" class="indeterminate-group indeterminate-group--stacked">
              <WhimsicalLoader size="sm" color="light" />
              <strong class="caption">{{ progress.title }}</strong>
            </div>
            <!-- Determinate item in stack -->
            <v-progress-linear
              v-else
              :model-value="(100 * progress.progress) / progress.total"
              color="primary"
              height="10"
              class="mb-1"
            >
              <strong class="caption">
                {{ progress.title }}
                ({{ progress.progress }}/{{ progress.total }})
              </strong>
            </v-progress-linear>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import WhimsicalLoader from "@/components/WhimsicalLoader.vue";
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
  bottom: 50px;
  left: 20px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 400px;
  max-width: 400px;
}

.progress-group {
  background: rgba(0, 0, 0, 0.7);
  padding: 4px;
  border-radius: 4px;
  color: white;
}

.notifications-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.notification {
  margin-bottom: 0 !important;

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
  gap: 2px;

  :deep(.v-progress-linear) {
    font-size: 0.7rem;
  }
}

:deep(.v-progress-linear) {
  font-size: 0.75rem;
}

.indeterminate-group {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px;
  min-height: 32px;
}

.indeterminate-group--stacked {
  gap: 8px;
  min-height: 24px;
  font-size: 0.7rem;
}

.indeterminate-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.75rem;
}

.remaining-count {
  opacity: 0.7;
  font-size: 0.7rem;
}
</style>
