<template>
  <v-app id="inspire" v-mousetrap="appHotkeys">
    <v-dialog v-model="helpPanelIsOpen" width="inherit">
      <help-panel />
    </v-dialog>
    <v-app-bar class="elevation-1" app clipped-right>
      <span v-tooltip="{ content: 'NimbusImage home', open_delay: 500 }">
        <v-toolbar-title @click="goHome" class="logo">
          <img
            src="/img/icons/NimbusImageIcon.png"
            alt="Icon"
            class="logo-icon"
          />
        </v-toolbar-title>
      </span>
      <h1 v-if="routeName === 'root'" class="text-h4 font-weight-bold ml-4">
        NimbusImage
      </h1>
      <bread-crumbs />
      <v-spacer />
      <span v-tooltip="'Upload a new dataset'">
        <v-btn
          color="primary"
          class="ml-4"
          @click="goToNewDataset"
          :disabled="!store.isLoggedIn || !store.girderUser"
          :loading="isUploadLoading"
        >
          Upload Data
        </v-btn>
      </span>
      <v-divider class="ml-1" vertical />
      <template v-if="store.dataset && routeName === 'datasetview'">
        <span
          v-tooltip="
            'List of all objects in the dataset, including their properties, and various actions on them'
          "
        >
          <v-btn
            class="ml-4"
            @click.stop="toggleRightPanel('annotationPanel')"
            id="object-list-button-tourstep"
            v-tour-trigger="'object-list-button-tourtrigger'"
          >
            Object list
          </v-btn>
        </span>
        <v-divider class="ml-4" vertical />
        <span
          v-tooltip="
            'Snapshots for bookmarking and downloading cropped regions in your dataset'
          "
        >
          <v-btn
            class="ml-4"
            @click.stop="toggleRightPanel('snapshotPanel')"
            id="snapshots-button-tourstep"
            v-tour-trigger="'snapshots-button-tourtrigger'"
          >
            Snapshots
          </v-btn>
        </span>
        <span v-tooltip="'Image and object display settings'">
          <v-btn
            class="ml-4"
            @click.stop="toggleRightPanel('settingsPanel')"
            id="settings-button-tourstep"
            v-tour-trigger="'settings-button-tourtrigger'"
          >
            Settings
          </v-btn>
        </span>
      </template>
      <div class="mx-4 d-flex align-center">
        <v-menu offset-y>
          <template v-slot:activator="{ on, attrs }">
            <v-btn
              icon
              v-bind="attrs"
              v-on="on"
              id="help-button-tourstep"
              v-tour-trigger="'help-button-tourtrigger'"
            >
              <v-icon>mdi-help-circle-outline</v-icon>
            </v-btn>
          </template>

          <v-card min-width="300">
            <v-list>
              <!-- HUD Option -->
              <v-list-item @click="toggleHelpDialogUsingHotkey">
                <v-list-item-icon>
                  <v-icon>mdi-view-dashboard-outline</v-icon>
                </v-list-item-icon>
                <v-list-item-content>
                  <v-list-item-title
                    >Show heads up display (tab)</v-list-item-title
                  >
                </v-list-item-content>
              </v-list-item>

              <v-divider></v-divider>

              <!-- Documentation Link -->
              <v-list-item href="https://docs.nimbusimage.com" target="_blank">
                <v-list-item-icon>
                  <v-icon>mdi-book-open-variant</v-icon>
                </v-list-item-icon>
                <v-list-item-content>
                  <v-list-item-title>Documentation</v-list-item-title>
                </v-list-item-content>
              </v-list-item>

              <v-divider></v-divider>

              <!-- Search Box -->
              <v-list-item @click.stop>
                <v-text-field
                  v-model="tourSearch"
                  label="Search tours"
                  dense
                  hide-details
                  prepend-inner-icon="mdi-magnify"
                  clearable
                  @click.stop
                  @click:clear.stop
                ></v-text-field>
              </v-list-item>

              <!-- Tours List -->
              <template v-for="(tours, category) in filteredToursByCategory">
                <v-subheader :key="category">{{ category }}</v-subheader>
                <v-list-item
                  v-for="(tour, tourId) in tours"
                  :key="tourId"
                  @click="handleTourStart(tourId)"
                >
                  <v-list-item-icon v-if="tour.popular">
                    <v-icon color="yellow darken-2">mdi-star</v-icon>
                  </v-list-item-icon>
                  <v-list-item-content>
                    <v-list-item-title>{{ tour.name }}</v-list-item-title>
                  </v-list-item-content>
                </v-list-item>
              </template>
            </v-list>
          </v-card>
        </v-menu>
        <server-status />
        <user-menu />
        <span
          v-tooltip="
            'Open NimbusImage chat for help with solving your particular image analysis problems'
          "
        >
          <v-btn
            icon
            @click="chatbotOpen = !chatbotOpen"
            id="chat-button-tourstep"
            v-tour-trigger="'chat-button-tourtrigger'"
          >
            <v-icon>mdi-chat</v-icon>
          </v-btn>
        </span>
      </div>
    </v-app-bar>

    <chat-component v-if="chatbotOpen" @close="chatbotOpen = false" />

    <v-main>
      <router-view />
    </v-main>

    <v-navigation-drawer
      v-model="analyzePanel"
      app
      right
      disable-resize-watcher
      clipped
      hide-overlay
      :width="480"
    >
      <analyze-annotations />
    </v-navigation-drawer>

    <v-navigation-drawer
      v-model="settingsPanel"
      app
      right
      disable-resize-watcher
      clipped
      hide-overlay
      :width="480"
    >
      <annotations-settings />
    </v-navigation-drawer>

    <v-navigation-drawer
      v-model="snapshotPanel"
      app
      right
      disable-resize-watcher
      clipped
      hide-overlay
      :width="480"
      @transitionend="snapshotPanelFull = snapshotPanel"
    >
      <snapshots :snapshotVisible="snapshotPanel && snapshotPanelFull" />
    </v-navigation-drawer>

    <v-navigation-drawer
      v-model="annotationPanel"
      app
      right
      disable-resize-watcher
      clipped
      hide-overlay
      :width="640"
    >
      <annotation-browser></annotation-browser>
    </v-navigation-drawer>
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, getCurrentInstance, Ref } from "vue";
import axios from "axios";
import UserMenu from "./layout/UserMenu.vue";
import ServerStatus from "./components/ServerStatus.vue";
import AnalyzeAnnotations from "./components/AnalyzePanel.vue";
import AnnotationsSettings from "./components/SettingsPanel.vue";
import Snapshots from "./components/Snapshots.vue";
import AnnotationBrowser from "@/components/AnnotationBrowser/AnnotationBrowser.vue";
import HelpPanel from "./components/HelpPanel.vue";
import BreadCrumbs from "./layout/BreadCrumbs.vue";
import store from "@/store";
import propertyStore from "@/store/properties";
import { logError } from "@/utils/log";
import { IHotkey } from "@/utils/v-mousetrap";
import ChatComponent from "@/components/ChatComponent.vue";
import { IGirderFolder } from "@/girder";
import { ITourMetadata } from "./store/model";

