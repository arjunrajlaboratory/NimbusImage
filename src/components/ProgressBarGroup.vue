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
        dense
        dismissible
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
        <v-progress-linear
          :indeterminate="group.indeterminate"
          :value="group.value"
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
          <v-progress-linear
            v-for="progress in group.items"
            :key="progress.id"
            :indeterminate="progress.total === 0"
            :value="
              progress.total ? (100 * progress.progress) / progress.total : 0
            "
            color="primary"
            height="10"
            class="mb-1"
          >
            <strong class="caption">
              {{ progress.title }}
              <template v-if="progress.total > 0">
                ({{ progress.progress }}/{{ progress.total }})
              </template>
            </strong>
          </v-progress-linear>
        </div>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import { Vue, Component } from "vue-property-decorator";
import progressStore from "@/store/progress";
import { ProgressType, IProgress, IProgressGroup } from "@/store/model";

@Component({})
export default class ProgressBarGroup extends Vue {
  readonly progressStore = progressStore;

  get activeProgresses() {
    return this.progressStore.activeProgresses;
  }

  get activeNotifications() {
    return this.progressStore.activeNotifications;
  }

  get hasActiveProgresses() {
    return this.progressStore.hasActiveProgresses;
  }

  get hasNotifications() {
    return this.activeNotifications.length > 0;
  }

  dismissNotification(id: string) {
    this.progressStore.dismissNotification(id);
  }

  get progressGroups(): IProgressGroup[] {
    // Group progresses by type
    const groupedByType = new Map<ProgressType, IProgress[]>();

    for (const progress of this.activeProgresses) {
      if (!groupedByType.has(progress.type)) {
        groupedByType.set(progress.type, []);
      }
      groupedByType.get(progress.type)!.push(progress);
    }

    return Array.from(groupedByType.entries()).map(([type, items]) => {
      // Single progress case
      if (items.length === 1) {
        const progress = items[0];
        const isIndeterminate = progress.total === 0;
        return {
          type,
          display: "single",
          title: progress.title,
          indeterminate: isIndeterminate,
          // Only set total and progress if we actually have a total.
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

      // Check if all items are indeterminate and have the same title
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

      // Multiple different progresses case
      return {
        type,
        display: "stacked",
        title: "", // Not used in stacked display
        indeterminate: false,
        count: items.length,
        items,
      };
    });
  }
}
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
</style>
