<template>
  <div class="breadcrumbs">
    <alert-dialog ref="alert" />
    <!-- The breadcrumbs (dataset and configuration) -->
    <v-breadcrumbs :items="items" divider="" class="py-0 mx-2">
      <template #item="{ item }: { item: any }">
        <v-breadcrumbs-item class="breadcrumb-item mx-0 px-1 breadcrumb-span">
          {{ item.title }}
          <!-- If the item has subitems, use a select and an "info" icon -->
          <template v-if="item.subItems">
            <v-select
              :model-value="getCurrentViewItem(item.subItems)"
              @update:model-value="onViewSelect"
              density="compact"
              hide-details
              single-line
              height="1em"
              :items="item.subItems"
              item-title="text"
              item-value="value"
              :menu-props="{
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
              <v-icon size="small" class="nav-icon"
                >mdi-arrow-right-circle-outline</v-icon
              >
            </router-link>
            <v-btn
              v-if="item.title === 'Dataset:' && showExternalLink"
              icon
              size="x-small"
              title="Open in Girder"
              @click="openGirderFolder"
            >
              <v-icon size="small">mdi-open-in-new</v-icon>
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
              size="x-small"
              title="Open in Girder"
              @click="openGirderFolder"
            >
              <v-icon size="small">mdi-open-in-new</v-icon>
            </v-btn>
          </template>
        </v-breadcrumbs-item>
      </template>
    </v-breadcrumbs>

    <!-- Info popover: Owner + Collection on hover -->
    <v-menu
      v-if="currentDatasetId && (ownerDisplayName || collectionDisplayName)"
      open-on-hover
      :open-delay="200"
      :close-delay="300"
      location="bottom"
    >
      <template #activator="{ props: activatorProps }">
        <v-icon
          v-bind="activatorProps"
          size="small"
          class="info-hover-icon mx-1"
        >
          mdi-information-outline
        </v-icon>
      </template>
      <v-card class="pa-3" max-width="300" min-width="200">
        <div v-if="ownerDisplayName" class="mb-2">
          <div class="text-caption text-medium-emphasis">Owner</div>
          <div class="text-body-2">{{ ownerDisplayName }}</div>
        </div>
        <div v-if="collectionDisplayName">
          <div class="text-caption text-medium-emphasis">Collection</div>
          <router-link
            :to="{
              name: 'configuration',
              params: { configurationId: currentConfigurationId },
            }"
            class="text-body-2 text-primary text-decoration-none"
          >
            {{ collectionDisplayName }}
            <v-icon size="x-small" class="ml-1">mdi-arrow-top-right</v-icon>
          </router-link>
        </div>
      </v-card>
    </v-menu>

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
import { ref, computed, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import store, { girderUrlFromApiRoot } from "@/store";
import girderResources from "@/store/girderResources";
import type { RouteLocationRaw } from "vue-router";
import AddDatasetToCollection from "@/components/AddDatasetToCollection.vue";

import { IDatasetConfiguration, IDatasetView } from "@/store/model";
import AlertDialog, { IAlert } from "@/components/AlertDialog.vue";

// Suppress unused import warnings for template-only components
void AlertDialog;

interface IBreadCrumbItem {
  title: string;
  to: RouteLocationRaw;
  text: string;
  subItems?: {
    text: string;
    value: string;
  }[];
}

const route = useRoute();
const router = useRouter();

// Template ref
const alert = ref<any>(null);

const items = ref<IBreadCrumbItem[]>([]);
const currentConfigurationId = ref<string | null>(null);
const currentDatasetId = ref<string | null>(null);
const ownerDisplayName = ref<string | null>(null);
const collectionDisplayName = ref<string | null>(null);

const previousRefreshInfo = ref<{
  datasetId: string | null;
  configurationId: string | null;
  routeName: string | symbol | null | undefined;
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
  const datasetViewId = route.params.datasetViewId;
  if (datasetViewId && typeof datasetViewId === "string") {
    return store.api.getDatasetView(datasetViewId);
  }
  return null;
});

/* eslint-disable vue/no-async-in-computed-properties */
const datasetId = computed((): Promise<string> | null => {
  const paramsId = route.params.datasetId;
  const queryId = route.query.datasetId;
  if (paramsId && typeof paramsId === "string")
    return Promise.resolve(paramsId);
  if (queryId && typeof queryId === "string") return Promise.resolve(queryId);
  if (datasetView.value) {
    return datasetView.value.then(({ datasetId }) => datasetId);
  }
  return null;
});

