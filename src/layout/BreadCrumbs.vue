<template>
  <div class="breadcrumbs">
    <alert-dialog ref="alert" />
    <!-- The breadcrumbs (dataset and configuration) -->
    <v-breadcrumbs :items="items" divider="" class="py-0 mx-2">
      <template #item="{ item }">
        <v-breadcrumbs-item class="breadcrumb-item mx-0 px-1 breadcrumb-span">
          {{ item.title }}
          <!-- If the item has subitems, use a select and an "info" icon -->
          <template v-if="item.subItems">
            <v-select
              :value="getCurrentViewItem(item.subItems)"
              @input="goToView"
              dense
              hide-details
              single-line
              height="1em"
              :items="item.subItems"
              :menu-props="{
                offsetY: true,
                closeOnClick: true,
                closeOnContentClick: true,
              }"
              class="body-2 ml-2 breadcrumb-select"
            >
              <template
                #append-item
                v-if="item.to.name == 'dataset' && configurationId"
              >
                <v-divider class="my-1" />
                <div
                  class="clickable-flex justify-center body-2"
                  @click="openAddDatasetDialog(configurationId)"
                >
                  <v-icon class="pr-2" color="primary">mdi-plus-circle</v-icon>
                  Add a dataset to this collection
                </div>
              </template>
            </v-select>
            <router-link :to="item.to">
              <v-icon>mdi-information</v-icon>
            </router-link>
            <v-btn
              v-if="item.title === 'Dataset:' && showExternalLink"
              icon
              x-small
              title="Open in Girder"
              @click="openGirderFolder"
            >
              <v-icon small>mdi-open-in-new</v-icon>
            </v-btn>
          </template>
          <!-- Otherwise, simply make the item clickable -->
          <template v-else>
            <span class="px-2" v-if="item.to?.name">
              <router-link :to="item.to">
                {{ item.text }}
              </router-link>
            </span>
            <span class="px-2" v-else>
              {{ item.text }}
            </span>
            <v-btn
              v-if="item.title === 'Dataset:' && showExternalLink"
              icon
              x-small
              title="Open in Girder"
              @click="openGirderFolder"
            >
              <v-icon small>mdi-open-in-new</v-icon>
            </v-btn>
          </template>
        </v-breadcrumbs-item>
      </template>
    </v-breadcrumbs>

    <!-- Dialog to add a dataset to the current collection -->
    <v-dialog
      content-class="smart-overflow"
      v-model="addDatasetFlag"
      width="60%"
    >
      <add-dataset-to-collection
        v-if="addDatasetCollection"
        :collection="addDatasetCollection"
        @addedDatasets="addedDatasets"
        @done="addDatasetFlag = false"
        @warning="openAlert({ type: 'warning', message: $event })"
        @error="openAlert({ type: 'error', message: $event })"
      />
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, getCurrentInstance } from "vue";
import store, { girderUrlFromApiRoot } from "@/store";
import girderResources from "@/store/girderResources";
import { Location } from "vue-router";
import AddDatasetToCollection from "@/components/AddDatasetToCollection.vue";

import { IDatasetConfiguration, IDatasetView } from "@/store/model";
import AlertDialog, { IAlert } from "@/components/AlertDialog.vue";

// Suppress unused import warnings for template-only components
void AlertDialog;

interface IBreadCrumbItem {
  title: string;
  to: Location;
  text: string;
  subItems?: {
    text: string;
    value: string;
  }[];
}

const vm = getCurrentInstance()!.proxy;

// Template ref
const alert = ref<any>(null);

const items = ref<IBreadCrumbItem[]>([]);
const currentConfigurationId = ref<string | null>(null);
const currentDatasetId = ref<string | null>(null);

const previousRefreshInfo = ref<{
  datasetId: string | null;
  configurationId: string | null;
  routeName: string | null | undefined;
}>({
  datasetId: null,
  configurationId: null,
  routeName: null,
});

const addDatasetCollection = ref<IDatasetConfiguration | null>(null);

const configurationResource = computed(() =>
  currentConfigurationId.value
    ? girderResources.watchCollection(currentConfigurationId.value)
    : undefined,
);

const datasetResource = computed(() =>
  currentDatasetId.value
    ? girderResources.watchFolder(currentDatasetId.value)
    : undefined,
);

const addDatasetFlag = computed({
  get: () => addDatasetCollection.value !== null,
  set: (val: boolean) => {
    if (!val) {
      addDatasetCollection.value = null;
    }
  },
});

