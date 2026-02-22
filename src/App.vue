<template>
  <v-app id="inspire" v-mousetrap="appHotkeys">
    <v-dialog v-model="helpPanelIsOpen" width="inherit">
      <help-panel />
    </v-dialog>
    <v-app-bar class="elevation-1">
      <v-tooltip text="NimbusImage home" :open-delay="500">
        <template v-slot:activator="{ props: activatorProps }">
          <v-toolbar-title v-bind="activatorProps" @click="goHome" class="logo">
            <img
              src="/img/icons/NimbusImageIcon.png"
              alt="Icon"
              class="logo-icon"
            />
          </v-toolbar-title>
        </template>
      </v-tooltip>
      <h1 v-if="routeName === 'root'" class="text-h4 font-weight-bold ml-4">
        NimbusImage
      </h1>
      <bread-crumbs />
      <v-spacer />
      <v-tooltip text="Upload a new dataset">
        <template v-slot:activator="{ props: activatorProps }">
          <v-btn
            v-bind="activatorProps"
            color="primary"
            class="ml-4"
            @click="goToNewDataset"
            :disabled="!store.isLoggedIn || !store.girderUser"
            :loading="isUploadLoading"
          >
            Upload Data
          </v-btn>
        </template>
      </v-tooltip>
      <v-divider class="ml-1" vertical />
      <template v-if="store.dataset && routeName === 'datasetview'">
        <v-tooltip text="List of all objects in the dataset, including their properties, and various actions on them">
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              class="ml-4"
              @click.stop="toggleRightPanel('annotationPanel')"
              id="object-list-button-tourstep"
              v-tour-trigger="'object-list-button-tourtrigger'"
            >
              Object list
            </v-btn>
          </template>
        </v-tooltip>
        <v-divider class="ml-4" vertical />
        <v-tooltip text="Snapshots for bookmarking and downloading cropped regions in your dataset">
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              class="ml-4"
              @click.stop="toggleRightPanel('snapshotPanel')"
              id="snapshots-button-tourstep"
              v-tour-trigger="'snapshots-button-tourtrigger'"
            >
              Snapshots
            </v-btn>
          </template>
        </v-tooltip>
        <v-tooltip text="Image and object display settings">
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              class="ml-4"
              @click.stop="toggleRightPanel('settingsPanel')"
              id="settings-button-tourstep"
              v-tour-trigger="'settings-button-tourtrigger'"
            >
              Settings
            </v-btn>
          </template>
        </v-tooltip>
      </template>
      <div class="mx-4 d-flex align-center">
        <v-menu>
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              icon
              v-bind="activatorProps"
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
                <v-icon>mdi-view-dashboard-outline</v-icon>
                <v-list-item-title
                  >Show heads up display (tab)</v-list-item-title
                >
              </v-list-item>

              <v-divider></v-divider>

              <!-- Documentation Link -->
              <v-list-item href="https://docs.nimbusimage.com" target="_blank">
                <v-icon>mdi-book-open-variant</v-icon>
                <v-list-item-title>Documentation</v-list-item-title>
              </v-list-item>

              <v-divider></v-divider>

              <!-- Search Box -->
              <v-list-item @click.stop>
                <v-text-field
                  v-model="tourSearch"
                  label="Search tours"
                  density="compact"
                  hide-details
                  prepend-inner-icon="mdi-magnify"
                  clearable
                  @click.stop
                  @click:clear.stop
                ></v-text-field>
              </v-list-item>

              <!-- Tours List -->
              <template v-for="(tours, category) in filteredToursByCategory" :key="category">
                <v-list-subheader>{{ category }}</v-list-subheader>
                <v-list-item
                  v-for="(tour, tourId) in tours"
                  :key="tourId"
                  @click="handleTourStart(tourId)"
                >
                  <v-icon v-if="tour.popular" color="yellow-darken-2">mdi-star</v-icon>
                  <v-list-item-title>{{ tour.name }}</v-list-item-title>
                </v-list-item>
              </template>
            </v-list>
          </v-card>
        </v-menu>
        <server-status />
        <user-menu />
        <v-tooltip text="Open NimbusImage chat for help with solving your particular image analysis problems">
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              icon
              @click="chatbotOpen = !chatbotOpen"
              id="chat-button-tourstep"
              v-tour-trigger="'chat-button-tourtrigger'"
            >
              <v-icon>mdi-chat</v-icon>
            </v-btn>
          </template>
        </v-tooltip>
      </div>
    </v-app-bar>

    <chat-component v-if="chatbotOpen" @close="chatbotOpen = false" />

    <v-main>
      <router-view />
    </v-main>

    <v-navigation-drawer
      v-model="analyzePanel"
      location="right"
      :scrim="false"
      :width="480"
    >
      <analyze-annotations />
    </v-navigation-drawer>

    <v-navigation-drawer
      v-model="settingsPanel"
      location="right"
      :scrim="false"
      :width="480"
    >
      <annotations-settings />
    </v-navigation-drawer>

    <v-navigation-drawer
      v-model="snapshotPanel"
      location="right"
      :scrim="false"
      :width="480"
      @transitionend="snapshotPanelFull = snapshotPanel"
    >
      <snapshots :snapshotVisible="snapshotPanel && snapshotPanelFull" />
    </v-navigation-drawer>

    <v-navigation-drawer
      v-model="annotationPanel"
      location="right"
      :scrim="false"
      :width="640"
    >
      <annotation-browser></annotation-browser>
    </v-navigation-drawer>
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, Ref } from "vue";
import { useRoute, useRouter } from "vue-router";
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
import { useTour } from "@/utils/useTour";

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

const route = useRoute();
const router = useRouter();
const { startTour, loadAllTours: loadAllToursFromManager } = useTour();

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
  availableTours.value = await loadAllToursFromManager();
}

function goHome() {
  router.push({ name: "root" });
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

const routeName = computed(() => route.name);

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
    router.push({ name: tour.entryPoint });
  }
  startTour(tourId);
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
    router.push({
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
  flex: 0 0 auto !important;
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