const configurationId = computed((): Promise<string> | null => {
  const paramsId = route.params.configurationId;
  const queryId = route.query.configurationId;
  if (datasetView.value) {
    return datasetView.value.then(({ configurationId }) => configurationId);
  }
  if (paramsId && typeof paramsId === "string")
    return Promise.resolve(paramsId);
  if (queryId && typeof queryId === "string") return Promise.resolve(queryId);
  return null;
});
/* eslint-enable vue/no-async-in-computed-properties */

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
  ownerDisplayName.value = null;
  collectionDisplayName.value = null;

  if (
    !force &&
    resolvedDatasetId === previousRefreshInfo.value.datasetId &&
    resolvedConfigurationId === previousRefreshInfo.value.configurationId &&
    route.name === previousRefreshInfo.value.routeName
  ) {
    return;
  }
  previousRefreshInfo.value = {
    datasetId: resolvedDatasetId ?? null,
    configurationId: resolvedConfigurationId ?? null,
    routeName: route.name,
  };

  const newItems: IBreadCrumbItem[] = [];
  const datasetParams: Record<string, string> = {};
  const configParams: Record<string, string> = {};
  if (resolvedDatasetId) {
    datasetParams.datasetId = resolvedDatasetId;
  }
  if (resolvedConfigurationId) {
    configParams.configurationId = resolvedConfigurationId;
  }

  let datasetItem: IBreadCrumbItem | undefined;
  if (resolvedDatasetId) {
    const cached = girderResources.watchFolder(resolvedDatasetId);
    datasetItem = {
      title: "Dataset:",
      to: { name: "dataset", params: datasetParams },
      text: cached?.name ?? "Unknown dataset",
    };
    newItems.push(datasetItem);
  }

  let folder;
  if (resolvedDatasetId) {
    folder = await girderResources.getFolder(resolvedDatasetId);
    if (folder && datasetItem) {
      datasetItem.text = folder.name;
    }
  }

  if (resolvedConfigurationId) {
    const cached = girderResources.watchCollection(resolvedConfigurationId);
    if (resolvedDatasetId) {
      // When there's a dataset, store collection name in ref for hover card
      collectionDisplayName.value = cached?.name ?? "Unknown collection";
    } else {
      // Configuration-only route: keep Collection as inline breadcrumb item
      const configurationItem: IBreadCrumbItem = {
        title: "Collection:",
        to: { name: "configuration", params: configParams },
        text: cached?.name ?? "Unknown configuration",
      };
      newItems.push(configurationItem);
    }
  }

  items.value = newItems;

  if (folder?.creatorId) {
    girderResources
      .getUser(folder.creatorId)
      .then((user) => {
        if (user) {
          ownerDisplayName.value = `${user.firstName} ${user.lastName} (${user.email})`;
        }
      })
      .catch(() => {});
  }

  if (datasetItem && resolvedConfigurationId && route.name === "datasetview") {
    const views = await store.api.findDatasetViews({
      configurationId: resolvedConfigurationId,
    });
    if (views.length) {
      // Pre-resolve dataset names for the dropdown items
      const datasetItems = await Promise.all(
        views.map(async (view: IDatasetView) => {
          let text = "Unknown dataset";
          try {
            const resource = await girderResources.getResource({
              id: view.datasetId,
              type: "folder",
            });
            if (resource) {
              text = resource.name;
            }
          } catch {
            // Silently handle errors
          }
          return { text, value: view.id };
        }),
      );

      // Replace the datasetItem in items array with subItems added
      const idx = items.value.indexOf(datasetItem);
      if (idx >= 0) {
        const updated = { ...items.value[idx], subItems: datasetItems };
        const newArr = [...items.value];
        newArr[idx] = updated;
        items.value = newArr;
      }
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
  const { datasetViewId } = route.params;
  if (!datasetViewId) return null;
  return subitems.find((subitem) => subitem.value === datasetViewId) || null;
}

function onViewSelect(val: unknown) {
  const id = typeof val === "string" ? val : (val as any)?.value;
  if (id) goToView(id);
}

function goToView(datasetViewId: string) {
  const currentDatasetViewId = route.params?.datasetViewId;
  if (currentDatasetViewId === datasetViewId) return;
  router.push({
    name: "datasetview",
    params: { datasetViewId },
    query: { ...route.query },
  });
}

watch([datasetId, configurationId], () => refreshItems());

watch(
  configurationResource,
  (resource) => {
    if (resource == null && currentConfigurationId.value) {
      girderResources.forceFetchResource({
        id: currentConfigurationId.value,
        type: "upenn_collection",
      });
      return;
    }
    if (resource?.name) {
      collectionDisplayName.value = resource.name;
      // Also update inline breadcrumb item if present (configuration-only route)
      const item = items.value.find((i) => i.title === "Collection:");
      if (item) {
        item.text = resource.name;
      }
    }
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
  ownerDisplayName,
  collectionDisplayName,
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
  display: flex;
  align-items: center;
  overflow: hidden;
  white-space: nowrap;
}

.info-hover-icon {
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.15s ease;
  &:hover {
    opacity: 1;
  }
}

.nav-icon {
  opacity: 0.7;
  transition: opacity 0.15s ease;
  &:hover {
    opacity: 1;
  }
}

.breadcrumb-select {
  min-width: 8em;
  max-width: 20em;
  flex-shrink: 1;
}

.breadcrumb-select :deep(.v-field__input) {
  padding-top: 0;
  padding-bottom: 0;
  min-height: auto;
}

.breadcrumb-select :deep(.v-field__append-inner) {
  padding-top: 0;
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
