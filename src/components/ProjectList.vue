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
          density="compact"
          clearable
        />
      </div>
      <v-btn
        v-if="store.isLoggedIn"
        color="primary"
        size="small"
        class="ml-2"
        @click="showCreateDialog = true"
      >
        <v-icon start size="small">mdi-plus</v-icon>
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
        <div class="text-h6 text-grey mt-2">No projects found</div>
        <div class="text-body-2 text-grey">
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
          @click="navigateToProject(project)"
        >
          <template #prepend>
            <v-icon color="#8e24aa" size="24">mdi-folder-star</v-icon>
          </template>

          <v-list-item-title class="project-title">
            {{ project.name }}
          </v-list-item-title>
          <v-list-item-subtitle v-if="project.description">
            {{ project.description }}
          </v-list-item-subtitle>
          <v-list-item-subtitle>
            <div class="d-flex align-center mt-1">
              <v-chip
                size="x-small"
                variant="outlined"
                class="mr-1"
                :color="getProjectStatusColor(project.meta.status)"
              >
                {{ project.meta.status }}
              </v-chip>
              <v-chip
                size="x-small"
                variant="outlined"
                color="grey"
                class="mr-1"
              >
                {{ project.meta.datasets.length }} dataset{{
                  project.meta.datasets.length !== 1 ? "s" : ""
                }}
              </v-chip>
              <v-chip size="x-small" variant="outlined" color="grey">
                {{ project.meta.collections.length }} collection{{
                  project.meta.collections.length !== 1 ? "s" : ""
                }}
              </v-chip>
              <v-spacer />
              <span class="text-caption text-grey">
                Updated {{ formatDateString(project.updated) }}
              </span>
            </div>
          </v-list-item-subtitle>

          <template #append>
            <v-menu>
              <template #activator="{ props: activatorProps }">
                <v-btn icon size="small" variant="text" v-bind="activatorProps">
                  <v-icon size="small">mdi-dots-vertical</v-icon>
                </v-btn>
              </template>
              <v-list density="compact">
                <v-list-item @click="editProject(project)">
                  <template #prepend>
                    <v-icon size="small">mdi-pencil</v-icon>
                  </template>
                  <v-list-item-title>Edit</v-list-item-title>
                </v-list-item>
                <v-list-item @click="confirmDeleteProject(project)">
                  <template #prepend>
                    <v-icon size="small" color="error">mdi-delete</v-icon>
                  </template>
                  <v-list-item-title class="text-error"
                    >Delete</v-list-item-title
                  >
                </v-list-item>
              </v-list>
            </v-menu>
          </template>
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
            variant="outlined"
            density="compact"
            autofocus
          />
          <v-textarea
            v-model="newProjectDescription"
            label="Description (optional)"
            variant="outlined"
            density="compact"
            rows="3"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="showCreateDialog = false">Cancel</v-btn>
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
            variant="outlined"
            density="compact"
          />
          <v-textarea
            v-model="editProjectDescription"
            label="Description"
            variant="outlined"
            density="compact"
            rows="3"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="showEditDialog = false">Cancel</v-btn>
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
          <v-btn variant="text" @click="showDeleteDialog = false">Cancel</v-btn>
          <v-btn color="error" :loading="deleting" @click="deleteProject">
            Delete
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import store from "@/store";
import projects from "@/store/projects";
import { IProject, getProjectStatusColor } from "@/store/model";
import { formatDateString } from "@/utils/date";

const loading = ref(true);
const searchQuery = ref("");

const showCreateDialog = ref(false);
const newProjectName = ref("");
const newProjectDescription = ref("");
const creating = ref(false);

const showEditDialog = ref(false);
const editingProject = ref<IProject | null>(null);
const editProjectName = ref("");
const editProjectDescription = ref("");
const saving = ref(false);

const showDeleteDialog = ref(false);
const projectToDelete = ref<IProject | null>(null);
const deleting = ref(false);

const router = useRouter();

const filteredProjects = computed<IProject[]>(() => {
  const allProjects = projects.projects;
  if (!searchQuery.value) {
    return allProjects;
  }

  const query = searchQuery.value.toLowerCase();
  return allProjects.filter(
    (project) =>
      project.name.toLowerCase().includes(query) ||
      (project.description &&
        project.description.toLowerCase().includes(query)),
  );
});

async function fetchProjects() {
  loading.value = true;
  try {
    await projects.fetchProjects();
  } finally {
    loading.value = false;
  }
}

async function createProject() {
  if (!newProjectName.value.trim()) return;

  creating.value = true;
  try {
    await projects.createProject({
      name: newProjectName.value.trim(),
      description: newProjectDescription.value.trim(),
    });
    showCreateDialog.value = false;
    newProjectName.value = "";
    newProjectDescription.value = "";
  } finally {
    creating.value = false;
  }
}

function editProject(project: IProject) {
  editingProject.value = project;
  editProjectName.value = project.name;
  editProjectDescription.value = project.description;
  showEditDialog.value = true;
}

async function saveProject() {
  if (!editingProject.value || !editProjectName.value.trim()) return;

  saving.value = true;
  try {
    await projects.updateProject({
      projectId: editingProject.value.id,
      name: editProjectName.value.trim(),
      description: editProjectDescription.value.trim(),
    });
    showEditDialog.value = false;
    editingProject.value = null;
  } finally {
    saving.value = false;
  }
}

function confirmDeleteProject(project: IProject) {
  projectToDelete.value = project;
  showDeleteDialog.value = true;
}

async function deleteProject() {
  if (!projectToDelete.value) return;

  deleting.value = true;
  try {
    await projects.deleteProject(projectToDelete.value.id);
    showDeleteDialog.value = false;
    projectToDelete.value = null;
  } finally {
    deleting.value = false;
  }
}

function navigateToProject(project: IProject) {
  router.push({
    name: "project",
    params: { projectId: project.id },
  });
}

onMounted(async () => {
  await fetchProjects();
});

defineExpose({
  loading,
  searchQuery,
  showCreateDialog,
  newProjectName,
  newProjectDescription,
  creating,
  showEditDialog,
  editingProject,
  editProjectName,
  editProjectDescription,
  saving,
  showDeleteDialog,
  projectToDelete,
  deleting,
  filteredProjects,
  fetchProjects,
  createProject,
  editProject,
  saveProject,
  confirmDeleteProject,
  deleteProject,
  navigateToProject,
});
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
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
  cursor: pointer;
}

.project-title {
  font-weight: 500;
  color: #8e24aa;
}
</style>