const datasetView = computed(() => {
  const { datasetViewId } = vm.$route.params;
  if (datasetViewId) {
    return store.api.getDatasetView(datasetViewId);
  }
  return null;
});

// eslint-disable-next-line vue/no-async-in-computed-properties
const datasetId = computed((): Promise<string> | null => {
  const paramsId = vm.$route.params.datasetId;
  const queryId = vm.$route.query.datasetId;
  if (paramsId) return Promise.resolve(paramsId);
  if (queryId && typeof queryId === "string") return Promise.resolve(queryId);
  if (datasetView.value) {
    return datasetView.value.then(({ datasetId }) => datasetId);
  }
  return null;
});

// eslint-disable-next-line vue/no-async-in-computed-properties
const configurationId = computed((): Promise<string> | null => {
  const paramsId = vm.$route.params.configurationId;
  const queryId = vm.$route.query.configurationId;
  if (datasetView.value) {
    return datasetView.value.then(({ configurationId }) => configurationId);
  }
  if (paramsId) return Promise.resolve(paramsId);
  if (queryId && typeof queryId === "string") return Promise.resolve(queryId);
  return null;
});

const showExternalLink = computed(
  () => store.isAdmin && currentDatasetId.value !== null,
);

const girderDatasetUrl = computed((): string | null => {
  if (!currentDatasetId.value || !datasetResource.value?.creatorId) {
    return null;
  }
  const baseUrl = girderUrlFromApiRoot(store.girderRest.apiRoot);
  return `${baseUrl}/#user/${datasetResource.value.creatorId}/folder/${currentDatasetId.value}`;
});

function openAlert(alertData: IAlert) {
  addDatasetFlag.value = false;
  alert.value.openAlert(alertData);
}

async function setItemTextWithResourceName(
  item: { text: string },
  id: string,
  type: "item" | "folder" | "user" | "upenn_collection",
) {
  if (type === "user") {
    try {
      const user = await girderResources.getUser(id);
      if (user) {
        item.text = `${user.firstName} ${user.lastName} (${user.email})`;
      }
    } catch (error) {
      // Silently handle errors (e.g., 401 when not logged in)
    }
  } else {
    try {
      const resource = await girderResources.getResource({ id, type });
      if (resource) {
        item.text = resource.name;
      }
    } catch (error) {
      // Silently handle errors
    }
  }
}

async function openAddDatasetDialog(configIdPromise: Promise<string>) {
  addDatasetCollection.value = await girderResources.getConfiguration(
    await configIdPromise,
  );
}

function addedDatasets(_datasetIds: string[], datasetViews: IDatasetView[]) {
  refreshItems(true);
  addDatasetFlag.value = false;
  if (datasetViews[0]) {
    goToView(datasetViews[0].id);
  }
}

