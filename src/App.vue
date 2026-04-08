<template>
  <v-app id="inspire" v-mousetrap="appHotkeys">
    <v-dialog
      v-model="helpPanelIsOpen"
      fullscreen
      scrim="transparent"
      transition="fade-transition"
      content-class="help-dialog-overlay"
    >
      <help-panel @close="helpPanelIsOpen = false" />
    </v-dialog>
    <v-app-bar>
      <v-tooltip text="NimbusImage home" :open-delay="500">
        <template v-slot:activator="{ props: activatorProps }">
          <v-toolbar-title v-bind="activatorProps" @click="goHome" class="logo">
            <svg
              class="logo-icon"
              viewBox="0 0 652 397"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <!-- Cloud body -->
              <path d="M145 253H529V393H145V253Z" fill="#E68A82" />
              <path
                d="M517.5 132C589.573 132 648 190.427 648 262.5C648 334.573 589.573 393 517.5 393C445.427 393 387 334.573 387 262.5C387 190.427 445.427 132 517.5 132Z"
                fill="#E68A82"
                stroke="#E47F78"
                stroke-width="8"
              />
              <path
                d="M316 4C408.232 4 483 78.7684 483 171C483 263.232 408.232 338 316 338C223.768 338 149 263.232 149 171C149 78.7684 223.768 4 316 4Z"
                fill="#E68A82"
                stroke="#E2756D"
                stroke-width="8"
              />
              <path
                d="M144.5 112C222.096 112 285 174.904 285 252.5C285 281.272 276.356 308.013 261.523 330.282C236.337 368.097 193.326 393 144.5 393C66.904 393 4 330.096 4 252.5C4 174.904 66.904 112 144.5 112Z"
                fill="#E68A82"
                stroke="#DE5F58"
                stroke-width="8"
              />
              <!-- Bird 1 (upper) -->
              <path
                class="bird bird-1"
                style="--ox: 275px; --oy: 112.5px"
                d="M296.5 65C278.487 80.4216 275.786 105.031 275 112.5C261.06 101.512 237.881 100.75 228 100.5"
                stroke="black"
                stroke-width="2"
                stroke-linecap="round"
                vector-effect="non-scaling-stroke"
              />
              <!-- Bird 2 (lower) -->
              <path
                class="bird bird-2"
                style="--ox: 492.5px; --oy: 341.5px"
                d="M445.5 319C454.5 320.667 476.5 327.5 492.5 341.5C505.7 323.5 528 315.333 537.5 313.5"
                stroke="black"
                stroke-width="2"
                stroke-linecap="round"
                vector-effect="non-scaling-stroke"
              />
              <!-- Cloud outline strokes -->
              <path
                d="M316 4C408.232 4 483 78.7684 483 171C483 263.232 408.232 338 316 338C223.768 338 149 263.232 149 171C149 78.7684 223.768 4 316 4Z"
                stroke="#E37C74"
                stroke-width="8"
              />
              <path
                d="M517.5 132C589.573 132 648 190.427 648 262.5C648 334.573 589.573 393 517.5 393C445.427 393 387 334.573 387 262.5C387 190.427 445.427 132 517.5 132Z"
                stroke="#E4827A"
                stroke-width="8"
              />
              <path
                d="M144.5 112C222.096 112 285 174.904 285 252.5C285 281.272 276.356 308.013 261.523 330.282C236.337 368.097 193.326 393 144.5 393C66.904 393 4 330.096 4 252.5C4 174.904 66.904 112 144.5 112Z"
                stroke="#DE5F58"
                stroke-width="8"
              />
              <path
                d="M146.727 393C67.9011 393 4 329.609 4 251.412C4 173.215 67.9011 109.824 146.727 109.824C150.811 109.824 154.855 109.994 158.853 110.327C183.5 48.073 244.623 4 316.123 4C396.348 4 463.51 59.4864 480.739 133.885C491.714 130.973 503.25 129.421 515.15 129.421C588.521 129.421 648 188.425 648 261.21C648 333.996 588.521 393 515.15 393"
                stroke="#DE5F58"
                stroke-width="8"
              />
              <path d="M144 393H518" stroke="#DE5F58" stroke-width="8" />
            </svg>
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
        <v-tooltip
          text="List of all objects in the dataset, including their properties, and various actions on them"
        >
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              class="ml-4"
              :color="annotationPanel ? 'primary' : undefined"
              :variant="annotationPanel ? 'tonal' : 'text'"
              @click.stop="toggleRightPanel('annotationPanel')"
              id="object-list-button-tourstep"
              v-tour-trigger="'object-list-button-tourtrigger'"
            >
              Object list
            </v-btn>
          </template>
        </v-tooltip>
        <v-divider class="ml-4" vertical />
        <v-tooltip
          text="Snapshots for bookmarking and downloading cropped regions in your dataset"
        >
          <template v-slot:activator="{ props: activatorProps }">
            <v-btn
              v-bind="activatorProps"
              class="ml-4"
              :color="snapshotPanel ? 'primary' : undefined"
              :variant="snapshotPanel ? 'tonal' : 'text'"
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
              :color="settingsPanel ? 'primary' : undefined"
              :variant="settingsPanel ? 'tonal' : 'text'"
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
                <template #prepend>
                  <v-icon>mdi-view-dashboard-outline</v-icon>
                </template>
                <v-list-item-title
                  >Show heads up display (tab)</v-list-item-title
                >
              </v-list-item>

              <v-divider></v-divider>

              <!-- Documentation Link -->
              <v-list-item href="https://docs.nimbusimage.com" target="_blank">
                <template #prepend>
                  <v-icon>mdi-book-open-variant</v-icon>
                </template>
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
              <template
                v-for="(tours, category) in filteredToursByCategory"
                :key="category"
              >
                <v-list-subheader>{{ category }}</v-list-subheader>
                <v-list-item
                  v-for="(tour, tourId) in tours"
                  :key="tourId"
                  @click="handleTourStart(tourId)"
                >
                  <template #prepend v-if="tour.popular">
                    <v-icon color="yellow-darken-2">mdi-star</v-icon>
                  </template>
                  <v-list-item-title>{{ tour.name }}</v-list-item-title>
                </v-list-item>
              </template>
            </v-list>
          </v-card>
        </v-menu>
        <server-status />
        <user-menu />
        <v-tooltip
          text="Open NimbusImage chat for help with solving your particular image analysis problems"
        >
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
      :mobile="false"
    >
      <analyze-annotations />
    </v-navigation-drawer>

    <v-navigation-drawer
      v-model="settingsPanel"
      location="right"
      :scrim="false"
      :width="480"
      :mobile="false"
    >
      <annotations-settings />
    </v-navigation-drawer>

    <v-navigation-drawer
      v-model="snapshotPanel"
      location="right"
      :scrim="false"
      :width="480"
      :mobile="false"
      @transitionend="snapshotPanelFull = snapshotPanel"
    >
      <snapshots :snapshotVisible="snapshotPanel && snapshotPanelFull" />
    </v-navigation-drawer>

    <v-navigation-drawer
      v-model="annotationPanel"
      location="right"
      :scrim="false"
      :width="640"
      :mobile="false"
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
    store.initializeUploadWorkflow({
      quickupload: false,
      batchMode: false,
      batchName: "",
      fileGroups: [],
      datasetNames: [],
      initialUploadLocation: privateFolder,
      initialName: "",
      initialDescription: "",
    });
    router.push({ name: "newdataset" });
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
  flex: 0 0 auto;
}
</style>
<style lang="scss">
body > div {
  overflow: hidden;
}

