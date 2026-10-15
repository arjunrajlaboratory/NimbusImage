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
          :color="hasToken ? 'success' : 'warning'"
          size="small"
          class="mr-2"
        >
          {{ hasToken ? "mdi-check-circle" : "mdi-alert-circle" }}
        </v-icon>
        <span class="text-body-2">
          {{
            hasToken
              ? `Zenodo token configured${isSandbox ? " (sandbox)" : ""}`
              : "No Zenodo token configured — required to upload"
          }}
        </span>
        <v-spacer />
        <v-btn
          v-if="hasToken"
          variant="outlined"
          color="primary"
          size="small"
          @click="tokenDialog = true"
        >
          <v-icon start>mdi-key</v-icon>
          Change Token
        </v-btn>
        <v-btn
          v-else
          variant="flat"
          color="primary"
          size="small"
          @click="tokenDialog = true"
        >
          <v-icon start>mdi-key-plus</v-icon>
          Configure Zenodo Token
        </v-btn>
      </div>

      <!-- Upload progress -->
      <!-- TODO(#1075): wire into the app-wide progress store so the bar
           remains visible after navigating away from this page. -->
      <div v-if="zenodoStatus === 'uploading' || localProgress" class="mb-3">
        <div class="text-body-2 mb-1">
          {{ localProgress?.message || "Upload in progress…" }}
        </div>
        <v-progress-linear
          :indeterminate="!localProgress || localProgress.total === 0"
          :model-value="progressPercent"
          color="primary"
          height="8"
          rounded
        />
        <div
          v-if="localProgress && localProgress.total > 0"
          class="text-caption text-grey mt-1"
        >
          {{ localProgress.current }} / {{ localProgress.total }} files
        </div>
        <div class="text-caption text-grey mt-1">
          Uploads can take several minutes for large projects. You can keep
          using NimbusImage in another tab while this runs.
        </div>
      </div>

      <!-- Requests refused by the server, one alert per request. Publish
           errors show in the publish dialog instead. -->
      <v-alert
        v-for="request in cardErrorRequests"
        :key="request"
        type="error"
        density="compact"
        closable
        class="mb-3"
        data-testid="zenodo-request-error"
        @click:close="requestErrors[request] = null"
      >
        {{ requestErrors[request] }}
      </v-alert>

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
        <div class="text-body-2"><strong>DOI:</strong> {{ zenodoDoi }}</div>
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
        variant="outlined"
        color="primary"
        size="small"
        :href="depositionUrl"
        target="_blank"
      >
        <v-icon start>mdi-open-in-new</v-icon>
        View on Zenodo
      </v-btn>

      <!-- Discard draft -->
      <v-btn
        v-if="zenodoStatus === 'draft' || zenodoStatus === 'error'"
        variant="outlined"
        color="error"
        size="small"
        :loading="discarding"
        :disabled="requestInFlight"
        @click="discardDraft"
      >
        <v-icon start>mdi-delete</v-icon>
        Discard Draft
      </v-btn>

      <!-- Publish (mint DOI) -->
      <v-btn
        v-if="zenodoStatus === 'draft'"
        variant="flat"
        color="success"
        size="small"
        :loading="publishing"
        :disabled="requestInFlight"
        @click="openPublishConfirm"
      >
        <v-icon start>mdi-earth</v-icon>
        Publish (Mint DOI)
      </v-btn>

      <!-- Upload to Zenodo -->
      <!-- Hidden once an upload is in flight; the progress section above
           is the single source of truth for "work is happening". -->
      <v-tooltip
        v-if="canUpload && !localProgress"
        location="top"
        :disabled="hasToken"
        text="Configure a Zenodo token to enable upload"
      >
        <template #activator="{ props: tooltipProps }">
          <!-- span wrapper lets the tooltip activate over a disabled button -->
          <span v-bind="tooltipProps">
            <v-btn
              variant="flat"
              color="primary"
              size="small"
              :disabled="!hasToken || requestInFlight"
              @click="startUpload"
            >
              <v-icon start>mdi-cloud-upload</v-icon>
              {{
                zenodoStatus === "published"
                  ? "Upload New Version"
                  : "Upload to Zenodo"
              }}
            </v-btn>
          </span>
        </template>
      </v-tooltip>
    </v-card-actions>

    <!-- Token dialog -->
    <zenodo-token-dialog v-model="tokenDialog" @saved="onTokenSaved" />

    <!-- Publish confirmation dialog -->
    <!-- Can't be dismissed while publishing, so the result (and any error)
         always lands in this dialog. -->
    <v-dialog
      v-model="confirmPublish"
      max-width="33vw"
      :persistent="publishing"
    >
      <v-card>
        <v-card-title>Publish to Zenodo?</v-card-title>
        <v-card-text>
          <v-alert
            v-if="requestErrors.publish"
            type="error"
            density="compact"
            closable
            class="mb-3"
            data-testid="zenodo-publish-error"
            @click:close="requestErrors.publish = null"
          >
            {{ requestErrors.publish }}
          </v-alert>
          <v-alert type="warning" density="compact" class="mb-3">
            This action is <strong>irreversible</strong>.
          </v-alert>
          <p>
            Publishing will mint a permanent DOI for this deposition. The record
            cannot be deleted after publishing. You can only create new
            versions.
          </p>
        </v-card-text>
        <v-card-actions class="d-flex justify-end gap-2">
          <v-btn
            variant="text"
            size="small"
            :disabled="publishing"
            @click="confirmPublish = false"
            >Cancel</v-btn
          >
          <v-btn
            variant="flat"
            color="success"
            size="small"
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
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import store from "@/store";
import jobs from "@/store/jobs";
import { logError } from "@/utils/log";
import { extractErrorMessage } from "@/utils/errors";
import { isAxiosError } from "axios";
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
const publishing = ref(false);
const discarding = ref(false);
const startingUpload = ref(false);
// Upload, publish and discard all change the same deposition and
// meta.zenodo, so only one may be in flight. Every action button checks
// this one flag rather than a pairwise guard per combination.
const requestInFlight = computed(
  () =>
    publishing.value ||
    discarding.value ||
    startingUpload.value ||
    // An upload this card started or follows is still running; the project
    // may not say "uploading" yet (the refresh hasn't landed).
    !!trackedJobId.value,
);
// The server's refusal message for each request, or null. Kept per request
// so one request starting or failing never hides or relabels another's.
type TZenodoRequest = "upload" | "discard" | "publish";
const requestErrors = ref<Record<TZenodoRequest, string | null>>({
  upload: null,
  discard: null,
  publish: null,
});
const cardErrorRequests = computed(() =>
  (["upload", "discard"] as const).filter((r) => requestErrors.value[r]),
);

// The upload job this card is subscribed to, so it subscribes once per job.
const trackedJobId = ref<string | null>(null);
const recoveringJob = ref(false);
// While an upload runs, poll its status: the one signal that always says
// when it ends. Job SSE events add live progress and an earlier end, but
// may never come: a co-owner's job is invisible to this user, and the
// notification socket gives up after repeated errors.
const UPLOAD_STATUS_POLL_MS = 10_000;
let uploadStatusPoll: ReturnType<typeof setTimeout> | null = null;
let unmounted = false;

function stopUploadStatusPoll() {
  if (uploadStatusPoll !== null) clearTimeout(uploadStatusPoll);
  uploadStatusPoll = null;
}

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
  return Math.round(
    (localProgress.value.current / localProgress.value.total) * 100,
  );
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
const CONTENTS_ACCESS_HINT =
  "Publishing to Zenodo requires owner access to every dataset and " +
  "collection in the project. Ask their owners for owner access, or " +
  "remove them from the project.";

// Girder's AccessException names the model by its collection name: "Admin
// access denied for folder <id> (user <id>)." for a dataset, and
// "upenn_collection" / "upenn_project" for the plugin's models. Only a
// dataset or collection refusal gets the hint; a project-level refusal is
// explained by its own message.
const CONTENTS_ACCESS_DENIED = /access denied for (folder|upenn_collection) /i;

function showRequestError(request: TZenodoRequest, error: unknown) {
  const message = extractErrorMessage(error);
  // Upload and publish (not discard) require ADMIN on every dataset and
  // collection in the project, not just on the project.
  requestErrors.value[request] =
    request !== "discard" &&
    isAxiosError(error) &&
    error.response?.status === 403 &&
    CONTENTS_ACCESS_DENIED.test(message)
      ? `${message.replace(/\.$/, "")}. ${CONTENTS_ACCESS_HINT}`
      : message;
}

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
  // A missing/invalid-token refusal no longer applies.
  requestErrors.value.upload = null;
  requestErrors.value.publish = null;
  checkToken();
}

