<template>
  <v-list class="pa-0" :disabled="disableOptions">
    <v-progress-circular v-if="isLoading" indeterminate />
    <!-- Moving -->
    <v-list-item @click.stop="moveDialog = true">
      <v-list-item-title> Move </v-list-item-title>
    </v-list-item>
    <girder-location-chooser
      :dialog.sync="moveDialog"
      @input="move"
      :disabled="disableOptions"
      activator-disabled
    />
    <!-- Deleting -->
    <v-list-item @click.stop="deleteDialog = true">
      <v-list-item-title> Delete </v-list-item-title>
    </v-list-item>
    <v-dialog v-model="deleteDialog">
      <v-card>
        <v-card-title>Delete items</v-card-title>
        <v-card-text>
          <p>You are about to delete these items:</p>
          <v-simple-table dense>
            <tbody>
              <tr v-for="item in items" :key="item._id">
                <td>{{ item.name }}</td>
              </tr>
            </tbody>
          </v-simple-table>
        </v-card-text>
        <v-card-actions class="d-flex">
          <v-spacer />
          <v-progress-circular v-if="isLoading" indeterminate />
          <v-btn color="red" @click="deleteItems" :disabled="disableOptions">
            <template v-if="isLoading">
              Deleting {{ items.length }} item{{
                items.length === 1 ? "" : "s"
              }}...
            </template>
            <template v-else>
              Delete {{ items.length }} item{{ items.length === 1 ? "" : "s" }}
            </template>
          </v-btn>
          <v-btn
            color="primary"
            @click="deleteDialog = false"
            :disabled="disableOptions"
          >
            Cancel
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <template v-if="items.length === 1">
      <!-- Renaming -->
      <v-list-item @click.stop="renameDialog = true">
        <v-list-item-title> Rename </v-list-item-title>
      </v-list-item>
      <!-- Add to Project (for folders/datasets) -->
      <template v-if="items[0]._modelType === 'folder' && store.isLoggedIn">
        <v-list-item @click.stop="addToProjectDialog = true">
          <v-list-item-title>
            <v-icon left small color="#8e24aa">mdi-folder-star</v-icon>
            Add to Project
          </v-list-item-title>
        </v-list-item>
        <add-to-project-dialog
          v-model="addToProjectDialog"
          :dataset-id="items[0]._id"
          :dataset-name="items[0].name"
          @added="onAddedToProject"
        />
      </template>
      <v-dialog v-model="renameDialog">
        <v-card>
          <v-card-title> New name </v-card-title>
          <v-card-text>
            <v-form @submit.prevent="rename">
              <v-text-field v-model="newName" autofocus />
              <div class="d-flex">
                <v-spacer />
                <v-progress-circular v-if="isLoading" indeterminate />
                <v-btn type="submit" color="primary" :disabled="disableOptions">
                  Submit
                </v-btn>
              </div>
            </v-form>
          </v-card-text>
        </v-card>
      </v-dialog>
      <template v-if="items[0]._modelType === 'folder'">
        <!-- Change assetstore -->
        <template v-for="assetstore in assetstores">
          <v-list-item
            @click.stop="moveFolderToAssetstore(items[0]._id, assetstore._id)"
            :key="assetstore._id"
          >
            <v-list-item-title>
              Move to assetstore {{ assetstore.name }}
            </v-list-item-title>
          </v-list-item>
        </template>
        <v-dialog :value="!!moveFolderToAssetstorResolve">
          <v-card>
            <v-card-title>
              Move folder content to a different assetstore?
            </v-card-title>
            <v-card-text class="d-flex">
              <v-progress-circular v-if="isLoading" indeterminate />
              <v-spacer />
              <v-btn
                @click="moveFolderToAssetstorResolve?.(true)"
                :disabled="isLoading"
                class="mx-2"
                color="primary"
              >
                Confirm
              </v-btn>
              <v-btn
                @click="moveFolderToAssetstorResolve?.(false)"
                class="mx-2"
                :disabled="isLoading"
              >
                Cancel
              </v-btn>
            </v-card-text>
          </v-card>
        </v-dialog>
      </template>
    </template>
    <template
      v-if="
        items.length === 1 &&
        (items[0]._modelType === 'file' || items[0]._modelType === 'item')
      "
    >
      <!-- Downloading -->
      <v-list-item @click.stop="downloadResource()">
        <v-list-item-title> Download </v-list-item-title>
      </v-list-item>
    </template>
    <!-- Custom options for a all options -->
    <slot :items="items"></slot>
  </v-list>
</template>

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { IGirderFolder, IGirderSelectAble } from "@/girder";
import { createDecorator } from "vue-class-component";
import { downloadToClient } from "@/utils/download";

