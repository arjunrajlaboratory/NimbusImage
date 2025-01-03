<template>
  <v-container>
    <v-card v-if="quickupload" class="mb-2">
      <v-card-title>Quick Import in Progess</v-card-title>
      <v-card-text>
        <v-progress-linear
          class="text-progress"
          :value="totalProgressPercentage"
        />
      </v-card-text>
    </v-card>
    <v-form
      ref="form"
      v-model="valid"
      :disabled="
        quickupload && !pipelineError && valid && filesSelected && !uploading
      "
      @submit.prevent="submit()"
    >
      <girder-upload
        v-if="path && !hideUploader"
        ref="uploader"
        class="mb-2 new-dataset-upload"
        :dest="path"
        hideStartButton
        hideHeadline
        @filesChanged="filesChanged"
        @done="nextStep"
        @error="interruptedUpload"
        @hook:mounted="uploadMounted"
      >
        <template #files="{ files }" v-if="quickupload && !pipelineError">
          <v-card>
            <v-card-text>
              Uploading {{ files ? files.length : 0 }} file(s)...
            </v-card-text>
          </v-card>
        </template>
      </girder-upload>

      <file-dropzone
        v-if="(!quickupload || pipelineError) && files.length > 0"
        @input="addMoreFiles"
        style="height: 150px"
        class="mb-2"
      >
        <template #default>
          <v-icon size="50px">$vuetify.icons.fileUpload</v-icon>
          <div class="title mt-3">Add more files to this dataset</div>
        </template>
      </file-dropzone>

      <v-text-field
        v-model="name"
        label="Name"
        required
        :rules="rules"
        :readonly="pageTwo"
      />

      <v-textarea
        v-model="description"
        label="Description"
        :readonly="pageTwo"
        rows="2"
      />

      <v-card class="mb-2">
        <v-card-title>Location:</v-card-title>
        <v-card-text>
          <v-container>
            <v-row>
              <girder-location-chooser
                v-model="path"
                :breadcrumb="true"
                title="Select a Folder to Import the New Dataset"
                :disabled="quickupload && !pipelineError"
              />
            </v-row>
          </v-container>
        </v-card-text>
      </v-card>

      <div class="button-bar" v-if="!quickupload || pipelineError">
        <v-btn
          :disabled="!valid || !filesSelected || uploading || fileSizeExceeded"
          color="success"
          class="mr-4"
          @click="submit"
        >
          Upload
        </v-btn>
      </div>
    </v-form>

    <v-alert v-if="failedDataset" text type="error">
      Could not create dataset <strong>{{ failedDataset }}</strong
      >. This might happen, for instance, if a dataset by that name already
      exists. Please update the dataset name field and try again.
    </v-alert>
    <v-alert v-if="fileSizeExceeded" text type="error">
      Total file size ({{ totalSizeMB }} MB) exceeds the maximum allowed size of
      {{ maxTotalFileSize }} MB
    </v-alert>
    <template v-if="quickupload">
      <template v-if="configuring">
        <multi-source-configuration
          ref="configuration"
          :datasetId="datasetId"
          :autoDatasetRoute="false"
          @log="configurationLogs = $event"
          @generatedJson="generationDone"
          :class="{ 'd-none': !pipelineError }"
        />
        <div class="title mb-2">Configuring the dataset</div>
        <v-progress-circular indeterminate />
        <div class="code-container" v-if="configurationLogs">
          <code class="code-block">{{ configurationLogs }}</code>
        </div>
      </template>
      <template v-if="creatingView">
        <div class="title mb-2">Configuring the dataset</div>
        <v-progress-circular indeterminate />
        <dataset-info
          ref="viewCreation"
          :class="{ 'd-none': !pipelineError }"
        />
      </template>
    </template>
  </v-container>
</template>
<script lang="ts">
import { Vue, Component, Prop } from "vue-property-decorator";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { IGirderLocation } from "@/girder";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";
import FileDropzone from "@/components/Files/FileDropzone.vue";
import { IDataset } from "@/store/model";
import { triggersPerCategory } from "@/utils/parsing";
import { formatDate } from "@/utils/date";
import MultiSourceConfiguration from "./MultiSourceConfiguration.vue";
import DatasetInfo from "./DatasetInfo.vue";
import { logError } from "@/utils/log";

const allTriggers = Object.values(triggersPerCategory).flat();

interface FileUpload {
  file: File;
}

type GWCUpload = Vue & {
  inputFilesChanged(files: File[]): void;
  startUpload(): any;
  totalProgressPercent: number;
};

function basename(filename: string): string {
  const components = filename.split(".");
  return components.length > 1
    ? components.slice(0, -1).join(".")
    : components[0];
}

