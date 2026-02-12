<template>
  <v-card class="mb-4" outlined>
    <v-card-title class="subtitle-1 py-2">
      <v-icon left small>mdi-share-variant</v-icon>
      Sharing
    </v-card-title>
    <v-card-text>
      <!-- Loading State -->
      <div v-if="loading" class="text-center py-2">
        <v-progress-circular
          indeterminate
          size="20"
          width="2"
          color="primary"
        />
        <span class="ml-2 text-body-2 grey--text">Loading sharing info...</span>
      </div>

      <!-- Error / Unavailable State -->
      <div v-else-if="!accessUsers" class="text-body-2 grey--text">
        Sharing info unavailable.
      </div>

      <!-- Access Info -->
      <div v-else>
        <!-- Public Status -->
        <div class="d-flex align-center mb-2">
          <v-chip
            small
            :color="isPublic ? 'green' : 'grey'"
            :text-color="isPublic ? 'white' : 'white'"
            class="mr-2"
          >
            <v-icon left small>
              {{ isPublic ? "mdi-earth" : "mdi-lock" }}
            </v-icon>
            {{ isPublic ? "Public" : "Private" }}
          </v-chip>
          <span v-if="isPublic" class="text-caption grey--text">
            Read-only access for everyone
          </span>
        </div>

        <!-- User Access List -->
        <div v-if="accessUsers.length > 0" class="mt-2">
          <div class="text-caption grey--text mb-1">
            {{ accessUsers.length }}
            {{ accessUsers.length === 1 ? "user" : "users" }} with access:
          </div>
          <v-simple-table dense class="sharing-table">
            <template #default>
              <tbody>
                <tr v-for="user in accessUsers" :key="user.id">
                  <td class="text-body-2 py-1">
                    {{ user.name || user.login }}
                    <span
                      v-if="user.email && user.email !== user.login"
                      class="text-caption grey--text ml-1"
                    >
                      ({{ user.email }})
                    </span>
                  </td>
                  <td class="text-body-2 py-1" style="width: 100px">
                    <v-chip x-small :color="accessLevelColor(user.level)" dark>
                      {{ accessLevelLabel(user.level) }}
                    </v-chip>
                  </td>
                </tr>
              </tbody>
            </template>
          </v-simple-table>
        </div>
        <div v-else class="text-body-2 grey--text mt-1">
          No users have been granted access.
        </div>
      </div>
    </v-card-text>
  </v-card>
</template>

<script lang="ts">
import { Vue, Component, Prop } from "vue-property-decorator";
import { IDatasetAccessUser } from "@/store/model";
import { accessLevelLabel, accessLevelColor } from "@/utils/accessLevel";

@Component
export default class SharingStatusDisplay extends Vue {
  @Prop({ default: false }) readonly loading!: boolean;
  @Prop({ default: false }) readonly isPublic!: boolean;
  @Prop({ default: null }) readonly accessUsers!: IDatasetAccessUser[] | null;

  accessLevelLabel = accessLevelLabel;
  accessLevelColor = accessLevelColor;
}
</script>

<style lang="scss" scoped>
.sharing-table {
  background: transparent !important;

  td {
    border-bottom: none !important;
  }
}
</style>