// Suppress unused import warnings for template-only components
void UserMenu;
void ServerStatus;
void AnalyzeAnnotations;
void AnnotationsSettings;
void Snapshots;
void AnnotationBrowser;
void HelpPanel;
void BreadCrumbs;
void ChatComponent;

const vm = getCurrentInstance()!.proxy;

const tourSearch = ref("");
const availableTours = ref<Record<string, ITourMetadata>>({});

const snapshotPanel = ref(false);
const snapshotPanelFull = ref(false);
const annotationPanel = ref(false);
const settingsPanel = ref(false);
const analyzePanel = ref(false);
const chatbotOpen = ref(false);

const lastModifiedRightPanel = ref<string | null>(null);
const isUploadLoading = ref(false);
const helpPanelIsOpen = ref(false);

const panelRefs: Record<string, Ref<boolean>> = {
  snapshotPanel,
  annotationPanel,
  settingsPanel,
  analyzePanel,
  chatbotOpen,
};

function toggleHelpDialogUsingHotkey() {
  helpPanelIsOpen.value = !helpPanelIsOpen.value;
}

const appHotkeys: IHotkey = {
  bind: "tab",
  handler: toggleHelpDialogUsingHotkey,
  data: {
    section: "Global",
    description: "Toggle help dialog",
  },
};

