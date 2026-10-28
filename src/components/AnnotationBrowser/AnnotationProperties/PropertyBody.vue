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
        size="small"
        variant="text"
        color="info"
        class="mr-2"
        @click="showLogDialog = true"
      >
        <v-icon size="small" start>mdi-text-box-outline</v-icon>
        Log
      </v-btn>
      <v-dialog v-model="deleteDialog">
        <template v-slot:activator="{ props: activatorProps }">
          <v-btn
            v-bind="activatorProps"
            variant="text"
            color="error"
            size="small"
            @click.stop="openDeleteDialog"
          >
            Remove property
          </v-btn>
        </template>
        <v-card>
          <v-card-title> Remove property </v-card-title>
          <v-card-text>
            <v-container>
              <v-row>
                <v-col class="body-2">
                  You are about to remove this property:
                </v-col>
              </v-row>
              <v-row>
                <v-col class="body-1 d-flex justify-center">
                  {{ property.name }}
                </v-col>
              </v-row>
              <v-row v-if="runningPipeline">
                <v-col>
                  <v-alert type="error" variant="tonal" density="compact">
                    The pipeline "{{ runningPipeline.name }}" is running and
                    computes this property. Wait for it to finish, or cancel it,
                    before removing the property: removing it now would make the
                    rest of the run compute into a new property instead.
                  </v-alert>
                </v-col>
              </v-row>
              <v-row v-else-if="linkedSteps.length > 0">
                <v-col>
                  <v-alert type="warning" variant="tonal" density="compact">
                    These pipeline steps use this property:
                    <ul class="linked-steps">
                      <li
                        v-for="link in linkedSteps"
                        :key="`${link.pipelineId}:${link.stepId}`"
                      >
                        {{ link.pipelineName }}: {{ link.stepName }}
                        <span v-if="link.use === 'created'">(created it)</span>
                        <span v-if="!link.enabled">(disabled)</span>
                      </li>
                    </ul>
                    If you remove it, each creates a new pipeline-owned property
                    on its next run instead.
                  </v-alert>
                </v-col>
              </v-row>
              <v-row v-if="!runningPipeline">
                <v-col>
                  <v-checkbox
                    hide-details
                    density="compact"
                    label="Also delete the computed values for this property"
                    v-model="deleteComputedValues"
                  />
                </v-col>
              </v-row>
              <v-row v-if="deleteError">
                <v-col>
                  <v-alert type="error" variant="tonal" density="compact">
                    {{ deleteError }}
                  </v-alert>
                </v-col>
              </v-row>
            </v-container>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" size="small" @click="deleteDialog = false"
              >Cancel</v-btn
            >
            <v-btn
              v-if="!runningPipeline"
              variant="flat"
              color="error"
              size="small"
              :loading="deleting"
              @click="confirmDelete"
              >{{ linkedSteps.length > 0 ? "Remove anyway" : "Remove" }}</v-btn
            >
          </v-card-actions>
        </v-card>
      </v-dialog>
    </v-row>

    <!-- Log Dialog -->
    <v-dialog v-model="showLogDialog" max-width="800px">
      <v-card>
        <v-card-title class="d-flex align-center">
          Job Log: {{ property.name }}
          <v-spacer></v-spacer>
          <v-tooltip location="bottom">
            <template v-slot:activator="{ props: activatorProps }">
              <v-btn
                v-bind="activatorProps"
                variant="text"
                icon
                size="small"
                @click="copyLogToClipboard"
              >
                <v-icon>mdi-content-copy</v-icon>
              </v-btn>
            </template>
            <span>Copy to clipboard</span>
          </v-tooltip>
          <v-btn
            variant="text"
            icon
            size="small"
            @click="showLogDialog = false"
          >
            <v-icon>mdi-close</v-icon>
          </v-btn>
        </v-card-title>
        <v-card-text>
          <pre class="job-log">{{ jobLog }}</pre>
        </v-card-text>
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn variant="text" size="small" @click="showLogDialog = false"
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

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import propertyStore from "@/store/properties";
import jobsStore from "@/store/jobs";
import pipelinesStore from "@/store/pipelines";
import progress from "@/store/progress";
import store from "@/store";
import {
  IAnnotationProperty,
  AnnotationNames,
  NotificationType,
} from "@/store/model";
import { logError } from "@/utils/log";

const props = defineProps<{
  property: IAnnotationProperty;
}>();

const annotationNames = AnnotationNames;

const deleteDialog = ref(false);
const deleteComputedValues = ref(false);
const showLogDialog = ref(false);
const localJobLog = ref("");
const showCopySnackbar = ref(false);

