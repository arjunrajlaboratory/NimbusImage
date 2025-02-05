<template>
  <v-card :class="{ menu: true, loaded: !fetchingWorkerInterface }" v-if="tool">
    <v-card-title class="subtitle-1">
      Worker menu
      <v-spacer />
      <v-btn small text class="mr-2" @click="resetInterfaceValues()">
        <v-icon small left>mdi-refresh</v-icon>
        Reset
      </v-btn>
      <v-icon
        @click="updateInterface(true)"
        v-tooltip="'Refresh worker interface from the server'"
      >
        mdi-sync
      </v-icon>
    </v-card-title>
    <v-card-text>
      <v-container v-if="fetchingWorkerInterface">
        <v-progress-circular indeterminate />
      </v-container>
      <v-container v-else>
        <v-row v-if="running">
          <v-progress-linear
            :indeterminate="!progressInfo.progress"
            :value="100 * (progressInfo.progress || 0)"
            class="text-progress"
          >
            <strong class="pr-4">
              {{ progressInfo.title }}
            </strong>
            {{ progressInfo.info }}
          </v-progress-linear>
        </v-row>
        <v-row
          v-for="(warning, index) in filteredWarnings"
          :key="'warning-' + index"
        >
          <v-alert type="warning" dense class="mb-2">
            <div class="error-main">
              {{ warning.title }}: {{ warning.warning }}
            </div>
            <div v-if="warning.info" class="error-info">{{ warning.info }}</div>
          </v-alert>
        </v-row>
        <v-row v-for="(error, index) in filteredErrors" :key="'error-' + index">
          <v-alert type="error" dense class="mb-2">
            <div class="error-main">{{ error.title }}: {{ error.error }}</div>
            <div v-if="error.info" class="error-info">{{ error.info }}</div>
          </v-alert>
        </v-row>
        <v-row>
          <v-col>
            <v-subheader>Image: {{ tool.values.image.image }}</v-subheader>
          </v-col>
        </v-row>
        <v-row>
          <worker-interface-values
            v-if="workerInterface"
            :workerInterface="workerInterface"
            :tool="tool"
            v-model="interfaceValues"
            tooltipPosition="right"
          />
        </v-row>
        <v-row>
          <v-btn @click="preview" v-if="hasPreview">Preview</v-btn>
          <v-spacer></v-spacer>
          <v-btn @click="compute" :disabled="running">
            <v-progress-circular size="16" v-if="running" indeterminate />
            <v-icon v-if="previousRunStatus === false">mdi-close</v-icon>
            <v-icon v-if="previousRunStatus === true">mdi-check</v-icon>
            <span>Compute</span>
          </v-btn>
        </v-row>
        <v-row>
          <v-checkbox
            v-if="hasPreview"
            v-model="displayWorkerPreview"
            label="Display Previews"
          ></v-checkbox>
        </v-row>
      </v-container>
    </v-card-text>
  </v-card>
</template>

<script lang="ts">
import { Vue, Component, Watch, Prop } from "vue-property-decorator";
import store from "@/store";
import annotationsStore from "@/store/annotation";
import {
  IProgressInfo,
  IToolConfiguration,
  IWorkerInterfaceValues,
  IErrorInfoList,
  MessageType,
} from "@/store/model";
import TagFilterEditor from "@/components/AnnotationBrowser/TagFilterEditor.vue";
import LayerSelect from "@/components/LayerSelect.vue";
import propertiesStore from "@/store/properties";
import WorkerInterfaceValues from "@/components/WorkerInterfaceValues.vue";
import { getDefault } from "@/utils/workerInterface";
import { debounce } from "lodash";
// Popup for new tool configuration
@Component({
  components: {
    LayerSelect,
    TagFilterEditor,
    WorkerInterfaceValues,
  },
})
export default class AnnotationWorkerMenu extends Vue {
  readonly store = store;
  readonly annotationsStore = annotationsStore;
  readonly propertyStore = propertiesStore;

  // Create a debounced version of editToolInConfiguration
  debouncedEditTool = debounce((tool: IToolConfiguration) => {
    this.store.editToolInConfiguration(tool);
  }, 300);

  fetchingWorkerInterface: boolean = false;
  running: boolean = false;
  previousRunStatus: boolean | null = null;
  progressInfo: IProgressInfo = {};
  errorInfo: IErrorInfoList = { errors: [] };
  interfaceValues: IWorkerInterfaceValues = {};

