<template>
  <v-menu
    open-on-hover
    open-delay="200"
    close-delay="100"
    bottom
    offset-y
    :nudge-width="200"
    content-class="sharing-tooltip-menu"
  >
    <template #activator="{ on, attrs }">
      <v-icon
        v-bind="attrs"
        v-on="on"
        small
        :color="iconColor"
        class="sharing-icon ml-1"
      >
        {{ iconName }}
      </v-icon>
    </template>
    <v-card dense class="pa-2" max-width="300">
      <!-- Loading -->
      <div v-if="loading" class="text-center pa-1">
        <v-progress-circular indeterminate size="16" width="2" />
      </div>

      <!-- Content -->
      <div v-else>
        <!-- Public/Private Badge -->
        <div class="d-flex align-center mb-1">
          <v-icon x-small class="mr-1" :color="isPublic ? 'green' : 'grey'">
            {{ isPublic ? "mdi-earth" : "mdi-lock" }}
          </v-icon>
          <span class="text-caption font-weight-medium">
            {{ isPublic ? "Public" : "Private" }}
          </span>
        </div>

        <!-- User Summary -->
        <div v-if="users && users.length > 0">
          <div class="text-caption grey--text mb-1">
            {{ users.length }}
            {{ users.length === 1 ? "user" : "users" }} with access:
          </div>
          <div
            v-for="user in displayedUsers"
            :key="user.id"
            class="d-flex align-center py-0"
          >
            <span class="text-caption text-truncate" style="max-width: 180px">
              {{ user.name || user.login }}
            </span>
            <v-spacer />
            <v-chip
              x-small
              :color="accessLevelColor(user.level)"
              dark
              class="ml-1"
            >
              {{ accessLevelLabel(user.level) }}
            </v-chip>
          </div>
          <div
            v-if="users.length > maxDisplayUsers"
            class="text-caption grey--text mt-1"
          >
            +{{ users.length - maxDisplayUsers }} more...
          </div>
        </div>
        <div v-else class="text-caption grey--text">No additional users.</div>
      </div>
    </v-card>
  </v-menu>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { IDatasetAccessUser } from "@/store/model";
import { accessLevelLabel, accessLevelColor } from "@/utils/accessLevel";

const props = defineProps<{
  isPublic?: boolean;
  users?: IDatasetAccessUser[];
  loading?: boolean;
}>();

const maxDisplayUsers = 5;

const iconName = computed((): string => {
  if (props.isPublic) return "mdi-earth";
  if (props.users && props.users.length > 1) return "mdi-account-multiple";
  return "mdi-lock";
});

const iconColor = computed((): string => {
  if (props.isPublic) return "green";
  if (props.users && props.users.length > 1) return "blue";
  return "grey";
});

const displayedUsers = computed((): IDatasetAccessUser[] => {
  return (props.users || []).slice(0, maxDisplayUsers);
});

defineExpose({
  maxDisplayUsers,
  iconName,
  iconColor,
  displayedUsers,
  accessLevelLabel,
  accessLevelColor,
});
</script>

<style lang="scss" scoped>
.sharing-icon {
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.2s ease;

  &:hover {
    opacity: 1;
  }
}
</style>

<style lang="scss">
.sharing-tooltip-menu {
  z-index: 10;
}
</style>
