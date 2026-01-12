<template>
  <v-dialog v-model="dialogModel" max-width="500" persistent>
    <v-card>
      <v-card-title>
        <v-icon left color="#8e24aa">mdi-folder-star</v-icon>
        Add to Project
      </v-card-title>

      <v-card-text>
        <div v-if="datasetName" class="mb-3">
          <span class="text-body-2 grey--text">Dataset:</span>
          <span class="ml-1 font-weight-medium">{{ datasetName }}</span>
        </div>

        <v-tabs v-model="tab" grow>
          <v-tab>Existing Project</v-tab>
          <v-tab>New Project</v-tab>
        </v-tabs>

        <v-tabs-items v-model="tab">
          <!-- Existing Project Tab -->
          <v-tab-item>
            <div class="pt-4">
              <v-progress-linear v-if="loadingProjects" indeterminate />

              <div
                v-else-if="availableProjects.length === 0"
                class="text-center pa-4"
              >
                <v-icon size="48" color="grey">mdi-folder-star-outline</v-icon>
                <div class="text-body-2 grey--text mt-2">
                  No projects available. Create one to get started.
                </div>
              </div>

              <v-list v-else dense class="project-select-list">
                <v-list-item-group v-model="selectedProjectIndex" color="primary">
                  <v-list-item
                    v-for="project in availableProjects"
                    :key="project.id"
                    :disabled="isDatasetInProject(project)"
                  >
                    <v-list-item-icon>
                      <v-icon
                        :color="
                          isDatasetInProject(project) ? 'grey' : '#8e24aa'
                        "
                      >
                        {{
                          isDatasetInProject(project)
                            ? "mdi-check-circle"
                            : "mdi-folder-star"
                        }}
                      </v-icon>
                    </v-list-item-icon>
                    <v-list-item-content>
                      <v-list-item-title>{{ project.name }}</v-list-item-title>
                      <v-list-item-subtitle>
                        {{ project.meta.datasets.length }} dataset{{
                          project.meta.datasets.length !== 1 ? "s" : ""
                        }}
                        <span v-if="isDatasetInProject(project)" class="ml-1">
                          (already added)
                        </span>
                      </v-list-item-subtitle>
                    </v-list-item-content>
                  </v-list-item>
                </v-list-item-group>
              </v-list>
            </div>
          </v-tab-item>

          <!-- New Project Tab -->
          <v-tab-item>
            <div class="pt-4">
              <v-text-field
                v-model="newProjectName"
                label="Project Name"
                outlined
                dense
                autofocus
              />
              <v-textarea
                v-model="newProjectDescription"
                label="Description (optional)"
                outlined
                dense
                rows="3"
              />
            </div>
          </v-tab-item>
        </v-tabs-items>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn text @click="cancel">Cancel</v-btn>
        <v-btn
          color="primary"
          :disabled="!canAdd"
          :loading="adding"
          @click="addToProject"
        >
          {{ tab === 0 ? "Add to Project" : "Create & Add" }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import store from "@/store";
import projects from "@/store/projects";
import { IProject } from "@/store/model";

@Component
export default class AddToProjectDialog extends Vue {
  @Prop({ type: Boolean, default: false }) value!: boolean;
  @Prop({ type: String, required: true }) datasetId!: string;
  @Prop({ type: String, default: "" }) datasetName!: string;

  readonly store = store;
  readonly projects = projects;

  tab = 0;
  loadingProjects = false;
  selectedProjectIndex: number | null = null;
  newProjectName = "";
  newProjectDescription = "";
  adding = false;

  get dialogModel(): boolean {
    return this.value;
  }

  set dialogModel(val: boolean) {
    this.$emit("input", val);
  }

  get availableProjects(): IProject[] {
    return this.projects.projects;
  }

  get selectedProject(): IProject | null {
    if (
      this.selectedProjectIndex === null ||
      this.selectedProjectIndex === undefined
    ) {
      return null;
    }
    return this.availableProjects[this.selectedProjectIndex] || null;
  }

  get canAdd(): boolean {
    if (this.tab === 0) {
      // Existing project tab
      return (
        this.selectedProject !== null &&
        !this.isDatasetInProject(this.selectedProject)
      );
    } else {
      // New project tab
      return this.newProjectName.trim().length > 0;
    }
  }

  @Watch("value")
  onValueChange(newVal: boolean) {
    if (newVal) {
      this.loadProjects();
      this.reset();
    }
  }

  isDatasetInProject(project: IProject): boolean {
    return project.meta.datasets.some((d) => d.datasetId === this.datasetId);
  }

  async loadProjects() {
    this.loadingProjects = true;
    try {
      await this.projects.fetchProjects();
    } finally {
      this.loadingProjects = false;
    }
  }

  reset() {
    this.tab = 0;
    this.selectedProjectIndex = null;
    this.newProjectName = "";
    this.newProjectDescription = "";
  }

  cancel() {
    this.dialogModel = false;
  }

  async addToProject() {
    if (!this.canAdd) return;

    this.adding = true;
    try {
      let projectId: string;

      if (this.tab === 0) {
        // Use existing project
        if (!this.selectedProject) return;
        projectId = this.selectedProject.id;
      } else {
        // Create new project first
        const newProject = await this.projects.createProject({
          name: this.newProjectName.trim(),
          description: this.newProjectDescription.trim(),
        });
        if (!newProject) {
          return;
        }
        projectId = newProject.id;
      }

      // Add dataset to project
      await this.projects.addDatasetToProject({
        projectId,
        datasetId: this.datasetId,
      });

      this.$emit("added", projectId);
      this.dialogModel = false;
    } finally {
      this.adding = false;
    }
  }
}
</script>

<style lang="scss" scoped>
.project-select-list {
  max-height: 300px;
  overflow-y: auto;
}
</style>