function findCommonPrefix(strings: string[]): string {
  // Handle special cases
  if (strings.length === 0) {
    return "";
  } else if (strings.length === 1) {
    return strings[0];
  }

  // For filenames that are purely numeric at the start, use first filename + "_multi"
  if (strings.every((s) => /^\d+/.test(s))) {
    return basename(strings[0]) + "_multi";
  }

  // For non-numeric prefixes:
  // Extract the non-metadata prefix of each filename. Note that because of the
  // way the regex is constructed, the first match group will never be `null`.
  const triggerAndDigit = allTriggers.map(
    (trigger) => `\\d${trigger}|${trigger}\\d`,
  );
  const re = new RegExp(`(.*?)(?:_|-|${triggerAndDigit.join("|")})`);
  const matches = strings.map((s) => s.match(re)![1]);

  // Get the minimum length of all the strings; the common prefix cannot be
  // longer than this.
  const minLength = matches.reduce(
    (acc, cur) => Math.min(acc, cur.length),
    Infinity,
  );

  // Sweep through the first string, and compare the letter found in each
  // position with the letter at that position for all the strings. Stop when an
  // inequality occurs.
  let result = [];
  for (let i = 0; i < minLength; i++) {
    const ch = matches[0].charAt(i);

    if (!matches.map((s) => s.charAt(i)).every((c) => c === ch)) {
      break;
    }
    result.push(ch);
  }

  return result.join("");
}