const currentJobId = computed(() => {
  return props.property
    ? jobsStore.jobIdForPropertyId[props.property.id]
    : null;
});

const jobLog = computed(() => {
  if (currentJobId.value) {
    return jobsStore.getJobLog(currentJobId.value) || localJobLog.value;
  }
  return localJobLog.value;
});

// Sync store log to local log (side effect kept out of computed)
watch(
  () => (currentJobId.value ? jobsStore.getJobLog(currentJobId.value) : null),
  (storeLog) => {
    if (storeLog && storeLog !== localJobLog.value) {
      if (!localJobLog.value) {
        const timestamp = new Date().toLocaleString();
        localJobLog.value = `=== Job started at ${timestamp} ===\n\n${storeLog}`;
      } else {
        localJobLog.value = storeLog;
      }
    }
  },
);

// Enabled pipeline steps linked to this property: removing it makes them fall
// back to their saved copy, so the confirmation names them.
const linkedSteps = computed(() =>
  pipelinesStore.pipelineStepsLinkedToProperty(props.property.id),
);

// A running pipeline (or batch) that computes this property. Its removal is
// blocked until the run ends: the remaining steps or datasets would compute
// into a fallback property instead.
const runningPipeline = computed(() =>
  pipelinesStore.runningPipelineComputingProperty(props.property.id),
);

const deleting = ref(false);
const deleteError = ref<string | null>(null);

function openDeleteDialog() {
  deleteComputedValues.value = true;
  deleteError.value = null;
}

// Removes the property; resolves to whether it was removed. The removal can
// be refused (this configuration's properties have not loaded) or fail to
// save, and then the property stays.
async function deleteProperty(): Promise<boolean> {
  // Also checked here: a run can start while the dialog is open.
  if (runningPipeline.value) {
    return false;
  }
  // Captured first: another dataset may be open once the removal has saved.
  const datasetId = store.dataset?.id;
  const deleteValues = deleteComputedValues.value;
  const propertyName = props.property.name;
  try {
    await propertyStore.deleteProperty(props.property.id);
  } catch (error) {
    logError("Failed to remove property:", error);
    const message = `"${propertyName}" was not removed: ${
      (error as Error).message
    }`;
    deleteError.value = message;
    // The removal takes the property out of the list before it saves, which
    // unmounts this row and its dialog: say so where it is seen either way.
    progress.createNotification({
      type: NotificationType.ERROR,
      title: "Property not removed",
      message,
    });
    return false;
  }
  if (deleteValues && datasetId) {
    // The property is removed either way; a failure here only leaves its
    // computed values in place.
    try {
      await propertyStore.deletePropertyValues({
        propertyId: props.property.id,
        datasetId,
      });
    } catch (error) {
      logError("Failed to delete the property's computed values:", error);
    }
  }
  return true;
}

// The dialog closes only once the property is actually removed.
async function confirmDelete() {
  deleting.value = true;
  deleteError.value = null;
  try {
    if (await deleteProperty()) {
      deleteDialog.value = false;
    }
  } finally {
    deleting.value = false;
  }
}

function copyLogToClipboard() {
  const log = jobLog.value;
  if (log) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(log)
        .then(() => {
          showCopySnackbar.value = true;
        })
        .catch(() => {
          // Fallback for browsers that don't support the Clipboard API
          copyToClipboardFallback(log);
        });
    } else {
      // Fallback for older browsers
      copyToClipboardFallback(log);
    }
  }
}

function copyToClipboardFallback(text: string) {
  const tempTextArea = document.createElement("textarea");
  tempTextArea.value = text;
  tempTextArea.style.position = "fixed"; // Avoid scrolling to bottom
  document.body.appendChild(tempTextArea);
  tempTextArea.select();

  try {
    document.execCommand("copy");
    showCopySnackbar.value = true;
  } catch (err) {
    logError("Failed to copy text: ", err);
  }

  document.body.removeChild(tempTextArea);
}

defineExpose({
  deleteDialog,
  deleteComputedValues,
  showLogDialog,
  localJobLog,
  showCopySnackbar,
  currentJobId,
  jobLog,
  linkedSteps,
  runningPipeline,
  deleteProperty,
  confirmDelete,
  deleteError,
  copyLogToClipboard,
  copyToClipboardFallback,
  annotationNames,
});
</script>

<style lang="scss" scoped>
.linked-steps {
  margin: 4px 0 4px 20px;
}

.job-log {
  max-height: 400px;
  min-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  font-family: var(--nimbus-font-mono, monospace);
  font-size: 12px;
  background-color: rgba(0, 0, 0, 0.05);
  padding: 12px;
  border-radius: 4px;
  width: 100%;
  color: rgba(255, 255, 255, 0.85);
}
</style>