// Use this decorator for any action
const OptionAction = createDecorator((options, key) => {
  const methods = options.methods;
  if (!methods) {
    return;
  }
  // Keep the original method for later.
  const originalMethod = methods[key];
  const beforeAction = methods.beforeAction;
  const afterAction = methods.afterAction;

  // Wrap the method with the logging logic.
  methods[key] = async function wrapperMethod(...args) {
    try {
      beforeAction?.apply(this, args);
      return await originalMethod.apply(this, args);
    } finally {
      afterAction?.apply(this, args);
    }
  };
});

// Use this decorator when the resources are invalidated by the action
const MutatingAction = createDecorator((options, key) => {
  const methods = options.methods;
  if (!methods) {
    return;
  }
  // Keep the original method for later.
  const originalMethod = methods[key];
  const afterMutating = methods.afterMutating;

  // Run the original method.
  methods[key] = async function wrapperMethod(...args) {
    try {
      return await originalMethod.apply(this, args);
    } finally {
      afterMutating?.apply(this, args);
    }
  };
});

@Component({
  components: {
    GirderLocationChooser: () =>
      import("@/components/GirderLocationChooser.vue").then((mod) => mod),
    AddToProjectDialog: () =>
      import("@/components/AddToProjectDialog.vue").then((mod) => mod.default),
  },
})
export default class FileManagerOptions extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;

  @Prop()
  items!: IGirderSelectAble[];

  disableOptions: boolean = false;

  moveDialog: boolean = false;

  renameDialog: boolean = false;
  newName: string = "";

  deleteDialog: boolean = false;

  addToProjectDialog: boolean = false;

  moveFolderToAssetstorResolve: ((confirmation: boolean) => void) | null = null;

  isLoading: boolean = false;

  get assetstores() {
    return this.store.assetstores;
  }

  async moveFolderToAssetstore(folderId: string, assetstoreId: string) {
    try {
      this.isLoading = false;
      const confirmation = await new Promise<boolean>((resolve) => {
        this.moveFolderToAssetstorResolve = resolve;
      });
      if (confirmation) {
        this.isLoading = true;
        await this.store.api.moveFolderToAssetstore(folderId, assetstoreId);
      }
    } finally {
      this.moveFolderToAssetstorResolve = null;
      this.isLoading = false;
      this.closeMenu();
    }
  }

  mounted() {
    this.onItemsChanged();
  }

  beforeAction() {
    this.disableOptions = true;
    this.isLoading = true;
  }

  afterAction() {
    this.disableOptions = false;
    this.isLoading = false;
  }

  afterMutating() {
    for (const item of this.items) {
      this.girderResources.ressourceChanged(item._id);
    }
    this.$emit("itemsChanged");
  }

  @Watch("items")
  onItemsChanged() {
    if (this.items.length === 1) {
      this.newName = this.items[0].name;
    }
  }

  get openedDialogs() {
    return [this.moveDialog, this.renameDialog, this.deleteDialog, this.addToProjectDialog];
  }

  get isADialogOpen() {
    return this.openedDialogs.some((dialog) => dialog);
  }

  @Watch("isADialogOpen")
  closeMenuOnDialogClose(isOpen: boolean, wasOpen: boolean) {
    if (wasOpen && !isOpen) {
      this.closeMenu();
    }
  }

  closeMenu() {
    this.$emit("closeMenu");
  }

  @MutatingAction
  @OptionAction
  async move(location: IGirderFolder | null) {
    if (!location || !this.items.length) {
      return;
    }
    await this.store.api.moveItems(this.items, location._id);
  }

  @MutatingAction
  @OptionAction
  async rename() {
    if (this.items.length !== 1) {
      return;
    }
    const item = this.items[0];
    if (item._modelType !== "item" && item._modelType !== "folder") {
      return;
    }
    await this.store.api.renameItem(item, this.newName);
    this.newName = "";
    this.renameDialog = false;
  }

  @MutatingAction
  @OptionAction
  async deleteItems() {
    await this.store.api.deleteItems(this.items);
    this.deleteDialog = false;
  }

  @OptionAction
  async downloadResource() {
    if (this.items.length !== 1) {
      return;
    }
    const item = this.items[0];
    if (item._modelType !== "item" && item._modelType !== "file") {
      return;
    }
    try {
      const data = await this.store.api.downloadResource(item);
      downloadToClient({
        href: URL.createObjectURL(data),
        download: item.name,
      });
    } finally {
      this.closeMenu();
    }
  }

  onAddedToProject() {
    this.addToProjectDialog = false;
    this.closeMenu();
  }
}
</script>