function trackJob(jobId: string) {
  // addJob appends a listener per call; a second one would double every
  // progress update and terminal refresh.
  if (trackedJobId.value === jobId) return;
  trackedJobId.value = jobId;
  jobs.addJob({
    jobId,
    datasetId: null,
    eventCallback: (jobData: IJobEventData) => {
      // This job may already be released (the status poll can see it end
      // before its events arrive) and a newer upload tracked; its late
      // progress or terminal event must not touch that one.
      if (trackedJobId.value !== jobId) return;
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
        [jobStates.success, jobStates.error, jobStates.cancelled].includes(
          status,
        )
      ) {
        localProgress.value = null;
        trackedJobId.value = null;
        emit("updated");
      }
    },
  });
}

async function startUpload() {
  // Render the progress section immediately (indeterminate) so the user
  // sees something while the request to kick off the job is in flight,
  // before zenodoStatus refreshes to "uploading". localProgress hides the
  // upload button; startingUpload (via requestInFlight) disables the other
  // actions.
  localProgress.value = {
    current: 0,
    total: 0,
    message: "Starting upload…",
  };
  startingUpload.value = true;
  requestErrors.value.upload = null;
  try {
    const response = await store.zenodoAPI.uploadProject(props.project.id);
    localProgress.value = {
      current: 0,
      total: response.totalFiles,
      message: "Starting upload…",
    };
    // Track job via SSE
    trackJob(response.jobId);
    emit("updated");
  } catch (error) {
    localProgress.value = null;
    logError("Failed to start Zenodo upload", error);
    showRequestError("upload", error);
    // 409: another tab or session is already uploading. Follow that upload
    // before startingUpload clears, so the actions stay locked through the
    // window before the refreshed status lands, then refresh so the card
    // shows it. (With no visible job, recovery has already asked for the
    // refresh.)
    if (isAxiosError(error) && error.response?.status === 409) {
      if (await recoverActiveJob()) emit("updated");
    }
  } finally {
    startingUpload.value = false;
  }
}

