<template>
  <v-dialog v-model="dialogModel" max-width="500" persistent>
    <v-card>
      <v-card-title>
        <v-icon left color="#8e24aa">mdi-folder-star</v-icon>
        Add Collection to Project
      </v-card-title>

      <v-card-text>
        <div v-if="collectionName" class="mb-3">
          <span class="text-body-2 grey--text">Collection:</span>
          <span class="ml-1 font-weight-medium">{{ collectionName }}</span>
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
                <v-list-item-group
                  v-model="selectedProjectIndex"
                  color="primary"
                >
                  <v-list-item
                    v-for="project in availableProjects"
                    :key="project.id"
                    :disabled="isCollectionInProject(project)"
                  >
                    <v-list-item-icon>
                      <v-icon
                        :color="
                          isCollectionInProject(project) ? 'grey' : '#8e24aa'
                        "
                      >
                        {{
                          isCollectionInProject(project)
                            ? "mdi-check-circle"
                            : "mdi-folder-star"
                        }}
                      </v-icon>
                    </v-list-item-icon>
                    <v-list-item-content>
                      <v-list-item-title>{{ project.name }}</v-list-item-title>
                      <v-list-item-subtitle>
                        {{ project.meta.collections.length }} collection{{
                          project.meta.collections.length !== 1 ? "s" : ""
                        }}
                        <span
                          v-if="isCollectionInProject(project)"
                          class="ml-1"
                        >
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

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import store from "@/store";
import projects from "@/store/projects";
import { IProject } from "@/store/model";

const props = withDefaults(
  defineProps<{
    value?: boolean;
    collectionId: string;
    collectionName?: string;
  }>(),
  {
    value: false,
    collectionName: "",
  },
);

const emit = defineEmits<{
  (e: "input", value: boolean): void;
  (e: "added", projectId: string): void;
}>();

const tab = ref(0);
const loadingProjects = ref(false);
const selectedProjectIndex = ref<number | null>(null);
const newProjectName = ref("");
const newProjectDescription = ref("");
const adding = ref(false);

const dialogModel = computed({
  get: () => props.value,
  set: (val: boolean) => emit("input", val),
});

const availableProjects = computed<IProject[]>(() => {
  return projects.projects;
});

const selectedProject = computed<IProject | null>(() => {
  if (
    selectedProjectIndex.value === null ||
    selectedProjectIndex.value === undefined
  ) {
    return null;
  }
  return availableProjects.value[selectedProjectIndex.value] || null;
});

const canAdd = computed<boolean>(() => {
  if (tab.value === 0) {
    // Existing project tab
    return (
      selectedProject.value !== null &&
      !isCollectionInProject(selectedProject.value)
    );
  } else {
    // New project tab
    return newProjectName.value.trim().length > 0;
  }
});

function isCollectionInProject(project: IProject): boolean {
  return project.meta.collections.some(
    (c) => c.collectionId === props.collectionId,
  );
}

async function loadProjects() {
  loadingProjects.value = true;
  try {
    await projects.fetchProjects();
  } finally {
    loadingProjects.value = false;
  }
}

function reset() {
  tab.value = 0;
  selectedProjectIndex.value = null;
  newProjectName.value = "";
  newProjectDescription.value = "";
}

function cancel() {
  dialogModel.value = false;
}

async function addToProject() {
  if (!canAdd.value) return;

  adding.value = true;
  try {
    let projectId: string;

    if (tab.value === 0) {
      // Use existing project
      if (!selectedProject.value) return;
      projectId = selectedProject.value.id;
    } else {
      // Create new project first
      const newProject = await projects.createProject({
        name: newProjectName.value.trim(),
        description: newProjectDescription.value.trim(),
      });
      if (!newProject) {
        return;
      }
      projectId = newProject.id;
    }

    // Add collection to project
    await projects.addCollectionToProject({
      projectId,
      collectionId: props.collectionId,
    });

    emit("added", projectId);
    dialogModel.value = false;
  } finally {
    adding.value = false;
  }
}

watch(
  () => props.value,
  (newVal: boolean) => {
    if (newVal) {
      loadProjects();
      reset();
    }
  },
);

defineExpose({
  dialogModel,
  tab,
  loadingProjects,
  selectedProjectIndex,
  newProjectName,
  newProjectDescription,
  adding,
  availableProjects,
  selectedProject,
  canAdd,
  isCollectionInProject,
  loadProjects,
  reset,
  cancel,
  addToProject,
});
</script>

<style lang="scss" scoped>
.project-select-list {
  max-height: 300px;
  overflow-y: auto;
}
</style>
