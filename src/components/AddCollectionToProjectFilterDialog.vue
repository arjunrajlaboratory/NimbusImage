<template>
  <v-card>
    <v-card-title>
      <span class="text--secondary">Adding collection to project:</span>
      <span class="text--primary ml-1">{{ project.name }}</span>
    </v-card-title>
    <v-card-text>
      <v-text-field
        v-model="searchQuery"
        label="Search collections..."
        prepend-icon="mdi-magnify"
        clearable
        outlined
        dense
        class="mb-2"
      />

      <v-progress-linear v-if="loading" indeterminate />

      <div
        v-else-if="filteredCollections.length === 0"
        class="text-center pa-4"
      >
        <v-icon size="48" color="grey">mdi-folder-multiple-outline</v-icon>
        <div class="text-body-2 grey--text mt-2">
          {{
            searchQuery
              ? "No collections match your search"
              : "No collections available"
          }}
        </div>
      </div>

      <v-list v-else dense class="collection-list">
        <v-list-item-group v-model="selectedIndices" multiple>
          <v-list-item
            v-for="(collection, index) in filteredCollections"
            :key="collection.id"
            :disabled="isInProject(collection.id)"
          >
            <v-list-item-action>
              <v-checkbox
                :input-value="selectedIndices.includes(index)"
                :disabled="isInProject(collection.id)"
                color="primary"
              />
            </v-list-item-action>
            <v-list-item-content>
              <v-list-item-title>
                {{ collection.name }}
                <v-chip
                  v-if="isInProject(collection.id)"
                  x-small
                  class="ml-2"
                  color="grey"
                >
                  Already in project
                </v-chip>
              </v-list-item-title>
              <v-list-item-subtitle v-if="collection.description">
                {{ collection.description }}
              </v-list-item-subtitle>
            </v-list-item-content>
          </v-list-item>
        </v-list-item-group>
      </v-list>
    </v-card-text>
    <v-card-actions>
      <v-btn text @click="$emit('done')">Cancel</v-btn>
      <v-spacer />
      <v-btn
        color="primary"
        :disabled="selectedCollections.length === 0"
        :loading="adding"
        @click="confirmAdd"
      >
        Add {{ selectedCollections.length }} Collection(s)
      </v-btn>
    </v-card-actions>

    <!-- Permission propagation confirmation -->
    <v-dialog v-model="showPermissionConfirm" max-width="500" persistent>
      <v-card>
        <v-card-title>Update collection permissions?</v-card-title>
        <v-card-text>
          This project is
          <template v-if="isPublic">
            <strong>public</strong>
          </template>
          <template v-else> <strong>shared with other users</strong> </template
          >. Adding {{ selectedCollections.length }} collection(s) will update
          their permissions to match the project's access settings.
        </v-card-text>
        <v-card-actions class="justify-end" style="gap: 8px">
          <v-btn text @click="showPermissionConfirm = false">Cancel</v-btn>
          <v-btn color="primary" @click="addCollections">Continue</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import { IProject, IDatasetConfiguration } from "@/store/model";
import store from "@/store";
import projects from "@/store/projects";

@Component
export default class AddCollectionToProjectFilterDialog extends Vue {
  readonly store = store;
  readonly projects = projects;

  @Prop({ required: true })
  project!: IProject;

  @Prop({ default: false })
  isShared!: boolean;

  @Prop({ default: false })
  isPublic!: boolean;

  searchQuery = "";
  loading = false;
  adding = false;
  showPermissionConfirm = false;
  allCollections: IDatasetConfiguration[] = [];
  selectedIndices: number[] = [];

  get existingCollectionIds(): Set<string> {
    return new Set(this.project.meta.collections.map((c) => c.collectionId));
  }

  get filteredCollections(): IDatasetConfiguration[] {
    if (!this.searchQuery) {
      return this.allCollections;
    }
    const query = this.searchQuery.toLowerCase();
    return this.allCollections.filter(
      (c) =>
        c.name.toLowerCase().includes(query) ||
        (c.description && c.description.toLowerCase().includes(query)),
    );
  }

  get selectedCollections(): IDatasetConfiguration[] {
    return this.selectedIndices
      .map((index) => this.filteredCollections[index])
      .filter((c) => c && !this.isInProject(c.id));
  }

  mounted() {
    this.fetchCollections();
  }

  @Watch("project")
  onProjectChange() {
    this.selectedIndices = [];
  }

  isInProject(collectionId: string): boolean {
    return this.existingCollectionIds.has(collectionId);
  }

  async fetchCollections() {
    this.loading = true;
    try {
      this.allCollections = await this.store.api.getAllConfigurations();
    } finally {
      this.loading = false;
    }
  }

  confirmAdd() {
    if (this.selectedCollections.length === 0) return;
    if (this.isShared || this.isPublic) {
      this.showPermissionConfirm = true;
    } else {
      this.addCollections();
    }
  }

  async addCollections() {
    this.showPermissionConfirm = false;
    if (this.selectedCollections.length === 0) return;

    this.adding = true;
    try {
      for (const collection of this.selectedCollections) {
        await this.projects.addCollectionToProject({
          projectId: this.project.id,
          collectionId: collection.id,
        });
      }
      this.$emit(
        "added",
        this.selectedCollections.map((c) => c.id),
      );
      this.selectedIndices = [];
    } finally {
      this.adding = false;
    }
  }
}
</script>

<style lang="scss" scoped>
.collection-list {
  max-height: 400px;
  overflow-y: auto;
}
</style>