function openPublishConfirm() {
  requestErrors.value.publish = null;
  confirmPublish.value = true;
}

async function doPublish() {
  publishing.value = true;
  requestErrors.value.publish = null;
  try {
    await store.zenodoAPI.publishProject(props.project.id);
    confirmPublish.value = false;
    emit("updated");
  } catch (error) {
    logError("Failed to publish to Zenodo", error);
    showRequestError("publish", error);
  } finally {
    publishing.value = false;
  }
}

async function discardDraft() {
  discarding.value = true;
  requestErrors.value.discard = null;
  try {
    await store.zenodoAPI.discardDraft(props.project.id);
    emit("updated");
  } catch (error) {
    logError("Failed to discard Zenodo draft", error);
    showRequestError("discard", error);
  } finally {
    discarding.value = false;
  }
}

function scheduleUploadStatusPoll() {
  stopUploadStatusPoll();
  uploadStatusPoll = setTimeout(async () => {
    uploadStatusPoll = null;
    if (!uploadRunning.value) return;
    // The upload this answer is about. A newer one can start while the
    // request is out; the answer must not release it.
    const polledJobId = trackedJobId.value;
    try {
      const { status } = await store.zenodoAPI.getUploadStatus(
        props.project.id,
      );
      if (unmounted) return;
      if (
        status !== "uploading" &&
        trackedJobId.value === polledJobId &&
        !startingUpload.value
      ) {
        // The server says it's over: release the job (its terminal event
        // may never come) and re-read the project. While the project copy
        // still reads "uploading", keep polling in case that re-read fails.
        trackedJobId.value = null;
        localProgress.value = null;
        emit("updated");
      }
    } catch (error) {
      logError("Failed to check Zenodo upload status", error);
    }
    if (unmounted || !uploadRunning.value) return;
    scheduleUploadStatusPoll();
  }, UPLOAD_STATUS_POLL_MS);
}

