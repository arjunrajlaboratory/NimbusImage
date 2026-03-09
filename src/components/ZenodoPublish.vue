<template>
  <v-card class="mb-4">
    <v-card-title class="d-flex align-center">
      <span>Zenodo Publication</span>
      <v-spacer />
      <v-chip
        v-if="zenodoStatus !== 'none'"
        :color="statusColor"
        size="small"
        text-color="white"
      >
        {{ statusLabel }}
      </v-chip>
    </v-card-title>
    <v-card-text>
      <!-- Token status -->
      <div class="d-flex align-center mb-3">
        <v-icon
          :color="hasToken ? 'success' : 'grey'"
          size="small"
          class="mr-2"
        >
          {{ hasToken ? "mdi-check-circle" : "mdi-alert-circle-outline" }}
        </v-icon>
        <span class="text-body-2">
          {{
            hasToken
              ? `Zenodo token configured${isSandbox ? " (sandbox)" : ""}`
              : "No Zenodo token configured"
          }}
        </span>
        <v-btn
          variant="text"
          size="small"
          class="ml-2"
          @click="tokenDialog = true"
        >
          {{ hasToken ? "Change" : "Configure" }}
        </v-btn>
      </div>

      <!-- Upload progress -->
      <div v-if="zenodoStatus === 'uploading' && localProgress" class="mb-3">
        <div class="text-body-2 mb-1">{{ localProgress.message }}</div>
        <v-progress-linear
          :model-value="progressPercent"
          color="primary"
          height="8"
          rounded
        />
        <div class="text-caption text-grey mt-1">
          {{ localProgress.current }} / {{ localProgress.total }} files
        </div>
      </div>

      <!-- Error display -->
      <v-alert
        v-if="zenodoStatus === 'error' && zenodoError"
        type="error"
        density="compact"
        class="mb-3"
      >
        {{ zenodoError }}
      </v-alert>

      <!-- Published info -->
      <div v-if="zenodoDoi" class="mb-3">
        <div class="text-body-2">
          <strong>DOI:</strong> {{ zenodoDoi }}
        </div>
        <div v-if="lastPublished" class="text-caption text-grey">
          Published: {{ new Date(lastPublished).toLocaleDateString() }}
        </div>
      </div>

      <!-- Draft info -->
      <div v-if="zenodoStatus === 'draft' && depositionUrl" class="mb-3">
        <v-alert type="info" density="compact">
          Draft uploaded. Review on Zenodo before publishing.
        </v-alert>
      </div>
    </v-card-text>
    <v-card-actions class="d-flex justify-end gap-2">
      <!-- View on Zenodo -->
      <v-btn
        v-if="depositionUrl"
        variant="text"
        :href="depositionUrl"
        target="_blank"
      >
        <v-icon start>mdi-open-in-new</v-icon>
        View on Zenodo
      </v-btn>

      <v-spacer />

      <!-- Discard draft -->
      <v-btn
        v-if="zenodoStatus === 'draft' || zenodoStatus === 'error'"
        color="warning"
        variant="text"
        :loading="discarding"
        @click="discardDraft"
      >
        Discard Draft
      </v-btn>

      <!-- Publish (mint DOI) -->
      <v-btn
        v-if="zenodoStatus === 'draft'"
        color="success"
        :loading="publishing"
        @click="confirmPublish = true"
      >
        <v-icon start>mdi-earth</v-icon>
        Publish (Mint DOI)
      </v-btn>

      <!-- Upload to Zenodo -->
      <v-btn
        v-if="canUpload"
        color="primary"
        :loading="uploading"
        :disabled="!hasToken"
        @click="startUpload"
      >
        <v-icon start>mdi-cloud-upload</v-icon>
        {{ zenodoStatus === 'published' ? "Upload New Version" : "Upload to Zenodo" }}
      </v-btn>
    </v-card-actions>

    <!-- Token dialog -->
    <zenodo-token-dialog
      v-model="tokenDialog"
      @saved="onTokenSaved"
    />

    <!-- Publish confirmation dialog -->
    <v-dialog v-model="confirmPublish" max-width="33vw">
      <v-card>
        <v-card-title>Publish to Zenodo?</v-card-title>
        <v-card-text>
          <v-alert type="warning" density="compact" class="mb-3">
            This action is <strong>irreversible</strong>.
          </v-alert>
          <p>
            Publishing will mint a permanent DOI for this deposition. The
            record cannot be deleted after publishing. You can only create new
            versions.
          </p>
        </v-card-text>
        <v-card-actions class="d-flex justify-end gap-2">
          <v-btn @click="confirmPublish = false">Cancel</v-btn>
          <v-btn
            color="success"
            :loading="publishing"
            @click="doPublish"
          >
            Publish
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import store from "@/store";
import jobs from "@/store/jobs";
import { logError } from "@/utils/log";
import { IProject, IJobEventData } from "@/store/model";
import { jobStates } from "@/store/jobConstants";
import ZenodoTokenDialog from "./ZenodoTokenDialog.vue";

