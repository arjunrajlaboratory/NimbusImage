<template>
  <div class="project-list-wrapper">
    <div class="d-flex align-center ma-2">
      <v-icon class="mr-2">mdi-magnify</v-icon>
      <div class="flex-grow-1">
        <v-text-field
          v-model="searchQuery"
          placeholder="Search projects..."
          hide-details
          single-line
          dense
          clearable
        />
      </div>
      <v-btn
        v-if="store.isLoggedIn"
        color="primary"
        small
        class="ml-2"
        @click="showCreateDialog = true"
      >
        <v-icon left small>mdi-plus</v-icon>
        New Project
      </v-btn>
    </div>

    <div class="project-list-content">
      <v-progress-linear v-if="loading" indeterminate />

      <div
        v-if="!loading && filteredProjects.length === 0"
        class="text-center pa-4"
      >
        <v-icon size="64" color="grey">mdi-folder-star</v-icon>
        <div class="text-h6 grey--text mt-2">No projects found</div>
        <div class="text-body-2 grey--text">
          {{
            searchQuery
              ? "Try adjusting your search terms"
              : "Create your first project to organize datasets for export"
          }}
        </div>
      </div>

      <v-list v-else-if="!loading" class="project-list">
        <v-list-item
          v-for="project in filteredProjects"
          :key="project.id"
          class="project-item"
          :class="{ 'project-item-hover': !loading }"
        >
          <v-list-item-avatar>
            <v-icon color="#8e24aa" size="24">mdi-folder-star</v-icon>
          </v-list-item-avatar>

          <v-list-item-content>
            <v-list-item-title class="project-title">
              {{ project.name }}
            </v-list-item-title>
            <v-list-item-subtitle v-if="project.description">
              {{ project.description }}
            </v-list-item-subtitle>

            <div class="d-flex align-center mt-1">
              <v-chip
                x-small
                outlined
                class="mr-1"
                :color="getStatusColor(project.meta.status)"
              >
                {{ project.meta.status }}
              </v-chip>
              <v-chip x-small outlined color="grey" class="mr-1">
                {{ project.meta.datasets.length }} dataset{{
                  project.meta.datasets.length !== 1 ? "s" : ""
                }}
              </v-chip>
              <v-chip x-small outlined color="grey">
                {{ project.meta.collections.length }} collection{{
                  project.meta.collections.length !== 1 ? "s" : ""
                }}
              </v-chip>
              <v-spacer />
              <span class="text-caption grey--text">
                Updated {{ formatDateString(project.updated) }}
              </span>
            </div>
          </v-list-item-content>

          <v-list-item-action>
            <v-menu offset-y>
              <template #activator="{ on, attrs }">
                <v-btn icon small v-bind="attrs" v-on="on">
                  <v-icon small>mdi-dots-vertical</v-icon>
                </v-btn>
              </template>
              <v-list dense>
                <v-list-item @click="editProject(project)">
                  <v-list-item-icon>
                    <v-icon small>mdi-pencil</v-icon>
                  </v-list-item-icon>
                  <v-list-item-title>Edit</v-list-item-title>
                </v-list-item>
                <v-list-item @click="confirmDeleteProject(project)">
                  <v-list-item-icon>
                    <v-icon small color="error">mdi-delete</v-icon>
                  </v-list-item-icon>
                  <v-list-item-title class="error--text"
                    >Delete</v-list-item-title
                  >
                </v-list-item>
              </v-list>
            </v-menu>
          </v-list-item-action>
        </v-list-item>
      </v-list>
    </div>

    <!-- Create Project Dialog -->
    <v-dialog v-model="showCreateDialog" max-width="500">
      <v-card>
        <v-card-title>Create New Project</v-card-title>
        <v-card-text>
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
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn text @click="showCreateDialog = false">Cancel</v-btn>
          <v-btn
            color="primary"
            :disabled="!newProjectName.trim()"
            :loading="creating"
            @click="createProject"
          >
            Create
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Edit Project Dialog -->
    <v-dialog v-model="showEditDialog" max-width="500">
      <v-card>
        <v-card-title>Edit Project</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="editProjectName"
            label="Project Name"
            outlined
            dense
          />
          <v-textarea
            v-model="editProjectDescription"
            label="Description"
            outlined
            dense
            rows="3"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn text @click="showEditDialog = false">Cancel</v-btn>
          <v-btn
            color="primary"
            :disabled="!editProjectName.trim()"
            :loading="saving"
            @click="saveProject"
          >
            Save
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirmation Dialog -->
    <v-dialog v-model="showDeleteDialog" max-width="400">
      <v-card>
        <v-card-title>Delete Project</v-card-title>
        <v-card-text>
          Are you sure you want to delete "{{ projectToDelete?.name }}"? This
          action cannot be undone.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn text @click="showDeleteDialog = false">Cancel</v-btn>
          <v-btn color="error" :loading="deleting" @click="deleteProject">
            Delete
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script lang="ts">
import { Vue, Component } from "vue-property-decorator";
import store from "@/store";
import projects from "@/store/projects";
import { IProject } from "@/store/model";
import { formatDateString } from "@/utils/date";