/* Vuetify 3 defaults --v-list-prepend-gap to 32px, which is too wide for
   most lists in this app. Override globally to a tighter 8px. Individual
   components can still override via the same CSS variable if needed. */
.v-list {
  --v-list-prepend-gap: 8px;
}

.v-navigation-drawer {
  z-index: 100;
}

.logo-icon {
  height: 50px;
  margin-top: 10px;
}

.logo-icon .bird {
  transform-origin: var(--ox) var(--oy);
}

.logo:hover .bird-1 {
  animation: flap-top 1.8s ease-in-out infinite;
}

.logo:hover .bird-2 {
  animation: flap-bottom 1.8s ease-in-out infinite 0.4s;
}

@keyframes flap-top {
  0%,
  100% {
    transform: rotate(-25deg) scaleY(1) rotate(25deg);
  }
  25% {
    transform: rotate(-25deg) scaleY(0.35) rotate(25deg);
  }
  50% {
    transform: rotate(-25deg) scaleY(1.1) rotate(25deg);
  }
  75% {
    transform: rotate(-25deg) scaleY(0.65) rotate(25deg);
  }
}

@keyframes flap-bottom {
  0%,
  100% {
    transform: scaleY(1);
  }
  25% {
    transform: scaleY(0.35);
  }
  50% {
    transform: scaleY(1.1);
  }
  75% {
    transform: scaleY(0.65);
  }
}

.v-menu__content {
  z-index: 10000 !important;
}

.help-dialog-overlay {
  background: transparent;
  box-shadow: none;
  max-height: 100%;
}

/* Secondary text uses nimbus muted token */
.text-grey {
  color: var(--nimbus-text-muted);
}

/* Type-indicator chips use ghost styling */
.type-indicator.v-chip {
  background: var(--nimbus-glass) !important;
  color: var(--nimbus-text-secondary);
}
</style>