void ZenodoTokenDialog;

const props = defineProps<{
  project: IProject;
}>();

const emit = defineEmits<{
  updated: [];
}>();

// State
const tokenDialog = ref(false);
const confirmPublish = ref(false);
const hasToken = ref(false);
const isSandbox = ref(false);
const uploading = ref(false);
const publishing = ref(false);
const discarding = ref(false);

// Local progress state, updated from job SSE events
const localProgress = ref<{
  current: number;
  total: number;
  message: string;
} | null>(null);

// Computed from project zenodo meta
const zenodoMeta = computed(() => props.project.meta.zenodo);
const zenodoStatus = computed(() => zenodoMeta.value?.status ?? "none");
const zenodoDoi = computed(() => zenodoMeta.value?.doi);
const depositionUrl = computed(() => zenodoMeta.value?.depositionUrl);
const zenodoError = computed(() => zenodoMeta.value?.error);
const lastPublished = computed(() => zenodoMeta.value?.lastPublished);

const progressPercent = computed(() => {
  if (!localProgress.value || !localProgress.value.total) return 0;
  return Math.round((localProgress.value.current / localProgress.value.total) * 100);
});

const canUpload = computed(
  () =>
    zenodoStatus.value === "none" ||
    zenodoStatus.value === "published" ||
    zenodoStatus.value === "error",
);

const statusColor = computed(() => {
  switch (zenodoStatus.value) {
    case "uploading":
      return "info";
    case "draft":
      return "warning";
    case "published":
      return "success";
    case "error":
      return "error";
    default:
      return "grey";
  }
});

const statusLabel = computed(() => {
  switch (zenodoStatus.value) {
    case "uploading":
      return "Uploading...";
    case "draft":
      return "Draft";
    case "published":
      return "Published";
    case "error":
      return "Error";
    default:
      return "";
  }
});

// Methods
async function checkToken() {
  try {
    const status = await store.zenodoAPI.getCredentials();
    hasToken.value = status.hasToken;
    isSandbox.value = status.sandbox;
  } catch {
    hasToken.value = false;
  }
}

function onTokenSaved() {
  checkToken();
}

function trackJob(jobId: string) {
  jobs.addJob({
    jobId,
    datasetId: null,
    eventCallback: (jobData: IJobEventData) => {
      // Parse progress from job log text (JSON lines)
      const text = jobData.text;
      if (text && typeof text === "string") {
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (typeof parsed.progress === "number" && parsed.message) {
              localProgress.value = {
                current: parsed.current ?? 0,
                total: parsed.total ?? 0,
                message: parsed.message,
              };
            }
          } catch {
            // not JSON, skip
          }
        }
      }

      // Handle terminal states
      const status = jobData.status;
      if (
        status !== undefined &&
        [jobStates.success, jobStates.error, jobStates.cancelled].includes(status)
      ) {
        localProgress.value = null;
        emit("updated");
      }
    },
  });
}

async function startUpload() {
  uploading.value = true;
  try {
    const response = await store.zenodoAPI.uploadProject(props.project.id);
    // Initialize local progress
    localProgress.value = {
      current: 0,
      total: response.totalFiles,
      message: "Starting upload...",
    };
    // Track job via SSE
    trackJob(response.jobId);
    emit("updated");
  } catch (error: any) {
    logError("Failed to start Zenodo upload", error);
  } finally {
    uploading.value = false;
  }
}

async function doPublish() {
  publishing.value = true;
  try {
    await store.zenodoAPI.publishProject(props.project.id);
    confirmPublish.value = false;
    emit("updated");
  } catch (error) {
    logError("Failed to publish to Zenodo", error);
  } finally {
    publishing.value = false;
  }
}

async function discardDraft() {
  discarding.value = true;
  try {
    await store.zenodoAPI.discardDraft(props.project.id);
    emit("updated");
  } catch (error) {
    logError("Failed to discard Zenodo draft", error);
  } finally {
    discarding.value = false;
  }
}

async function recoverActiveJob() {
  // If we load the page while an upload is in progress,
  // try to find the active job and re-subscribe to it
  try {
    const response = await store.girderRest.get("job", {
      params: {
        types: JSON.stringify(["zenodo_upload"]),
        statuses: JSON.stringify([0, 1, 2]),  // inactive, queued, running
        limit: 1,
        sort: "created",
        sortdir: -1,
      },
    });
    const activeJobs = response.data;
    if (activeJobs.length > 0) {
      trackJob(activeJobs[0]._id);
      // Initialize progress from project meta
      const progress = zenodoMeta.value?.progress;
      if (progress) {
        localProgress.value = {
          current: progress.current,
          total: progress.total,
          message: progress.message,
        };
      }
    }
  } catch {
    // Not critical — status will still show from project meta
  }
}

onMounted(async () => {
  checkToken();
  if (zenodoStatus.value === "uploading") {
    await recoverActiveJob();
  }
});
</script>