async function recoverActiveJob(): Promise<boolean> {
  // An upload this card didn't start (page load mid-upload, a 409, another
  // tab): ask the server which job it is (this card's project copy may be
  // stale) and subscribe to its SSE stream. Returns whether it subscribed.
  recoveringJob.value = true;
  try {
    const status = await store.zenodoAPI.getUploadStatus(props.project.id);
    // Unmounted (e.g. switched project), or startUpload subscribed, while
    // this was in flight.
    if (unmounted || trackedJobId.value) return false;
    const jobId =
      status.status === "uploading" && status.jobId
        ? await store.zenodoAPI.getLiveUploadJobId(status.jobId)
        : null;
    if (unmounted || trackedJobId.value) return false;
    if (!jobId) {
      // The project says "uploading" but there is no live upload job this
      // user can see: the project copy is stale (cached, or a refresh
      // landed out of order), or the upload is a co-owner's, whose job
      // Girder never shows us. Re-read the project; the status poll covers
      // the rest.
      emit("updated");
      return false;
    }
    trackJob(jobId);
    // Seed progress until the next SSE event arrives.
    if (status.progress) {
      localProgress.value = {
        current: status.progress.current,
        total: status.progress.total,
        message: status.progress.message,
      };
    }
    return true;
  } catch (error) {
    // Re-read the project; while it says "uploading" the status poll keeps
    // checking, so a failed lookup can't leave the card stuck.
    logError("Failed to look up the Zenodo upload job", error);
    if (!unmounted) emit("updated");
    return false;
  } finally {
    recoveringJob.value = false;
  }
}

// Whenever the project reports an upload this card isn't following, follow
// it, so the card leaves "uploading" when the job ends.
watch(
  zenodoStatus,
  (status, oldStatus) => {
    // The server says the upload is over. Drop the subscription even if its
    // terminal job event never arrived (the notification socket can give
    // up), or every action would stay disabled. Only on leaving
    // "uploading": right after startUpload the status can still read
    // "error" while the new job runs.
    if (oldStatus === "uploading" && status !== "uploading") {
      trackedJobId.value = null;
      localProgress.value = null;
    }
    if (status === "uploading" && !trackedJobId.value && !recoveringJob.value) {
      recoverActiveJob();
    }
  },
  { immediate: true },
);

onMounted(() => {
  checkToken();
});

// An upload is running as far as this card knows: the project says so, or
// the card follows a job (its project copy can lag behind a just-started
// upload or a 409).
const uploadRunning = computed(
  () => zenodoStatus.value === "uploading" || !!trackedJobId.value,
);
watch(
  uploadRunning,
  (running) => (running ? scheduleUploadStatusPoll() : stopUploadStatusPoll()),
  { immediate: true },
);

onBeforeUnmount(() => {
  unmounted = true;
  stopUploadStatusPoll();
});
</script>
