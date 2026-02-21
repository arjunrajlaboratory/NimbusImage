<template>
  <v-container>
    <div class="headline py-4">
      Copy one or several existing collections to add to dataset
      {{ datasetName }}
    </div>
    <v-card>
      <v-card-title> Location of new collections </v-card-title>
      <v-card-text>
        <div class="d-flex">
          <girder-location-chooser
            v-model="path"
            :breadcrumb="true"
            title="Select a Folder to Import the New Dataset"
          />
        </div>
      </v-card-text>
    </v-card>
    <configuration-select
      @submit="submit"
      @cancel="cancel"
      :title="'Compatible collections'"
    />
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, getCurrentInstance } from "vue";
import { IDatasetConfiguration } from "@/store/model";
import { IGirderLocation } from "@/girder";
import store from "@/store";
import girderResources from "@/store/girderResources";
import ConfigurationSelect from "@/components/ConfigurationSelect.vue";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";

const vm = getCurrentInstance()!.proxy;

const path = ref<IGirderLocation | null>(null);

const dataset = computed(() => store.dataset);

const datasetName = computed(() => dataset.value?.name || "");

async function fetchParentFolder() {
  path.value = null;
  if (!dataset.value) {
    return;
  }
  const datasetFolder = await girderResources.getFolder(dataset.value.id);
  const parentId = datasetFolder?.parentId;
  if (!parentId) {
    return;
  }
  path.value = await girderResources.getFolder(parentId);
}

async function submit(configurations: IDatasetConfiguration[]) {
  const ds = dataset.value;
  const parentFolder = path.value;
  if (!ds || !parentFolder) {
    return;
  }

  await Promise.all(
    configurations.map((configuration) =>
      store.api
        .duplicateConfiguration(configuration, (parentFolder as any)._id)
        .then((newConfiguration: any) =>
          store.createDatasetView({
            configurationId: newConfiguration.id,
            datasetId: ds.id,
          }),
        ),
    ),
  );

  vm.$router.back();
}

function cancel() {
  vm.$router.back();
}

watch(dataset, fetchParentFolder);

onMounted(() => {
  fetchParentFolder();
});

defineExpose({ path, dataset, datasetName, fetchParentFolder, submit, cancel });
</script>