async function refreshItems(force = false) {
  const [resolvedConfigurationId, resolvedDatasetId] = await Promise.all([
    configurationId.value,
    datasetId.value,
  ]);

  currentConfigurationId.value = resolvedConfigurationId || null;
  currentDatasetId.value = resolvedDatasetId || null;

  if (
    !force &&
    resolvedDatasetId === previousRefreshInfo.value.datasetId &&
    resolvedConfigurationId === previousRefreshInfo.value.configurationId &&
    vm.$route.name === previousRefreshInfo.value.routeName
  ) {
    return;
  }
  previousRefreshInfo.value = {
    datasetId: resolvedDatasetId ?? null,
    configurationId: resolvedConfigurationId ?? null,
    routeName: vm.$route.name,
  };

  const newItems: IBreadCrumbItem[] = [];
  const params: { [key: string]: string } = {};
  if (resolvedDatasetId) {
    params.datasetId = resolvedDatasetId;
  }
  if (resolvedConfigurationId) {
    params.configurationId = resolvedConfigurationId;
  }

  let datasetItem: IBreadCrumbItem | undefined;
  if (resolvedDatasetId) {
    const cached = girderResources.watchFolder(resolvedDatasetId);
    datasetItem = {
      title: "Dataset:",
      to: { name: "dataset", params },
      text: cached?.name ?? "Unknown dataset",
    };
    newItems.push(datasetItem);
  }

  let folder;
  if (resolvedDatasetId) {
    folder = await girderResources.getFolder(resolvedDatasetId);
  }

  if (folder?.creatorId) {
    const ownerItem: IBreadCrumbItem = {
      title: "Owner:",
      to: {} as Location,
      text: "Unknown owner",
    };
    newItems.push(ownerItem);
  }

  if (resolvedConfigurationId) {
    const cached = girderResources.watchCollection(resolvedConfigurationId);
    const configurationItem: IBreadCrumbItem = {
      title: "Collection:",
      to: { name: "configuration", params },
      text: cached?.name ?? "Unknown configuration",
    };
    newItems.push(configurationItem);
  }

  items.value = newItems;

  if (folder?.creatorId) {
    const ownerItem = newItems.find((item) => item.title === "Owner:");
    if (ownerItem) {
      setItemTextWithResourceName(ownerItem, folder.creatorId, "user");
    }
  }

  if (
    datasetItem &&
    resolvedConfigurationId &&
    vm.$route.name === "datasetview"
  ) {
    const views = await store.api.findDatasetViews({
      configurationId: resolvedConfigurationId,
    });
    if (views.length) {
      const datasetItems = views.map((view: IDatasetView) => ({
        text: "Unknown dataset",
        value: view.id,
      }));

      // Replace the datasetItem in items array with subItems added
      const idx = items.value.indexOf(datasetItem);
      if (idx >= 0) {
        const updated = { ...items.value[idx], subItems: datasetItems };
        const newArr = [...items.value];
        newArr[idx] = updated;
        items.value = newArr;
      }

      datasetItems.forEach((viewItem: { text: string; value: string }) => {
        const view = views.find((v: IDatasetView) => v.id === viewItem.value);
        if (view) {
          setItemTextWithResourceName(viewItem, view.datasetId, "folder");
        }
      });
    }
  }
}

function handleResourceChange(
  resource: any,
  itemTitle: string,
  currentId: string | null,
  resourceType: "upenn_collection" | "folder",
) {
  const item = items.value.find((item) => item.title === itemTitle);
  if (!item) return;

  if (resource == null && currentId) {
    girderResources.forceFetchResource({
      id: currentId,
      type: resourceType,
    });
    return;
  }

  if (resource?.name) {
    item.text = resource.name;
  }
}

function openGirderFolder() {
  if (girderDatasetUrl.value) {
    window.open(girderDatasetUrl.value, "_blank");
  }
}

function getCurrentViewItem(subitems: IBreadCrumbItem["subItems"]) {
  if (!subitems) return null;
  const { datasetViewId } = vm.$route.params;
  if (!datasetViewId) return null;
  return subitems.find((subitem) => subitem.value === datasetViewId) || null;
}

function goToView(datasetViewId: string) {
  const currentDatasetViewId = vm.$route.params?.datasetViewId;
  if (currentDatasetViewId === datasetViewId) return;
  vm.$router.push({
    name: "datasetview",
    params: { datasetViewId },
    query: { ...vm.$route.query },
  });
}

watch([datasetId, configurationId], () => refreshItems());

watch(
  configurationResource,
  (resource) => {
    handleResourceChange(
      resource,
      "Collection:",
      currentConfigurationId.value,
      "upenn_collection",
    );
  },
  { immediate: true },
);

watch(
  datasetResource,
  (resource) => {
    handleResourceChange(
      resource,
      "Dataset:",
      currentDatasetId.value,
      "folder",
    );
  },
  { immediate: true },
);

onMounted(() => {
  refreshItems();
});

defineExpose({
  items,
  currentConfigurationId,
  currentDatasetId,
  addDatasetCollection,
  addDatasetFlag,
  configurationResource,
  datasetResource,
  datasetView,
  datasetId,
  configurationId,
  showExternalLink,
  girderDatasetUrl,
  refreshItems,
  openAlert,
  openAddDatasetDialog,
  addedDatasets,
  openGirderFolder,
  getCurrentViewItem,
  goToView,
});
</script>

<style lang="scss" scoped>
.breadcrumbs {
  overflow: hidden;
  white-space: nowrap;
}

.breadcrumb-select input {
  width: 20px;
}

.breadcrumb-select {
  min-width: 0;
}

.breadcrumb-span {
  display: flex;
  max-width: max-content;
  overflow: hidden;
}

.breadcrumb-item {
  max-width: 100%;
}
</style>

<style lang="scss">
.breadcrumb-item .v-breadcrumbs__item {
  max-width: inherit;
}

.v-alert__content {
  min-width: 0;
}
</style>
