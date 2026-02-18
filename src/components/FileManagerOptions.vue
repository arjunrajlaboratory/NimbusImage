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

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { IGirderFolder, IGirderSelectAble } from "@/girder";
import { downloadToClient } from "@/utils/download";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue"; // eslint-disable-line @typescript-eslint/no-unused-vars
import AddToProjectDialog from "@/components/AddToProjectDialog.vue"; // eslint-disable-line @typescript-eslint/no-unused-vars

const props = defineProps<{
  items: IGirderSelectAble[];
}>();

const emit = defineEmits<{
  (e: "itemsChanged"): void;
  (e: "closeMenu"): void;
}>();

const disableOptions = ref(false);
const moveDialog = ref(false);
const renameDialog = ref(false);
const newName = ref("");
const deleteDialog = ref(false);
const addToProjectDialog = ref(false);
const moveFolderToAssetstorResolve = ref<
  ((confirmation: boolean) => void) | null
>(null);
const isLoading = ref(false);

const assetstores = computed(() => store.assetstores);

const openedDialogs = computed(() => [
  moveDialog.value,
  renameDialog.value,
  deleteDialog.value,
  addToProjectDialog.value,
]);

const isADialogOpen = computed(() => openedDialogs.value.some((d) => d));

function beforeAction() {
  disableOptions.value = true;
  isLoading.value = true;
}

function afterAction() {
  disableOptions.value = false;
  isLoading.value = false;
}

function afterMutating() {
  for (const item of props.items) {
    girderResources.ressourceChanged(item._id);
  }
  emit("itemsChanged");
}

function closeMenu() {
  emit("closeMenu");
}

async function withOptionAction<T>(fn: () => Promise<T>): Promise<T> {
  try {
    beforeAction();
    return await fn();
  } finally {
    afterAction();
  }
}

async function withMutatingAction<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    afterMutating();
  }
}

async function moveFolderToAssetstore(folderId: string, assetstoreId: string) {
  try {
    isLoading.value = false;
    const confirmation = await new Promise<boolean>((resolve) => {
      moveFolderToAssetstorResolve.value = resolve;
    });
    if (confirmation) {
      isLoading.value = true;
      await store.api.moveFolderToAssetstore(folderId, assetstoreId);
    }
  } finally {
    moveFolderToAssetstorResolve.value = null;
    isLoading.value = false;
    closeMenu();
  }
}

function onItemsChanged() {
  if (props.items.length === 1) {
    newName.value = props.items[0].name;
  }
}

function closeMenuOnDialogClose(isOpen: boolean, wasOpen: boolean) {
  if (wasOpen && !isOpen) {
    closeMenu();
  }
}

async function move(location: IGirderFolder | null) {
  await withMutatingAction(() =>
    withOptionAction(async () => {
      if (!location || !props.items.length) {
        return;
      }
      await store.api.moveItems(props.items, location._id);
    }),
  );
}

async function rename() {
  await withMutatingAction(() =>
    withOptionAction(async () => {
      if (props.items.length !== 1) {
        return;
      }
      const item = props.items[0];
      if (item._modelType !== "item" && item._modelType !== "folder") {
        return;
      }
      await store.api.renameItem(item, newName.value);
      newName.value = "";
      renameDialog.value = false;
    }),
  );
}

async function deleteItems() {
  await withMutatingAction(() =>
    withOptionAction(async () => {
      await store.api.deleteItems(props.items);
      deleteDialog.value = false;
    }),
  );
}

async function downloadResource() {
  await withOptionAction(async () => {
    if (props.items.length !== 1) {
      return;
    }
    const item = props.items[0];
    if (item._modelType !== "item" && item._modelType !== "file") {
      return;
    }
    try {
      const data = await store.api.downloadResource(item);
      downloadToClient({
        href: URL.createObjectURL(data),
        download: item.name,
      });
    } finally {
      closeMenu();
    }
  });
}

function onAddedToProject() {
  addToProjectDialog.value = false;
  closeMenu();
}

watch(() => props.items, onItemsChanged);
watch(isADialogOpen, closeMenuOnDialogClose);

onMounted(() => onItemsChanged());

defineExpose({
  disableOptions,
  moveDialog,
  renameDialog,
  newName,
  deleteDialog,
  isLoading,
  assetstores,
  isADialogOpen,
  closeMenu,
  move,
  rename,
  deleteItems,
  downloadResource,
  onAddedToProject,
});
</script>