  beforeDestroy() {
    // Cancel any pending debounced calls
    this.debouncedEditTool.cancel();
  }

  @Prop()
  readonly tool!: IToolConfiguration;

  get workerInterface() {
    return this.propertyStore.getWorkerInterface(this.image);
  }

  get image() {
    return this.tool?.values?.image?.image;
  }

  get workerPreview() {
    return (
      this.propertyStore.getWorkerPreview(this.image) || {
        text: "null",
        image: "",
      }
    );
  }

  get displayWorkerPreview() {
    return this.propertyStore.displayWorkerPreview;
  }

  set displayWorkerPreview(value: boolean) {
    this.propertyStore.setDisplayWorkerPreview(value);
  }

  @Watch("interfaceValues", { deep: true })
  onInterfaceValuesChanged() {
    let tool = this.tool; // Copy the tool object because it's a readonly prop
    tool.values.workerInterfaceValues = this.interfaceValues;
    this.debouncedEditTool(tool);
  }

  compute() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.previousRunStatus = null;
    this.annotationsStore.computeAnnotationsWithWorker({
      tool: this.tool,
      workerInterface: this.interfaceValues,
      progress: this.progressInfo,
      error: this.errorInfo,
      callback: (success) => {
        this.running = false;
        this.previousRunStatus = success;
        this.progressInfo = {};
      },
    });
  }

  preview() {
    this.propertyStore.requestWorkerPreview({
      image: this.image,
      tool: this.tool,
      workerInterface: this.interfaceValues,
    });
  }

  mounted() {
    if (this.tool.values.workerInterfaceValues) {
      this.interfaceValues = this.tool.values.workerInterfaceValues;
    }
    this.updateInterface();
  }

  resetInterfaceValues() {
    const interfaceValues: IWorkerInterfaceValues = {};
    if (this.workerInterface) {
      for (const id in this.workerInterface) {
        const interfaceTemplate = this.workerInterface[id];
        interfaceValues[id] = getDefault(
          interfaceTemplate.type,
          interfaceTemplate.default,
        );
      }
    }
    this.interfaceValues = interfaceValues;
  }

  @Watch("tool")
  async updateInterface(force?: boolean) {
    this.propertyStore.fetchWorkerImageList(); // Required to update docker image labels
    if (
      (force || this.workerInterface === undefined) &&
      !this.fetchingWorkerInterface
    ) {
      this.fetchingWorkerInterface = true;
      await this.propertyStore
        .fetchWorkerInterface({ image: this.image, force })
        .finally();
      this.fetchingWorkerInterface = false;
    }
  }

  get hasPreview() {
    return this.propertyStore.hasPreview(this.image);
  }

  get filteredErrors() {
    return this.errorInfo.errors.filter(
      (error) => error.error && error.type === MessageType.ERROR,
    );
  }

  get filteredWarnings() {
    return this.errorInfo.errors.filter(
      (error) => error.warning && error.type === MessageType.WARNING,
    );
  }
}
</script>

<style lang="scss" scoped>
.menu {
  border: solid 1px rgba(255, 255, 255, 0.8);
  box-shadow:
    0 12px 24px rgba(0, 0, 0, 0.8),
    0 4px 8px rgba(0, 0, 0, 0.6);
  min-height: 600px;

  :deep(.v-card__text) {
    max-height: 600px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.3) rgba(0, 0, 0, 0.2);

    &::-webkit-scrollbar {
      width: 8px;
    }

    &::-webkit-scrollbar-track {
      background: rgba(0, 0, 0, 0.2);
      border-radius: 4px;
    }

    &::-webkit-scrollbar-thumb {
      background-color: rgba(255, 255, 255, 0.3);
      border-radius: 4px;

      &:hover {
        background-color: rgba(255, 255, 255, 0.4);
      }
    }
  }
}
// Set min-height to 0 when loaded
.loaded {
  min-height: 0;
}

.error-main {
  font-weight: 500;
  max-width: 300px;
}

.error-info {
  font-size: 0.875em;
  margin-top: 4px;
  max-width: 300px;
  word-wrap: break-word; /* Ensures long words don't overflow */
  opacity: 0.9;
}
</style>
