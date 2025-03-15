<template>
  <v-container>
    <v-row>Image: {{ property.image }}</v-row>
    <v-row>
      Tags ({{ property.tags.exclusive ? "exclusive" : "inclusive" }}):
      {{ property.tags.tags.join(", ") }}
    </v-row>
    <v-row>Shape: {{ annotationNames[property.shape] }}</v-row>
    <v-row>
      Worker interface:
      <v-container class="pl-8">
        <v-row
          v-for="[name, value] in Object.entries(property.workerInterface)"
          :key="name"
        >
          {{ name }}: {{ value }}
        </v-row>
      </v-container>
    </v-row>
    <v-row>
      <v-spacer />
      <v-btn
        v-if="currentJobId || localJobLog"
        small
        text
        color="info"
        class="mr-2"
        @click="showLogDialog = true"
      >
        <v-icon small left>mdi-text-box-outline</v-icon>
        Log
      </v-btn>
      <v-dialog v-model="deleteDialog">
        <template v-slot:activator="{ on, attrs }">
          <v-btn
            v-bind="attrs"
            v-on="on"
            @click.stop="deleteComputedValues = true"
            color="red"
          >
            Delete property
          </v-btn>
        </template>
        <v-card>
          <v-card-title> Delete property </v-card-title>
          <v-card-text>
            <v-container>
              <v-row>
                <v-col class="body-2">
                  You are about to delete this property:
                </v-col>
              </v-row>
              <v-row>
                <v-col class="body-1 d-flex justify-center">
                  {{ property.name }}
                </v-col>
              </v-row>
              <v-row>
                <v-col>
                  <v-checkbox
                    hide-details
                    dense
                    label="Also delete the computed values for this property"
                    v-model="deleteComputedValues"
                  />
                </v-col>
              </v-row>
            </v-container>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn
              color="red"
              @click="
                () => {
                  deleteProperty();
                  deleteDialog = false;
                }
              "
              >Delete</v-btn
            >
            <v-btn color="primary" @click="deleteDialog = false">Cancel</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </v-row>

    <!-- Log Dialog -->
    <v-dialog v-model="showLogDialog" max-width="800px">
      <v-card>
        <v-card-title class="headline">
          Job Log: {{ property.name }}
          <v-spacer></v-spacer>
          <v-tooltip bottom>
            <template v-slot:activator="{ on, attrs }">
              <v-btn icon v-bind="attrs" v-on="on" @click="copyLogToClipboard">
                <v-icon>mdi-content-copy</v-icon>
              </v-btn>
            </template>
            <span>Copy to clipboard</span>
          </v-tooltip>
          <v-btn icon @click="showLogDialog = false">
            <v-icon>mdi-close</v-icon>
          </v-btn>
        </v-card-title>
        <v-card-text>
          <pre class="job-log">{{ jobLog }}</pre>
        </v-card-text>
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn color="primary" text @click="showLogDialog = false"
            >Close</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Snackbar for copy notification -->
    <v-snackbar v-model="showCopySnackbar" :timeout="2000" color="success" top>
      Log copied to clipboard
    </v-snackbar>
  </v-container>
</template>

<script lang="ts">
import propertyStore from "@/store/properties";
import jobsStore from "@/store/jobs";
import { IAnnotationProperty, AnnotationNames } from "@/store/model";
import { Vue, Component, Prop } from "vue-property-decorator";
import { logError } from "@/utils/log";

@Component({})
export default class AnnotationPropertyBody extends Vue {
  readonly propertyStore = propertyStore;
  readonly jobsStore = jobsStore;

  @Prop()
  readonly property!: IAnnotationProperty;

  annotationNames = AnnotationNames;

  deleteDialog: boolean = false;
  deleteComputedValues: boolean = false;
  showLogDialog: boolean = false;
  localJobLog: string = "";
  showCopySnackbar: boolean = false;

  get currentJobId() {
    return this.property
      ? this.jobsStore.jobIdForPropertyId[this.property.id]
      : null;
  }

  get jobLog() {
    if (this.currentJobId) {
      // Update local log from store when a job is running
      const storeLog = this.jobsStore.getJobLog(this.currentJobId);
      if (storeLog && storeLog !== this.localJobLog) {
        // If the log is empty, add a header with timestamp
        if (!this.localJobLog) {
          const timestamp = new Date().toLocaleString();
          this.localJobLog = `=== Job started at ${timestamp} ===\n\n${storeLog}`;
        } else {
          this.localJobLog = storeLog;
        }
      }
      return storeLog;
    }
    // Return local log when no current job (job completed)
    return this.localJobLog;
  }

  deleteProperty() {
    this.propertyStore.deleteProperty(this.property.id);
    if (this.deleteComputedValues) {
      this.propertyStore.deletePropertyValues(this.property.id);
    }
  }

  copyLogToClipboard() {
    const log = this.jobLog;
    if (log) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(log)
          .then(() => {
            this.showCopySnackbar = true;
          })
          .catch(() => {
            // Fallback for browsers that don't support the Clipboard API
            this.copyToClipboardFallback(log);
          });
      } else {
        // Fallback for older browsers
        this.copyToClipboardFallback(log);
      }
    }
  }

  copyToClipboardFallback(text: string) {
    const tempTextArea = document.createElement("textarea");
    tempTextArea.value = text;
    tempTextArea.style.position = "fixed"; // Avoid scrolling to bottom
    document.body.appendChild(tempTextArea);
    tempTextArea.select();

    try {
      document.execCommand("copy");
      this.showCopySnackbar = true;
    } catch (err) {
      logError("Failed to copy text: ", err);
    }

    document.body.removeChild(tempTextArea);
  }
}
</script>

<style lang="scss" scoped>
.job-log {
  max-height: 400px;
  min-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  font-family: monospace;
  font-size: 12px;
  background-color: rgba(0, 0, 0, 0.05);
  padding: 12px;
  border-radius: 4px;
  width: 100%;
  color: rgba(255, 255, 255, 0.85);
}
</style>
