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

<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store, { girderUrlFromApiRoot } from "@/store";
import girderResources from "@/store/girderResources";
import { Location } from "vue-router";
import AddDatasetToCollection from "@/components/AddDatasetToCollection.vue";

import { IDatasetConfiguration, IDatasetView } from "@/store/model";
import AlertDialog, { IAlert } from "@/components/AlertDialog.vue";

interface IBreadCrumbItem {
  title: string;
  to: Location;
  text: string;
  subItems?: {
    text: string;
    value: string;
  }[];
}

@Component({ components: { AddDatasetToCollection, AlertDialog } })
export default class BreadCrumbs extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;

  readonly $refs!: {
    alert: AlertDialog;
  };

  items: IBreadCrumbItem[] = [];
  private currentConfigurationId: string | null = null;
  private currentDatasetId: string | null = null;

  get configurationResource() {
    return this.currentConfigurationId
      ? this.girderResources.watchCollection(this.currentConfigurationId)
      : undefined;
  }

  get datasetResource() {
    return this.currentDatasetId
      ? this.girderResources.watchFolder(this.currentDatasetId)
      : undefined;
  }
  previousRefreshInfo: {
    datasetId: string | null;
    configurationId: string | null;
    routeName: string | null | undefined;
  } = {
    datasetId: null,
    configurationId: null,
    routeName: null,
  };

  addDatasetCollection: IDatasetConfiguration | null = null;

  get addDatasetFlag() {
    return this.addDatasetCollection !== null;
  }

  set addDatasetFlag(val: boolean) {
    if (!val) {
      this.addDatasetCollection = null;
    }
  }

  get datasetView() {
    const { datasetViewId } = this.$route.params;
    if (datasetViewId) {
      return this.store.api.getDatasetView(datasetViewId);
    }
    return null;
  }

  get datasetId(): Promise<string> | null {
    const paramsId = this.$route.params.datasetId;
    const queryId = this.$route.query.datasetId;
    if (paramsId) {
      return Promise.resolve(paramsId);
    }
    if (queryId && typeof queryId === "string") {
      return Promise.resolve(queryId);
    }
    if (this.datasetView) {
      return this.datasetView.then(({ datasetId }) => datasetId);
    }
    return null;
  }

  get configurationId(): Promise<string> | null {
    const paramsId = this.$route.params.configurationId;
    const queryId = this.$route.query.configurationId;
    if (this.datasetView) {
      return this.datasetView.then(({ configurationId }) => configurationId);
    }
    if (paramsId) {
      return Promise.resolve(paramsId);
    }
    if (queryId && typeof queryId === "string") {
      return Promise.resolve(queryId);
    }
    return null;
  }

  mounted() {
    this.refreshItems();
  }

  openAlert(alert: IAlert) {
    this.addDatasetFlag = false;
    this.$refs.alert.openAlert(alert);
  }

  async setItemTextWithResourceName(
    item: { text: string },
    id: string,
    type: "item" | "folder" | "user" | "upenn_collection",
  ) {
    if (type === "user") {
      try {
        const user = await this.girderResources.getUser(id);
        if (user) {
          Vue.set(
            item,
            "text",
            `${user.firstName} ${user.lastName} (${user.email})`,
          );
        }
      } catch (error) {
        // Silently handle errors (e.g., 401 when not logged in)
        // The item text will remain as "Unknown owner" set in refreshItems
      }
    } else {
      try {
        const resource = await this.girderResources.getResource({ id, type });
        if (resource) {
          Vue.set(item, "text", resource.name);
        }
      } catch (error) {
        // Silently handle errors - item text will remain as set initially
      }
    }
  }

  async openAddDatasetDialog(configIdPromise: Promise<string>) {
    this.addDatasetCollection = await this.girderResources.getConfiguration(
      await configIdPromise,
    );
  }

  addedDatasets(_datasetIds: string[], datasetViews: IDatasetView[]) {
    // New datasets have been added to current collection
    this.refreshItems(true);
    // Close the dialog
    this.addDatasetFlag = false;
    // Go to the first dataset view if there is one
    if (datasetViews[0]) {
      this.goToView(datasetViews[0].id);
    }
  }

  @Watch("datasetId")
  @Watch("configurationId")
  async refreshItems(force = false) {
    const [configurationId, datasetId] = await Promise.all([
      this.configurationId,
      this.datasetId,
    ]);

    // Set current IDs early so watchers can start working
    this.currentConfigurationId = configurationId || null;
    this.currentDatasetId = datasetId || null;

    // Cache items if parameters are the same
    // This is useful when route query changes frequently but dataset and configuration don't
    if (
      !force &&
      datasetId === this.previousRefreshInfo.datasetId &&
      configurationId === this.previousRefreshInfo.configurationId &&
      this.$route.name === this.previousRefreshInfo.routeName
    ) {
      return;
    }
    this.previousRefreshInfo.datasetId = datasetId;
    this.previousRefreshInfo.configurationId = configurationId;
    this.previousRefreshInfo.routeName = this.$route.name;

    const newItems: IBreadCrumbItem[] = [];
    const params: { [key: string]: string } = {};
    if (datasetId) {
      params.datasetId = datasetId;
    }
    if (configurationId) {
      params.configurationId = configurationId;
    }

    // Create dataset item
    let datasetItem: IBreadCrumbItem | undefined;
    if (datasetId) {
      // Prefill from cache to avoid flicker
      const cached = this.girderResources.watchFolder(datasetId);
      datasetItem = {
        title: "Dataset:",
        to: { name: "dataset", params },
        text: cached?.name ?? "Unknown dataset",
      };
      newItems.push(datasetItem);
    }

    // Await folder information
    let folder;
    if (datasetId) {
      folder = await this.girderResources.getFolder(datasetId);
    }

    // Add owner item if available
    if (folder?.creatorId) {
      const ownerItem: IBreadCrumbItem = {
        title: "Owner:",
        to: {} as Location,
        text: "Unknown owner",
      };
      newItems.push(ownerItem);
    }

    // Create configuration item
    if (configurationId) {
      // Prefill from cache to avoid flicker
      const cached = this.girderResources.watchCollection(configurationId);
      const configurationItem: IBreadCrumbItem = {
        title: "Collection:",
        to: { name: "configuration", params },
        text: cached?.name ?? "Unknown configuration",
      };
      newItems.push(configurationItem);
    }

    // Update the reactive property just once
    this.items = newItems;

    // Fire off asynchronous text updates without modifying the array structure
    // No longer needed for dataset/configuration - watchers handle them reactively
    if (folder?.creatorId) {
      const ownerItem = newItems.find((item) => item.title === "Owner:");
      if (ownerItem) {
        // getUser() API handles auth checks internally, so no need to check isLoggedIn here
        this.setItemTextWithResourceName(ownerItem, folder.creatorId, "user");
      }
    }

    // Handle dataset view dropdown (moved after items are set)
    if (datasetItem && configurationId && this.$route.name === "datasetview") {
      const views = await this.store.api.findDatasetViews({ configurationId });
      if (views.length) {
        const datasetItems = views.map((view: IDatasetView) => ({
          text: "Unknown dataset",
          value: view.id,
        }));
        Vue.set(datasetItem, "subItems", datasetItems);

        // Update names asynchronously
        datasetItems.forEach((viewItem: { text: string; value: string }) => {
          const view = views.find((v: IDatasetView) => v.id === viewItem.value);
          if (view) {
            this.setItemTextWithResourceName(
              viewItem,
              view.datasetId,
              "folder",
            );
          }
        });
      }
    }
  }

  private handleResourceChange(
    resource: any,
    itemTitle: string,
    currentId: string | null,
    resourceType: "upenn_collection" | "folder",
  ) {
    const item = this.items.find((item) => item.title === itemTitle);
    if (!item) return;

    // Trigger fetch when undefined OR null
    if (resource == null && currentId) {
      this.girderResources.forceFetchResource({
        id: currentId,
        type: resourceType,
      });
      return;
    }

    if (resource?.name) {
      Vue.set(item, "text", resource.name);
    }
  }

  @Watch("configurationResource", { immediate: true })
  onConfigurationResourceChanged(resource: any) {
    this.handleResourceChange(
      resource,
      "Collection:",
      this.currentConfigurationId,
      "upenn_collection",
    );
  }

  @Watch("datasetResource", { immediate: true })
  onDatasetResourceChanged(resource: any) {
    this.handleResourceChange(
      resource,
      "Dataset:",
      this.currentDatasetId,
      "folder",
    );
  }

  get showExternalLink(): boolean {
    return this.store.isAdmin && this.currentDatasetId !== null;
  }

  get girderDatasetUrl(): string | null {
    if (!this.currentDatasetId || !this.datasetResource?.creatorId) {
      return null;
    }
    const baseUrl = girderUrlFromApiRoot(this.store.girderRest.apiRoot);
    return `${baseUrl}/#user/${this.datasetResource.creatorId}/folder/${this.currentDatasetId}`;
  }

  openGirderFolder() {
    if (this.girderDatasetUrl) {
      window.open(this.girderDatasetUrl, "_blank");
    }
  }

  getCurrentViewItem(subitems: IBreadCrumbItem["subItems"]) {
    if (!subitems) {
      return null;
    }
    const { datasetViewId } = this.$route.params;
    if (!datasetViewId) {
      return null;
    }
    return subitems.find((subitem) => subitem.value === datasetViewId) || null;
  }

  goToView(datasetViewId: string) {
    const currentDatasetViewId = this.$route.params?.datasetViewId;
    if (currentDatasetViewId === datasetViewId) {
      return;
    }
    this.$router.push({
      name: "datasetview",
      params: { datasetViewId },
      query: { ...this.$route.query },
    });
  }
}
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