function fetchConfig() {
  axios
    .get("config/templates.json")
    .then((resp) => {
      store.setToolTemplateList(resp.data);
    })
    .catch((err) => {
      logError(err);
      throw err;
    });
}

async function loadAllTours() {
  availableTours.value = await (vm as any).$loadAllTours();
}

function goHome() {
  vm.$router.push({ name: "root" });
}

function toggleRightPanel(panel: string | null) {
  if (panel !== null) {
    panelRefs[panel].value = !panelRefs[panel].value;
  }
  if (
    lastModifiedRightPanel.value !== null &&
    lastModifiedRightPanel.value !== panel
  ) {
    panelRefs[lastModifiedRightPanel.value].value = false;
  }
  lastModifiedRightPanel.value = panel;
}

const routeName = computed(() => vm.$route.name);

const hasUncomputedProperties = computed(() => {
  const uncomputed = propertyStore.uncomputedAnnotationsPerProperty;
  for (const id in uncomputed) {
    if (uncomputed[id].length > 0) {
      return true;
    }
  }
  return false;
});

const filteredToursByCategory = computed(
  (): Record<string, Record<string, ITourMetadata>> => {
    const tours = availableTours.value;
    const filtered = Object.entries(tours).filter(([, tour]) => {
      const matchesSearch = tour.name
        .toLowerCase()
        .includes(tourSearch.value.toLowerCase());

      const isDatasetTour = tour.entryPoint === "datasetview";
      const isDatasetView = routeName.value === "datasetview";
      const isAllowedOnCurrentRoute = isDatasetView || !isDatasetTour;

      return matchesSearch && isAllowedOnCurrentRoute;
    });

    return filtered.reduce(
      (acc: Record<string, Record<string, ITourMetadata>>, [id, tour]) => {
        const category = tour.category || "General";
        if (!acc[category]) {
          acc[category] = {};
        }
        acc[category][id] = tour;
        return acc;
      },
      {},
    );
  },
);

function handleTourStart(tourId: string) {
  const tour = availableTours.value[tourId];
  if (tour && tour.entryPoint !== routeName.value) {
    vm.$router.push({ name: tour.entryPoint });
  }
  (vm as any).$startTour(tourId);
}

async function goToNewDataset() {
  if (isUploadLoading.value) return;

  isUploadLoading.value = true;

  let privateFolder: IGirderFolder | null = null;
  try {
    privateFolder = await store.api.getUserPrivateFolder();
    if (!privateFolder) {
      throw new Error("Could not access private folder");
    }
  } catch (error) {
    logError(error);
  } finally {
    vm.$router.push({
      name: "newdataset",
      params: {
        quickupload: false,
        defaultFiles: [],
        initialUploadLocation: privateFolder,
      } as any,
    });
    isUploadLoading.value = false;
  }
}

function annotationPanelChanged() {
  store.setIsAnnotationPanelOpen(annotationPanel.value);
}

function datasetChanged() {
  if (routeName.value !== "datasetview") {
    toggleRightPanel(null);
  }
}

watch(annotationPanel, () => annotationPanelChanged());
watch(routeName, () => datasetChanged());

onMounted(() => {
  fetchConfig();
  loadAllTours();
});

defineExpose({
  tourSearch,
  availableTours,
  snapshotPanel,
  snapshotPanelFull,
  annotationPanel,
  settingsPanel,
  analyzePanel,
  chatbotOpen,
  lastModifiedRightPanel,
  isUploadLoading,
  helpPanelIsOpen,
  appHotkeys,
  routeName,
  hasUncomputedProperties,
  filteredToursByCategory,
  fetchConfig,
  loadAllTours,
  goHome,
  toggleRightPanel,
  toggleHelpDialogUsingHotkey,
  handleTourStart,
  goToNewDataset,
});
</script>
<style lang="scss" scoped>
.logo {
  cursor: pointer;
  text-overflow: unset;
  overflow: unset;
}
</style>
<style lang="scss">
body > div {
  overflow: hidden;
}

.v-navigation-drawer {
  z-index: 100;
}

.logo-icon {
  height: 50px;

  margin-top: 10px;
}

.v-menu__content {
  z-index: 10000 !important;
}
</style>
