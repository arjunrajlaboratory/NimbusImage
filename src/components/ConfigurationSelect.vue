<template>
  <v-container>
    <v-progress-circular v-if="loading" indeterminate />
    <v-data-table
      v-else-if="compatibleConfigurations.length > 0"
      show-select
      v-model="selectedConfigurations"
      :items="compatibleConfigurations"
      :headers="headers"
      :search="search"
    >
      <template v-slot:top>
        <v-card>
          <v-card-title>
            {{ title }}
            <v-spacer></v-spacer>
            <v-text-field
              v-model="search"
              append-icon="mdi-magnify"
              label="Search"
              single-line
              hide-details
            ></v-text-field>
          </v-card-title>
        </v-card>
      </template>
    </v-data-table>
    <v-alert v-else color="orange darken-2" dark>
      No compatible collection were found for this dataset.
    </v-alert>
    <div class="button-bar">
      <v-btn color="warning" class="mr-4" @click="cancel">Cancel</v-btn>
      <v-btn
        :disabled="selectedConfigurations.length <= 0"
        color="primary"
        class="mr-4"
        @click="submit"
      >
        Submit
      </v-btn>
    </div>
  </v-container>
</template>
<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import store from "@/store";
import { IDatasetConfiguration, areCompatibles } from "@/store/model";
import { getDatasetCompatibility } from "@/store/GirderAPI";
import { useRouteMapper } from "@/utils/useRouteMapper";
import { logError } from "@/utils/log";

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

const props = withDefaults(
  defineProps<{
    title?: string;
    folderId?: string;
  }>(),
  {
    title: "Select collections",
  },
);

const emit = defineEmits<{
  (e: "submit", configurations: IDatasetConfiguration[]): void;
  (e: "cancel"): void;
}>();

const compatibleConfigurations = ref<IDatasetConfiguration[]>([]);
const selectedConfigurations = ref<IDatasetConfiguration[]>([]);
const loading = ref(false);
const search = ref("");

const headers = [
  { text: "Collection Name", value: "name" },
  { text: "Collection Description", value: "description" },
];

const dataset = computed(() => store.dataset);

async function updateCompatibleConfigurations() {
  if (!dataset.value) {
    compatibleConfigurations.value = [];
    return;
  }
  loading.value = true;
  try {
    // Find all configurations that can be linked to the dataset but are not linked yet
    const views = await store.api.findDatasetViews({
      datasetId: dataset.value.id,
    });
    const linkedConfigurationIds = new Set(
      views.map((v: any) => v.configurationId),
    );

    // Get all collections using the new endpoint (like CollectionList.vue does)
    // Use folderId if provided, otherwise defaults to user's private folder
    const allConfigurations = await store.api.getAllConfigurations(
      props.folderId,
    );

    // Filter for compatible configurations using client-side logic
    const datasetCompatibility = getDatasetCompatibility(dataset.value);
    compatibleConfigurations.value = allConfigurations.filter((conf) => {
      // Skip if already linked
      if (linkedConfigurationIds.has(conf.id)) {
        return false;
      }
      // Check compatibility using the same logic as AddDatasetToCollection
      return areCompatibles(conf.compatibility, datasetCompatibility);
    });
  } catch (error) {
    logError("Failed to fetch compatible configurations:", error);
    compatibleConfigurations.value = [];
  } finally {
    loading.value = false;
  }
}

watch(dataset, updateCompatibleConfigurations);
watch(() => props.folderId, updateCompatibleConfigurations);

onMounted(updateCompatibleConfigurations);

function submit() {
  emit("submit", selectedConfigurations.value);
}

function cancel() {
  emit("cancel");
}

defineExpose({
  compatibleConfigurations,
  selectedConfigurations,
  loading,
  search,
  headers,
  dataset,
  updateCompatibleConfigurations,
  submit,
  cancel,
});
</script>
