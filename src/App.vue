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
            'Measure properties of your objects, like \'area\' or \'number of spots\''
          "
        >
          <v-btn class="ml-4" @click.stop="toggleRightPanel('analyzePanel')">
            <v-badge dot color="red" :value="hasUncomputedProperties">
              Measure objects
            </v-badge>
          </v-btn>
        </span>
        <span
          v-tooltip="
            'List of all objects in the dataset, including their properties, and various actions on them'
          "
        >
          <v-btn
            class="ml-4"
            @click.stop="
              toggleRightPanel('annotationPanel');
              annotationPanelBadge = false;
            "
          >
            <v-badge dot color="green" :value="annotationPanelBadge">
              Object list
            </v-badge>
          </v-btn>
        </span>
        <v-divider class="ml-4" vertical />
        <span
          v-tooltip="
            'Snapshots for bookmarking and downloading cropped regions in your dataset'
          "
        >
          <v-btn class="ml-4" @click.stop="toggleRightPanel('snapshotPanel')">
            Snapshots
          </v-btn>
        </span>
        <span v-tooltip="'Image and object display settings'">
          <v-btn class="ml-4" @click.stop="toggleRightPanel('settingsPanel')">
            Settings
          </v-btn>
        </span>
      </template>
      <div class="mx-4 d-flex align-center">
        <span v-tooltip="'Show the heads up display for commands and hotkeys'">
          <v-btn icon @click="helpPanelIsOpen = !helpPanelIsOpen">
            <v-icon>mdi-help-circle-outline</v-icon>
          </v-btn>
        </span>
        <server-status />
        <user-menu />
        <span
          v-tooltip="
            'Open NimbusImage chat for help with solving your particular image analysis problems'
          "
        >
          <v-btn icon @click="chatbotOpen = !chatbotOpen">
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

<script lang="ts">
import axios from "axios";
import UserMenu from "./layout/UserMenu.vue";
import ServerStatus from "./components/ServerStatus.vue";
import AnalyzeAnnotations from "./components/AnalyzePanel.vue";
import AnnotationsSettings from "./components/SettingsPanel.vue";
import Snapshots from "./components/Snapshots.vue";
import AnnotationBrowser from "@/components/AnnotationBrowser/AnnotationBrowser.vue";
import HelpPanel from "./components/HelpPanel.vue";
import BreadCrumbs from "./layout/BreadCrumbs.vue";
import { Vue, Component, Watch } from "vue-property-decorator";
import store from "@/store";
import propertyStore from "@/store/properties";
import { logError } from "@/utils/log";
import { IHotkey } from "@/utils/v-mousetrap";
import ChatComponent from "@/components/ChatComponent.vue";
import { IGirderFolder } from "@/girder";

@Component({
  components: {
    HelpPanel,
    AnnotationBrowser,
    UserMenu,
    BreadCrumbs,
    ServerStatus,
    AnalyzeAnnotations,
    AnnotationsSettings,
    Snapshots,
    ChatComponent,
  },
})
export default class App extends Vue {
  readonly store = store;
  readonly propertyStore = propertyStore;

  readonly appHotkeys: IHotkey = {
    bind: "tab",
    handler: this.toggleHelpDialogUsingHotkey,
    data: {
      section: "Global",
      description: "Toggle help dialog",
    },
  };

  get helpPanelIsOpen() {
    return this.store.isHelpPanelOpen;
  }

  set helpPanelIsOpen(isOpen: boolean) {
    this.store.setIsHelpPanelOpen(isOpen);
  }

  snapshotPanel = false;
  snapshotPanelFull = false;

  annotationPanel = false;

  settingsPanel = false;

  analyzePanel = false;

  chatbotOpen = false;

  lastModifiedRightPanel: string | null = null;

  isUploadLoading = false;

  fetchConfig() {
    // Fetch the list of available tool templates
    // It consists of a json file containing a list of items, each item describing
    // the interface elements for a different tool type:
    // * name: Name of the tool type
    // * type: Type of tool to be added
    // * interface: List of various form components necessary to configure the tool
    // Interface elements have a name, an id, a type (see ToolConfiguration) and a type-dependent meta field
    axios
      .get("config/templates.json")
      .then((resp) => {
        this.store.setToolTemplateList(resp.data);
      })
      .catch((err) => {
        logError(err);
        throw err;
      });
  }

  mounted() {
    this.fetchConfig();
  }

  goHome() {
    this.$router.push({ name: "root" });
  }

  toggleRightPanel(panel: string | null) {
    if (panel !== null) {
      this.$data[panel] = !this.$data[panel];
    }
    // The last panel updated has to be closed if it is not the currently updated panel
    if (
      this.lastModifiedRightPanel !== null &&
      this.lastModifiedRightPanel !== panel
    ) {
      this.$data[this.lastModifiedRightPanel] = false;
    }
    this.lastModifiedRightPanel = panel;
  }

  toggleHelpDialogUsingHotkey(_elem: any, e: Event) {
    e.preventDefault();
    this.helpPanelIsOpen = !this.helpPanelIsOpen;
  }

  @Watch("annotationPanel")
  annotationPanelChanged() {
    this.store.setIsAnnotationPanelOpen(this.annotationPanel);
  }

  get annotationPanelBadge() {
    return this.store.annotationPanelBadge;
  }

  set annotationPanelBadge(value) {
    this.store.setAnnotationPanelBadge(value);
  }

  get routeName() {
    return this.$route.name;
  }

  get hasUncomputedProperties() {
    const uncomputed = this.propertyStore.uncomputedAnnotationsPerProperty;
    for (const id in uncomputed) {
      if (uncomputed[id].length > 0) {
        return true;
      }
    }
    return false;
  }

  @Watch("routeName")
  datasetChanged() {
    if (this.routeName !== "datasetview") {
      this.toggleRightPanel(null);
    }
  }

  async goToNewDataset() {
    if (this.isUploadLoading) return;

    this.isUploadLoading = true;

    let privateFolder: IGirderFolder | null = null;
    try {
      // Get the user's private folder
      privateFolder = await this.store.api.getUserPrivateFolder();
      if (!privateFolder) {
        throw new Error("Could not access private folder");
      }
    } catch (error) {
      logError(error);
    } finally {
      this.$router.push({
        name: "newdataset",
        params: {
          quickupload: false,
          defaultFiles: [],
          initialUploadLocation: privateFolder,
        } as any,
      });
      this.isUploadLoading = false;
    }
  }
}
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
