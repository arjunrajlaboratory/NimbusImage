<template>
  <v-container>
    <div class="headline py-4">Create a new collection from a dataset</div>
    <v-form v-model="valid">
      <v-text-field v-model="name" label="Name" :rules="rules" />
      <v-textarea v-model="description" label="Description" />
      <girder-location-chooser
        v-model="path"
        :breadcrumb="true"
        title="Select a folder to create the new collection in"
      />

      <div class="button-bar">
        <v-btn :disabled="!valid" color="success" class="mr-4" @click="submit">
          Create
        </v-btn>
      </div>
    </v-form>
  </v-container>
</template>
<script setup lang="ts">
import { ref, computed, watch, onMounted, getCurrentInstance } from "vue";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { useRouteMapper } from "@/utils/useRouteMapper";
import { IGirderSelectAble } from "@/girder";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";

const vm = getCurrentInstance()!.proxy;

useRouteMapper(
  {},
  {
    datasetId: {
      parse: String,
      get: () => store.selectedDatasetId,
      set: (value: string) => store.setSelectedDataset(value),
    },
  },
);

const valid = ref(false);
const name = ref("");
const description = ref("");
const path = ref<IGirderSelectAble | null>(null);

const dataset = computed(() => store.dataset);

const rules = computed(() => [
  (v: string) => v.trim().length > 0 || `value is required`,
]);

async function fetchDefaultPath() {
  const datasetId = store.dataset?.id;
  if (datasetId) {
    const datasetFolder = await girderResources.getFolder(datasetId);
    const parentId = datasetFolder?.parentId;
    if (parentId) {
      const parentFolder = await girderResources.getFolder(parentId);
      path.value = parentFolder;
      return;
    }
  }
  path.value = store.girderUser;
}

function submit() {
  const folderId = path.value?._id;
  if (!valid.value || !folderId) {
    return;
  }

  store
    .createConfiguration({
      name: name.value,
      description: description.value,
      folderId,
    })
    .then((config) => {
      if (!config) {
        return;
      }
      if (store.dataset) {
        store.createDatasetView({
          configurationId: config.id,
          datasetId: store.dataset.id,
        });
      }
      vm.$router.push({
        name: "configuration",
        params: Object.assign(
          {
            configurationId: config.id,
          },
          vm.$route.params,
        ),
      });
    });
}

watch(dataset, () => fetchDefaultPath());
onMounted(() => fetchDefaultPath());

defineExpose({
  valid,
  name,
  description,
  path,
  dataset,
  rules,
  fetchDefaultPath,
  submit,
});
</script>