@Component
export default class ProjectList extends Vue {
  readonly store = store;
  readonly projects = projects;

  loading = true;
  searchQuery = "";

  showCreateDialog = false;
  newProjectName = "";
  newProjectDescription = "";
  creating = false;

  showEditDialog = false;
  editingProject: IProject | null = null;
  editProjectName = "";
  editProjectDescription = "";
  saving = false;

  showDeleteDialog = false;
  projectToDelete: IProject | null = null;
  deleting = false;

  formatDateString = formatDateString;

  async mounted() {
    await this.fetchProjects();
  }

  get filteredProjects(): IProject[] {
    const allProjects = this.projects.projects;
    if (!this.searchQuery) {
      return allProjects;
    }

    const query = this.searchQuery.toLowerCase();
    return allProjects.filter(
      (project) =>
        project.name.toLowerCase().includes(query) ||
        (project.description &&
          project.description.toLowerCase().includes(query)),
    );
  }

  async fetchProjects() {
    this.loading = true;
    try {
      await this.projects.fetchProjects();
    } finally {
      this.loading = false;
    }
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

  async createProject() {
    if (!this.newProjectName.trim()) return;

    this.creating = true;
    try {
      await this.projects.createProject({
        name: this.newProjectName.trim(),
        description: this.newProjectDescription.trim(),
      });
      this.showCreateDialog = false;
      this.newProjectName = "";
      this.newProjectDescription = "";
    } finally {
      this.creating = false;
    }
  }

  editProject(project: IProject) {
    this.editingProject = project;
    this.editProjectName = project.name;
    this.editProjectDescription = project.description;
    this.showEditDialog = true;
  }

  async saveProject() {
    if (!this.editingProject || !this.editProjectName.trim()) return;

    this.saving = true;
    try {
      await this.projects.updateProject({
        projectId: this.editingProject.id,
        name: this.editProjectName.trim(),
        description: this.editProjectDescription.trim(),
      });
      this.showEditDialog = false;
      this.editingProject = null;
    } finally {
      this.saving = false;
    }
  }

  confirmDeleteProject(project: IProject) {
    this.projectToDelete = project;
    this.showDeleteDialog = true;
  }

  async deleteProject() {
    if (!this.projectToDelete) return;

    this.deleting = true;
    try {
      await this.projects.deleteProject(this.projectToDelete.id);
      this.showDeleteDialog = false;
      this.projectToDelete = null;
    } finally {
      this.deleting = false;
    }
  }
}
</script>

<style lang="scss" scoped>
.project-list-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.project-list-content {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.project-list {
  padding: 0;
}

.project-item {
  border-bottom: 1px solid #e0e0e0;
  transition: background-color 0.2s;

  &:hover.project-item-hover {
    background-color: #f5f5f5;
  }
}

.project-title {
  font-weight: 500;
  color: #8e24aa;
}

.project-item-hover:hover .project-title {
  color: #7b1fa2;
}
</style>
