<template>
  <div class="recent-projects-container">
    <v-progress-linear v-if="loading" indeterminate />

    <div v-else-if="projects.length === 0" class="empty-state pa-4 text-center">
      <v-icon size="48" color="grey">mdi-folder-star-outline</v-icon>
      <div class="text-body-2 grey--text mt-2">
        No projects yet. Create one to organize datasets for export.
      </div>
    </div>

    <v-list v-else two-line class="scrollable py-0">
      <div v-for="project in projects" :key="project.id">
        <v-tooltip top :disabled="!project.description">
          <template v-slot:activator="{ on, attrs }">
            <v-list-item @click="handleProjectClick(project)">
              <v-list-item-avatar>
                <v-icon color="#8e24aa">mdi-folder-star</v-icon>
              </v-list-item-avatar>
              <v-list-item-content v-bind="attrs" v-on="on">
                <v-list-item-title>
                  {{ project.name }}
                </v-list-item-title>
                <v-list-item-subtitle>
                  <v-chip
                    x-small
                    outlined
                    class="mr-1"
                    :color="getStatusColor(project.meta.status)"
                  >
                    {{ project.meta.status }}
                  </v-chip>
                  <span class="text-caption">
                    {{ project.meta.datasets.length }} dataset{{
                      project.meta.datasets.length !== 1 ? "s" : ""
                    }}
                  </span>
                  <template v-if="project.creatorId">
                    <span class="mx-1">·</span>
                    <span class="text-caption">
                      Owner: {{ getUserDisplayName(project.creatorId) }}
                    </span>
                  </template>
                </v-list-item-subtitle>
              </v-list-item-content>
              <v-list-item-action
                class="my-0 d-flex flex-column justify-center"
              >
                <div class="text-caption grey--text text-left">
                  <div>Updated:</div>
                  <div style="line-height: 1.1">
                    {{ formatDate(project.updated) }}
                  </div>
                </div>
              </v-list-item-action>
            </v-list-item>
          </template>
          <div v-if="project.description">
            {{ project.description }}
          </div>
        </v-tooltip>
      </div>
    </v-list>
  </div>
</template>

<script lang="ts">
import { Vue, Component, Prop } from "vue-property-decorator";
import { IProject } from "@/store/model";
import { formatDateString } from "@/utils/date";

@Component
export default class RecentProjects extends Vue {
  @Prop({ type: Array, required: true })
  readonly projects!: IProject[];

  @Prop({ type: Boolean, default: false })
  readonly loading!: boolean;

  @Prop({ type: Function, required: true })
  readonly getUserDisplayName!: (creatorId: string) => string;

  formatDate(dateStr: string): string {
    return formatDateString(dateStr);
  }

  getStatusColor(status: string): string {
    switch (status) {
      case "exported":
        return "success";
      case "exporting":
        return "warning";
      default:
        return "grey";
    }
  }

  handleProjectClick(project: IProject) {
    this.$emit("project-clicked", project);
  }
}
</script>

<style scoped>
.recent-projects-container {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.scrollable {
  overflow-y: auto;
  flex-grow: 1;
  min-height: 0;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
}
</style>