@Component({
  components: {
    GirderLocationChooser,
    FileDropzone,
    MultiSourceConfiguration,
    DatasetInfo,
    GirderUpload: () => import("@/girder/components").then((mod) => mod.Upload),
  },
})
export default class NewDataset extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;

  @Prop({ type: Array, default: () => [] })
  readonly defaultFiles!: File[];

  @Prop({ default: false })
  readonly quickupload!: boolean;

  @Prop({ default: true })
  readonly autoMultiConfig!: boolean;

  @Prop()
  readonly initialUploadLocation!: IGirderLocation;

  uploadedFiles: File[] | null = null;

  configuring = false;
  creatingView = false;

  valid = false;
  failedDataset = "";
  uploading = false;
  hideUploader = false;
  name = "";
  description = "";

  path: IGirderLocation | null = null;

  dataset: IDataset | null = null;

  $refs!: {
    uploader?: GWCUpload;
    form: HTMLFormElement;
    configuration?: MultiSourceConfiguration;
    viewCreation?: DatasetInfo;
  };

  configurationLogs = "";

  pipelineError = false;

  maxTotalFileSize =
    Number(import.meta.env.VITE_MAX_TOTAL_FILE_SIZE) || Infinity;
  fileSizeExceeded = false;
  fileSizeExceededMessage = "";

  allFiles: File[] = [];

  get datasetId() {
    return this.dataset?.id || null;
  }

  get totalProgressPercentage() {
    const stepWeights = [3, 3, 1];
    let iStep = 0;
    const totalPercentage = (localPercentage: number): number => {
      // Sum of the weight of the steps that are completed
      let completedStepsWeight = 0;
      for (let i = 0; i < iStep; ++i) {
        completedStepsWeight += stepWeights[i];
      }
      // Total sum of the weight of all steps
      let totalStepsWeight = completedStepsWeight;
      for (let i = iStep; i < stepWeights.length; ++i) {
        totalStepsWeight += stepWeights[i];
      }
      // Return the percentage of completion
      return (
        (100 * completedStepsWeight + localPercentage * stepWeights[iStep]) /
        totalStepsWeight
      );
    };

    // First step: uploading
    if (this.uploading) {
      const uploader = this.$refs.uploader;
      if (!uploader) {
        return totalPercentage(0);
      }
      return totalPercentage(uploader.totalProgressPercent);
    }
    iStep += 1;

    // Second step: configuring
    if (this.configuring) {
      const nLines = this.configurationLogs.split("\n").length;
      const exponent = -0.01 * nLines;
      return totalPercentage(100 - 100 * Math.exp(exponent));
    }
    iStep += 1;

    // Third step: create view
    if (this.creatingView) {
      return totalPercentage(50);
    }
    iStep += 1;

    return totalPercentage(0);
  }

  get pageTwo() {
    return this.dataset != null;
  }

  get rules() {
    return [(v: string) => v.trim().length > 0 || `value is required`];
  }

  get files() {
    return this.uploadedFiles || this.defaultFiles;
  }

  get filesSelected() {
    return this.files.length > 0;
  }

  get recommendedName() {
    const { files } = this;

    // If there aren't any files selected yet, return a blank string.
    if (files.length === 0) {
      return "";
    }

    // If there is only one file, return its name with the extension struck off.
    if (files.length === 1) {
      return basename(files[0].name);
    }

    // For more than one file, search for the longest prefix common to all, and
    // use that as the name if it's nonblank; otherwise use the name of the
    // first file.
    const prefix = findCommonPrefix(files.map((d) => d.name));
    if (prefix.length > 0) {
      return prefix;
    } else {
      return basename(files[0].name);
    }
  }

  get totalSizeMB() {
    if (!this.uploadedFiles) return 0;
    const totalBytes = this.uploadedFiles.reduce(
      (sum, file) => sum + file.size,
      0,
    );
    return (totalBytes / 1024 / 1024).toFixed(1);
  }

  async mounted() {
    this.path = this.initialUploadLocation;
  }

  async uploadMounted() {
    this.$refs.uploader?.inputFilesChanged(this.files);
    if (this.quickupload) {
      this.name = formatDate(new Date()) + " - " + this.recommendedName;
      await Vue.nextTick(); // "name" prop is set in the form
      await Vue.nextTick(); // this.valid is updated
      this.submit();
    }
  }

  async submit() {
    if (!this.valid || !this.path || !("_id" in this.path)) {
      return;
    }

    if (this.fileSizeExceeded) {
      logError("Maximum total file size exceeded");
      this.pipelineError = true;
      return;
    }

    this.dataset = await this.store.createDataset({
      name: this.name,
      description: this.description,
      path: this.path,
    });

    if (this.dataset === null) {
      this.failedDataset = this.name;
      return;
    }

    this.failedDataset = "";

    this.path = await this.girderResources.getFolder(this.dataset.id);
    await Vue.nextTick();

    this.uploading = true;
    this.$refs.uploader!.startUpload();
  }

  filesChanged(files: FileUpload[] | File[]) {
    // Convert to FileUpload[] format if necessary
    const fileUploads: FileUpload[] = Array.isArray(files)
      ? files.map((file) => {
          return typeof file === "object" && "file" in file
            ? (file as FileUpload)
            : { file: file as File };
        })
      : [];

    const totalSize = fileUploads.reduce((sum, { file }) => sum + file.size, 0);
    const maxSizeBytes = this.maxTotalFileSize * 1024 * 1024;

    if (totalSize > maxSizeBytes) {
      this.fileSizeExceeded = true;
      this.uploadedFiles = null;
      if (this.quickupload) {
        this.pipelineError = true;
        return;
      }
      return;
    }

    this.fileSizeExceeded = false;
    this.uploadedFiles = fileUploads.map(({ file }) => file);
    this.allFiles = this.uploadedFiles;

    if (this.name === "" && fileUploads.length > 0) {
      this.name = this.recommendedName;
    }
  }

  addMoreFiles(newFiles: File[]) {
    const merged = [...this.allFiles, ...newFiles];
    this.allFiles = merged;

    // Update girder-upload's internal state
    if (this.$refs.uploader) {
      this.$refs.uploader.inputFilesChanged(merged);
    }
  }

  interruptedUpload() {
    this.uploading = false;
    this.hideUploader = false;
  }

  nextStep() {
    this.hideUploader = true;
    this.uploading = false;

    const datasetId = this.dataset!.id;

    if (this.quickupload) {
      this.configureDataset();
    } else if (this.autoMultiConfig) {
      this.$router.push({
        name: "multi",
        params: { datasetId },
      });
    }

    this.$emit("datasetUploaded", datasetId);
  }

  async configureDataset() {
    // Don't set dataset yet because the only large image files are the upload files
    // If dataset is set now, it will not use the multi-source file later

    // Configure the dataset with default variables
    this.configuring = true;
    await Vue.nextTick();
    const config = this.$refs.configuration;
    if (!config) {
      logError(
        "MultiSourceConfiguration component not mounted during quickupload",
      );
      this.pipelineError = true;
      return;
    }
    // Ensure that the component is initialized
    await (config.initialized || config.initialize());
    config.submit();
  }

  generationDone(jsonId: string | null) {
    if (this.quickupload) {
      this.createView(jsonId);
    }
  }

  async createView(jsonId: string | null) {
    if (!jsonId) {
      logError("Failed to generate JSON during quick upload");
      this.pipelineError = true;
      return;
    }
    // Set the dataset now that multi-source is available
    await this.store.setSelectedDataset(this.dataset!.id);
    this.configuring = false;

    // Create a default dataset view for this dataset
    this.creatingView = true;
    await Vue.nextTick();
    const viewCreation = this.$refs.viewCreation;
    if (!viewCreation) {
      logError("DatasetInfo component not mounted during quickupload");
      this.pipelineError = true;
      return;
    }
    const defaultView = await viewCreation.createDefaultView();
    if (!defaultView) {
      logError("Failed to create default view during quick upload");
      this.pipelineError = true;
      return;
    }
    this.store.setDatasetViewId(defaultView.id);
    const route = viewCreation.toRoute(defaultView);
    this.creatingView = false;

    // Go to the viewer
    this.$router.push(route);
  }
}
</script>

<style lang="scss">
.new-dataset-upload .files-list {
  max-height: 260px;
}
</style>
