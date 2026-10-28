<template>
  <v-container class="pa-0">
    <v-row class="my-0" density="comfortable">
      <v-col cols="12" class="py-1">
        <v-text-field
          v-model="localPipeline.name"
          label="Pipeline name"
          density="compact"
          hide-details
          :disabled="isRunningThis"
        />
      </v-col>
    </v-row>
    <v-row class="my-0" density="comfortable">
      <v-col class="py-1">
        <v-textarea
          v-model="localPipeline.description"
          label="Description"
          density="compact"
          rows="2"
          auto-grow
          hide-details
          :disabled="isRunningThis"
        />
      </v-col>
    </v-row>

    <v-alert v-if="saveError" type="error" density="compact" class="my-2">
      {{ saveError }}
    </v-alert>

    <v-alert
      v-for="(warning, index) in preRunWarnings"
      :key="'warning-' + index"
      type="warning"
      density="compact"
      class="my-2"
    >
      {{ warning }}
    </v-alert>

    <v-row
      v-if="localPipeline.steps.length === 0"
      class="my-2"
      density="comfortable"
    >
      <v-col class="text-caption text-medium-emphasis">
        No steps yet. Add a step to get started.
      </v-col>
    </v-row>

    <v-expansion-panels v-else variant="accordion" class="my-2">
      <v-expansion-panel
        v-for="(step, index) in displayedPipeline.steps"
        :key="step.id"
      >
        <v-expansion-panel-title>
          <div class="d-flex align-center step-title">
            <!-- Run status doubles as the step's kind icon: a spinner while
                 running, a status glyph after, the kind icon at rest. -->
            <v-progress-circular
              v-if="statuses[index]?.status === 'running'"
              indeterminate
              size="18"
              width="2"
              color="primary"
              class="mr-2"
            />
            <v-icon
              v-else-if="hasRunStatus(index)"
              size="small"
              class="mr-2"
              :color="stepStatusColor(statuses[index]?.status)"
            >
              {{ stepStatusIcon(statuses[index]?.status) }}
            </v-icon>
            <v-icon v-else size="small" class="mr-2">
              {{
                step.kind === "annotation"
                  ? "mdi-shape-outline"
                  : "mdi-ruler-square-compass"
              }}
            </v-icon>
            <span class="flex-grow-1">
              {{ index + 1 }}. {{ step.name || step.image }}
              <span class="text-caption text-medium-emphasis ml-1"
                >({{ step.kind }})</span
              >
            </span>
            <v-btn
              v-if="controller.jobIdFor(localPipeline, index)"
              variant="text"
              color="info"
              size="x-small"
              class="mr-2"
              @click.stop="openStepLog(index)"
            >
              <v-icon size="small" start>mdi-text-box-outline</v-icon>
              Logs
            </v-btn>
            <v-chip
              v-if="linkStates[index].state === 'linked'"
              size="x-small"
              color="info"
              variant="tonal"
              class="mr-2"
            >
              <v-icon start size="x-small">mdi-link-variant</v-icon>
              {{ linkedSourceName(index) }}
            </v-chip>
            <v-chip
              v-else-if="linkStates[index].state === 'missing'"
              size="x-small"
              color="warning"
              variant="tonal"
              class="mr-2"
            >
              <v-icon start size="x-small">mdi-link-variant-off</v-icon>
              {{ unusableSourceLabel(index) }}
            </v-chip>
            <v-chip v-if="!step.enabled" size="x-small" class="mr-2"
              >disabled</v-chip
            >
          </div>
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <div v-if="statuses[index]?.status === 'running'" class="mb-2">
            <v-progress-linear
              :indeterminate="!statuses[index].progress.progress"
              :model-value="100 * (statuses[index].progress.progress || 0)"
              color="primary"
              height="6"
            />
            <span class="text-caption">
              {{ statuses[index].progress.title }}
              {{ statuses[index].progress.info }}
            </span>
          </div>
          <template v-if="statuses[index]?.errors.errors.length">
            <v-alert
              v-for="(err, errIndex) in statuses[index].errors.errors"
              :key="'err-' + errIndex"
              :type="err.type === MessageType.WARNING ? 'warning' : 'error'"
              density="compact"
              class="mb-2"
            >
              {{ err.title ? err.title + ": " : ""
              }}{{ err.error || err.warning }}
            </v-alert>
          </template>

          <pipeline-step-editor
            :model-value="step"
            :auto-wired-caption="stepCaptions[index]"
            :link-state="linkStates[index]"
            @update:model-value="handleStepUpdate(index, $event)"
          />
          <v-row class="my-0" density="comfortable">
            <v-col class="d-flex ga-2 py-1 align-center">
              <v-btn
                variant="text"
                size="small"
                :disabled="index === 0 || isRunningThis"
                @click="moveStep(index, -1)"
              >
                <v-icon start>mdi-arrow-up</v-icon>
                Move up
              </v-btn>
              <v-btn
                variant="text"
                size="small"
                :disabled="
                  index === localPipeline.steps.length - 1 || isRunningThis
                "
                @click="moveStep(index, 1)"
              >
                <v-icon start>mdi-arrow-down</v-icon>
                Move down
              </v-btn>
              <v-spacer />
              <v-btn
                variant="text"
                color="error"
                size="small"
                :disabled="isRunningThis"
                @click="askRemoveStep(index)"
              >
                <v-icon start>mdi-delete</v-icon>
                Remove
              </v-btn>
            </v-col>
          </v-row>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <v-row class="my-2" density="comfortable">
      <v-col class="py-1">
        <v-btn
          variant="outlined"
          color="primary"
          size="small"
          :disabled="isRunningThis"
          @click="openAddStepDialog"
        >
          <v-icon start>mdi-plus</v-icon>
          Add step
        </v-btn>
      </v-col>
    </v-row>

    <!-- Run options -->
    <v-row class="my-0" density="comfortable">
      <v-col class="py-1">
        <v-checkbox
          v-model="controller.continueOnError.value"
          label="Continue running remaining steps if a step fails"
          density="compact"
          hide-details
          :disabled="controller.isRunning.value"
        />
      </v-col>
    </v-row>
    <v-row
      v-if="
        controller.canApplyToAllDatasets.value ||
        controller.batchDisabledReason.value
      "
      class="my-0"
      density="comfortable"
    >
      <v-col class="py-1">
        <v-tooltip
          location="bottom"
          :disabled="!controller.batchDisabledReason.value"
        >
          <template v-slot:activator="{ props: activatorProps }">
            <div v-bind="activatorProps" class="d-inline-block">
              <v-checkbox
                v-model="controller.applyToAllDatasets.value"
                :label="`Apply to all datasets in collection (${controller.collectionDatasetCount.value})`"
                :disabled="
                  controller.isRunning.value ||
                  !controller.canApplyToAllDatasets.value ||
                  !!controller.batchProgress.value
                "
                density="compact"
                hide-details
              />
            </div>
          </template>
          <span>{{ controller.batchDisabledReason.value }}</span>
        </v-tooltip>
      </v-col>
    </v-row>

    <v-alert
      v-if="controller.runNotice.value"
      type="warning"
      density="compact"
      class="my-2"
      closable
      @click:close="controller.runNotice.value = null"
    >
      {{ controller.runNotice.value }}
    </v-alert>

    <v-row class="my-2" density="comfortable">
      <v-col class="d-flex ga-2 py-1 justify-end align-center">
        <!-- Saved / unsaved chrome, pushed to the left of the action buttons. -->
        <v-chip
          v-if="isDirty"
          size="small"
          color="warning"
          variant="tonal"
          class="me-auto"
        >
          <v-icon start size="small">mdi-circle-medium</v-icon>
          Unsaved changes
        </v-chip>
        <span
          v-else
          class="me-auto d-flex align-center text-caption text-medium-emphasis"
        >
          <v-icon size="small" color="success" class="mr-1">
            mdi-check-circle-outline
          </v-icon>
          Saved
        </span>
        <v-btn
          variant="text"
          size="small"
          :loading="saving"
          :disabled="!canSave || isRunningThis || !isDirty"
          @click="save"
        >
          Save
        </v-btn>
        <v-btn
          v-if="isRunningThis"
          variant="text"
          color="warning"
          size="small"
          @click="controller.cancel"
        >
          <v-progress-circular size="16" indeterminate class="mr-2" />
          Cancel
        </v-btn>
        <v-btn
          v-else
          variant="flat"
          color="primary"
          size="small"
          :loading="saving"
          :disabled="!canRun"
          @click="saveAndRun"
        >
          <v-icon start>mdi-play</v-icon>
          Run
        </v-btn>
      </v-col>
    </v-row>

    <!-- Add step dialog -->
    <v-dialog v-model="showAddStepDialog" max-width="600">
      <v-card>
        <v-card-title>Add step</v-card-title>
        <v-card-text>
          <v-btn-toggle
            v-model="newStepSource"
            mandatory
            density="compact"
            class="mb-4"
          >
            <v-btn value="annotation" variant="outlined" size="small">
              Annotation worker
            </v-btn>
            <v-btn value="property" variant="outlined" size="small">
              Property worker
            </v-btn>
            <v-btn
              value="tool"
              variant="outlined"
              size="small"
              :disabled="workerTools.length === 0"
            >
              Existing tool
            </v-btn>
            <v-btn
              value="existingProperty"
              variant="outlined"
              size="small"
              :disabled="linkableProperties.length === 0"
            >
              Existing property
            </v-btn>
          </v-btn-toggle>
          <v-select
            v-if="newStepSource === 'tool'"
            v-model="newStepToolId"
            label="Tool"
            :items="workerTools"
            item-title="name"
            item-value="id"
            density="compact"
            hint="Links the step to the tool: it runs with the tool's current parameters and output tags. Edit them in the Tools panel, or unlink the step to customize it"
            persistent-hint
          />
          <v-select
            v-else-if="newStepSource === 'existingProperty'"
            v-model="newStepPropertyId"
            label="Property"
            :items="linkableProperties"
            item-title="name"
            item-value="id"
            density="compact"
            hint="Links the step to the property: the pipeline computes that property as it is defined"
            persistent-hint
          />
          <docker-image-select
            v-else
            v-model="newStepImage"
            :imageFilter="newStepImageFilter"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" size="small" @click="showAddStepDialog = false">
            Cancel
          </v-btn>
          <v-btn
            variant="flat"
            color="primary"
            size="small"
            :disabled="!canConfirmAddStep"
            @click="confirmAddStep"
          >
            Add
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Removing a property step can also remove the persisted property that
         the runner created for it. Defer both choices until Save. -->
    <v-dialog v-model="showRemoveStepDialog" max-width="440">
      <v-card>
        <v-card-title>Remove property step</v-card-title>
        <v-card-text>
          Remove "{{ stepToRemove?.name }}" from this pipeline?
          <v-checkbox
            v-model="removeMaterializedProperty"
            label="Also remove the computed property created by this step"
            density="compact"
            hide-details
            class="mt-2"
          />
          <div class="text-caption text-medium-emphasis mt-2">
            The property is removed only after you save the pipeline, and is
            kept if another pipeline step still uses it.
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn
            variant="text"
            size="small"
            @click="showRemoveStepDialog = false"
          >
            Cancel
          </v-btn>
          <v-btn
            variant="flat"
            color="error"
            size="small"
            @click="confirmRemoveStep"
          >
            Remove
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <job-log-dialog
      v-model="showLogDialog"
      :job-id="logDialogJobId"
      :title="logDialogTitle"
    />

    <v-snackbar
      v-model="showSavedSnackbar"
      :timeout="2000"
      color="success"
      location="top"
    >
      Pipeline saved
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from "vue";
import { cloneDeep, omit } from "lodash";
import store from "@/store";
import pipelinesStore, {
  mergeMaterializedPropertyIds,
} from "@/store/pipelines";
import {
  propertyLinkedFields,
  resolveLinkedStep,
  samePersistedValue,
  stepLinkState,
  toolLinkedFields,
  TStepLinkState,
} from "@/utils/pipelineLinks";
import { computeAutoWiredSteps } from "@/utils/pipelineWiring";
import propertiesStore from "@/store/properties";
import annotationStore from "@/store/annotation";
import { logError } from "@/utils/log";
import DockerImageSelect from "@/components/DockerImageSelect.vue";
import PipelineStepEditor from "@/components/pipelines/PipelineStepEditor.vue";
import JobLogDialog from "@/components/JobLogDialog.vue";
import { buildDefaultCoordinateAssignments } from "@/tools/creation/toolFromCatalog";
import {
  PipelineRunController,
  PipelineRunControllerKey,
  stepStatusColor,
  stepStatusIcon,
} from "@/components/pipelines/usePipelineRun";
import {
  AnnotationShape,
  IAnnotationPipelineStep,
  IAnnotationSetup,
  IPipeline,
  IPropertyPipelineStep,
  IWorkerLabels,
  MessageType,
  TPipelineStep,
  TPipelineStepKind,
} from "@/store/model";

// Unified build-and-run view: the same editable step list also shows each
// step's live run status, and the footer runs the pipeline (saving first).
const props = defineProps<{
  pipeline: IPipeline;
}>();

// Surface the unsaved/saved state to the dialog so it can mirror the chip in
// its header (the footer chip below is driven by the same `isDirty`).
const emit = defineEmits<{
  (e: "update:dirty", dirty: boolean): void;
}>();

const controller = inject<PipelineRunController>(PipelineRunControllerKey)!;

// The loaded property list, if it is this configuration's: right after a
// switch it is still the previous configuration's until the new fetch lands,
// and its properties may not be registered here (see propertiesOf in the
// pipelines store, which the runner uses for the same reason).
const configurationProperties = computed(() =>
  propertiesStore.propertiesConfigurationId === store.configuration?.id
    ? propertiesStore.properties
    : [],
);

// The working copy, edited as a deep clone so nothing is persisted until
// Save/Run. Re-cloned only when pointed at a *different* pipeline (id change).
//
// Linked steps are read-only apart from their name and enabled flag: they are
// shown, run and saved with their source's live values (edited in the Tools
// panel, not here). See "Linked steps" in WORKER_PIPELINES.md.
const localPipeline = ref<IPipeline>(clonePipelineForEditing(props.pipeline));

// A pipeline's steps as shown and as saved: linked steps take their live
// source's values (their saved copy stays the fallback if the source goes),
// then auto-wiring is applied (so `autoWired` property steps arriving
// unwired are wired on open).
function displayedSteps(steps: TPipelineStep[]): TPipelineStep[] {
  return computeAutoWiredSteps(
    steps.map((step) =>
      resolveLinkedStep(step, store.tools, configurationProperties.value),
    ),
  );
}

// Auto-wired property steps keep their wired tags on the working copy (as
// shown), so a step keeps them if its upstream step is later removed or
// disabled, rather than falling back to the tags it had before wiring.
function withWiredTags(steps: TPipelineStep[]): TPipelineStep[] {
  const wired = displayedSteps(steps);
  return steps.map((step, index) =>
    step.kind === "property" && !step.sourcePropertyId ? wired[index] : step,
  );
}

function clonePipelineForEditing(pipeline: IPipeline): IPipeline {
  const clone = cloneDeep(pipeline);
  return { ...clone, steps: withWiredTags(clone.steps) };
}

// Steps on their own computed, so typing a pipeline name or description does
// not re-resolve every step (and hand step editors new values to re-emit).
const displayedStepList = computed(() =>
  displayedSteps(localPipeline.value.steps),
);
const displayedPipeline = computed<IPipeline>(() => ({
  ...localPipeline.value,
  steps: displayedStepList.value,
}));

// A linked property that has not loaded yet would read as deleted; reload the
// configuration's properties once if one is missing, as the runner does.
function loadMissingLinkedProperties() {
  pipelinesStore.loadMissingLinkedProperties(localPipeline.value);
}

watch(
  () => props.pipeline.id,
  () => {
    localPipeline.value = clonePipelineForEditing(props.pipeline);
    loadMissingLinkedProperties();
    materializedPropertyIdsToRemove.value = [];
    showRemoveStepDialog.value = false;
    stepToRemoveIndex.value = null;
  },
);

// What a pipeline looks like for the unsaved-changes comparison: shown as the
// editor shows it, without the runner's materializedPropertyId write-backs
// (which land on the stored copy only).
function comparable(pipeline: IPipeline, steps: TPipelineStep[]) {
  return {
    ...pipeline,
    steps: steps.map((step) => omit(step, "materializedPropertyId")),
  };
}

// Dirty = what the editor shows differs from what the stored pipeline shows
// (both through the same live tools and properties, so a source changed
// elsewhere is not an unsaved change here), or the pipeline was never saved.
// Compared as persisted (samePersistedValue): a child editor re-emitting an
// untouched value with explicit `undefined` keys is not an edit.
// The stored side is its own computed, so typing in the editor does not
// re-resolve the stored pipeline on every keystroke.
const storedPipelineForComparison = computed(() => {
  const stored = pipelinesStore.getPipelineById(localPipeline.value.id);
  return stored && comparable(stored, displayedSteps(stored.steps));
});
const isDirty = computed(
  () =>
    !storedPipelineForComparison.value ||
    !samePersistedValue(
      comparable(displayedPipeline.value, displayedPipeline.value.steps),
      storedPipelineForComparison.value,
    ),
);

watch(isDirty, (dirty) => emit("update:dirty", dirty), { immediate: true });

const saving = ref(false);
const saveError = ref<string | null>(null);
const showSavedSnackbar = ref(false);

const isRunningThis = computed(() =>
  controller.isRunningPipeline(localPipeline.value.id),
);

const canSave = computed(
  () => !!localPipeline.value.name && localPipeline.value.steps.length > 0,
);

const canRun = computed(
  () => canSave.value && controller.canRunPipeline(localPipeline.value),
);

// Per-step run status for this pipeline (live arrays if it is the active run,
// otherwise a pending baseline).
const statuses = computed(() => controller.statusesFor(localPipeline.value));

function hasRunStatus(index: number): boolean {
  const status = statuses.value[index]?.status;
  return status === "success" || status === "error" || status === "cancelled";
}

// ---- Job logs ---------------------------------------------------------
const showLogDialog = ref(false);
const logDialogJobId = ref<string | null>(null);
const logDialogTitle = ref("");

function openStepLog(index: number) {
  logDialogJobId.value = controller.jobIdFor(localPipeline.value, index);
  logDialogTitle.value = `Step log: ${localPipeline.value.steps[index]?.name ?? ""}`;
  showLogDialog.value = true;
}

// ---- Pre-run validation (WORKER_PIPELINES.md §5) ----------------------
// Flag property steps whose input tags match neither an enabled upstream
// annotation step's output tags nor any tag already present on the dataset.
const preRunWarnings = computed<string[]>(() => {
  const warnings: string[] = [];
  const knownTags = new Set<string>(annotationStore.annotationTags);
  displayedPipeline.value.steps.forEach((step, index) => {
    if (step.kind === "annotation") {
      if (step.enabled) {
        step.annotation.tags.forEach((tag) => knownTags.add(tag));
      }
      return;
    }
    if (!step.enabled) {
      return;
    }
    const tags = step.inputTags.tags;
    if (tags.length === 0) {
      return;
    }
    if (!tags.some((tag) => knownTags.has(tag))) {
      warnings.push(
        `Step ${index + 1} (${step.name}): none of its input tags (${tags.join(", ")}) match any upstream output or existing annotation tags — it may compute on nothing.`,
      );
    }
  });
  return warnings;
});

// ---- Tag auto-wiring (spec: WORKER_PIPELINES.md §5) -------------------
const stepCaptions = computed<(string | null)[]>(() => {
  let lastAnnotation: { index: number; step: IAnnotationPipelineStep } | null =
    null;
  return displayedPipeline.value.steps.map((step, index) => {
    if (step.kind === "annotation") {
      if (step.enabled) {
        lastAnnotation = { index, step };
      }
      return null;
    }
    if (step.autoWired !== true || step.sourcePropertyId) {
      return null;
    }
    if (!lastAnnotation) {
      return "No preceding annotation step — add one above to auto-wire tags";
    }
    return `Reads tags from step ${lastAnnotation.index + 1} (${lastAnnotation.step.name})`;
  });
});

// An auto-wired step's wiring as shown can be newer than the working copy's:
// it follows its upstream step live (a linked tool's output tags change in the
// Tools panel). Carry the shown wiring over before applying a change, so a
// step whose upstream is then removed or disabled keeps what was last shown,
// not the tags it had when the editor opened.
function updateSteps(steps: TPipelineStep[]) {
  const shown = new Map(displayedStepList.value.map((s) => [s.id, s]));
  localPipeline.value.steps = withWiredTags(
    steps.map((step) => {
      const displayed = shown.get(step.id);
      return step.kind === "property" &&
        step.autoWired === true &&
        !step.sourcePropertyId &&
        displayed?.kind === "property"
        ? // Only what wiring owns: the step's own settings (exclusive match)
          // may be what this change edits.
          {
            ...step,
            inputTags: { ...step.inputTags, tags: displayed.inputTags.tags },
            shape: displayed.shape,
          }
        : step;
    }),
  );
}

const linkStates = computed<TStepLinkState[]>(() =>
  localPipeline.value.steps.map((step) =>
    stepLinkState(step, store.tools, configurationProperties.value),
  ),
);

function unusableSourceLabel(index: number): string {
  const linkState = linkStates.value[index];
  if (linkState?.state !== "missing") {
    return "";
  }
  if (linkState.reason === "noWorker") {
    return "tool has no worker";
  }
  return linkState.sourceKind === "tool"
    ? "source deleted"
    : "source unavailable";
}

function linkedSourceName(index: number): string {
  const linkState = linkStates.value[index];
  return linkState?.state === "linked" ? linkState.sourceName : "";
}

function isLinkedStep(step: TPipelineStep): boolean {
  return step.kind === "annotation"
    ? !!step.sourceToolId
    : !!step.sourcePropertyId;
}

// `newStep` is the displayed step with the user's change. A still-linked step
// keeps only its own name and enabled flag (its settings are its source's,
// and its saved copy, the fallback if the source goes, must stay the
// source's); anything else, including Unlink, replaces the step. Child
// editors re-emit whenever their value's identity changes, so an emit that
// changes nothing must change no state.
function handleStepUpdate(index: number, newStep: TPipelineStep) {
  if (samePersistedValue(newStep, displayedPipeline.value.steps[index])) {
    return;
  }
  const steps = localPipeline.value.steps.slice();
  steps[index] = isLinkedStep(newStep)
    ? { ...steps[index], name: newStep.name, enabled: newStep.enabled }
    : newStep;
  updateSteps(steps);
}

function moveStep(index: number, direction: -1 | 1) {
  const steps = localPipeline.value.steps.slice();
  const target = index + direction;
  if (target < 0 || target >= steps.length) {
    return;
  }
  [steps[index], steps[target]] = [steps[target], steps[index]];
  updateSteps(steps);
}

function removeStep(index: number) {
  const steps = localPipeline.value.steps.slice();
  steps.splice(index, 1);
  updateSteps(steps);
}

const showRemoveStepDialog = ref(false);
const stepToRemoveIndex = ref<number | null>(null);
const removeMaterializedProperty = ref(true);
const materializedPropertyIdsToRemove = ref<string[]>([]);

const stepToRemove = computed(() =>
  stepToRemoveIndex.value === null
    ? null
    : localPipeline.value.steps[stepToRemoveIndex.value] ?? null,
);

// The step's materialized property: the runner records it on the stored
// pipeline, which this working copy may not have picked up yet.
function materializedPropertyIdOf(step: TPipelineStep): string | undefined {
  if (step.kind !== "property") {
    return undefined;
  }
  const stored = pipelinesStore
    .getPipelineById(localPipeline.value.id)
    ?.steps.find((s) => s.id === step.id);
  return (
    step.materializedPropertyId ??
    (stored?.kind === "property" ? stored.materializedPropertyId : undefined)
  );
}

function askRemoveStep(index: number) {
  const step = localPipeline.value.steps[index];
  if (!step || !materializedPropertyIdOf(step)) {
    removeStep(index);
    return;
  }
  stepToRemoveIndex.value = index;
  removeMaterializedProperty.value = true;
  showRemoveStepDialog.value = true;
}

function confirmRemoveStep() {
  const index = stepToRemoveIndex.value;
  const step = stepToRemove.value;
  if (index === null || !step) {
    return;
  }
  const materializedPropertyId = materializedPropertyIdOf(step);
  if (
    removeMaterializedProperty.value &&
    materializedPropertyId &&
    !materializedPropertyIdsToRemove.value.includes(materializedPropertyId)
  ) {
    materializedPropertyIdsToRemove.value.push(materializedPropertyId);
  }
  removeStep(index);
  showRemoveStepDialog.value = false;
  stepToRemoveIndex.value = null;
}

// ---- Add step dialog -------------------------------------------------
type TNewStepSource = TPipelineStepKind | "tool" | "existingProperty";

const showAddStepDialog = ref(false);
const newStepSource = ref<TNewStepSource>("annotation");
const newStepImage = ref<string | null>(null);
const newStepToolId = ref<string | null>(null);
const newStepPropertyId = ref<string | null>(null);

const workerTools = computed(() =>
  store.tools.filter((tool) => tool.type === "segmentation"),
);

// Properties a step can link to: the configuration's own, not those a
// pipeline materialized (the pipeline that owns one may replace or delete it).
const linkableProperties = computed(() => {
  const materializedIds = new Set(
    pipelinesStore.pipelines.flatMap((pipeline) =>
      pipeline.steps.flatMap((step) =>
        step.kind === "property" && step.materializedPropertyId
          ? [step.materializedPropertyId]
          : [],
      ),
    ),
  );
  return configurationProperties.value.filter(
    (p) => !materializedIds.has(p.id),
  );
});

const canConfirmAddStep = computed(() => {
  switch (newStepSource.value) {
    case "tool":
      return !!newStepToolId.value;
    case "existingProperty":
      return !!newStepPropertyId.value;
    default:
      return !!newStepImage.value;
  }
});

function openAddStepDialog() {
  newStepSource.value = "annotation";
  newStepImage.value = null;
  newStepToolId.value = null;
  newStepPropertyId.value = null;
  showAddStepDialog.value = true;
}

const newStepImageFilter = computed(() => {
  return newStepSource.value === "annotation"
    ? (labels: IWorkerLabels) => labels.isAnnotationWorker !== undefined
    : (labels: IWorkerLabels) => labels.isPropertyWorker !== undefined;
});

function defaultAnnotationSetup(
  shape: AnnotationShape = AnnotationShape.Polygon,
): IAnnotationSetup {
  return {
    tags: [],
    coordinateAssignments: buildDefaultCoordinateAssignments(),
    shape,
    color: undefined,
  };
}

// An annotation step linked to an existing worker tool. Its fields start as a
// copy of the tool's (the inverse of the runner's buildTransientTool
// mapping); the editor shows it, read-only, with the tool's live values.
function stepFromTool(toolId: string): IAnnotationPipelineStep | null {
  const tool = workerTools.value.find((t) => t.id === toolId);
  const fields = tool && toolLinkedFields(tool, defaultAnnotationSetup());
  if (!tool || !fields) {
    return null;
  }
  return {
    id: pipelinesStore.createStepId(),
    kind: "annotation",
    name: tool.name,
    enabled: true,
    ...fields,
    sourceToolId: tool.id,
  };
}

// A property step linked to an existing property. Not auto-wired: it computes
// on the property's own tags and shape.
function stepFromProperty(propertyId: string): IPropertyPipelineStep | null {
  const property = linkableProperties.value.find((p) => p.id === propertyId);
  if (!property) {
    return null;
  }
  return {
    id: pipelinesStore.createStepId(),
    kind: "property",
    name: property.name,
    enabled: true,
    ...propertyLinkedFields(property),
    autoWired: false,
    sourcePropertyId: property.id,
  };
}

function confirmAddStep() {
  if (
    newStepSource.value === "tool" ||
    newStepSource.value === "existingProperty"
  ) {
    const linkedStep =
      newStepSource.value === "tool"
        ? newStepToolId.value && stepFromTool(newStepToolId.value)
        : newStepPropertyId.value && stepFromProperty(newStepPropertyId.value);
    if (linkedStep) {
      updateSteps([...localPipeline.value.steps, linkedStep]);
    }
    showAddStepDialog.value = false;
    return;
  }
  if (!newStepImage.value) {
    return;
  }
  const image = newStepImage.value;
  const labels = propertiesStore.workerImageList[image];
  const id = pipelinesStore.createStepId();
  const name = labels?.interfaceName || image;

  let step: TPipelineStep;
  if (newStepSource.value === "annotation") {
    const annotationStep: IAnnotationPipelineStep = {
      id,
      kind: "annotation",
      name,
      image,
      workerInterfaceValues: {},
      enabled: true,
      annotation: defaultAnnotationSetup(labels?.annotationShape),
    };
    step = annotationStep;
  } else {
    const propertyStep: IPropertyPipelineStep = {
      id,
      kind: "property",
      name,
      image,
      workerInterfaceValues: {},
      enabled: true,
      shape: AnnotationShape.Polygon,
      inputTags: { tags: [], exclusive: false },
      autoWired: true,
    };
    step = propertyStep;
  }

  updateSteps([...localPipeline.value.steps, step]);
  showAddStepDialog.value = false;
}

// Persist the working copy. Returns the saved pipeline from the store (so
// callers can run exactly what was saved), or null on failure.
async function persist(): Promise<IPipeline | null> {
  saving.value = true;
  saveError.value = null;
  // Captured before the first await, so an edit made while the save is in
  // flight is not marked saved. Linked steps are saved with their source's
  // current values, so the deleted-source fallback runs its last settings.
  const editing = cloneDeep(localPipeline.value);
  const toSave: IPipeline = {
    ...editing,
    steps: displayedSteps(editing.steps),
  };
  // Preserve any materializedPropertyId the runner wrote to the store copy
  // after a run, so saving edits doesn't drop it and orphan the property.
  mergeMaterializedPropertyIds(
    toSave,
    pipelinesStore.getPipelineById(toSave.id),
  );
  const saved = cloneDeep(toSave);
  try {
    await pipelinesStore.savePipeline(toSave);
    if (materializedPropertyIdsToRemove.value.length > 0) {
      await pipelinesStore.deleteUnreferencedMaterializedProperties(
        materializedPropertyIdsToRemove.value,
      );
      materializedPropertyIdsToRemove.value = [];
    }
    // Continue from what was saved (refreshed copies, wired steps) unless the
    // user changed the working copy during the save.
    if (samePersistedValue(localPipeline.value, editing)) {
      localPipeline.value = saved;
    }
    return pipelinesStore.getPipelineById(localPipeline.value.id);
  } catch (error) {
    logError("Failed to save pipeline:", error);
    saveError.value = "Failed to save pipeline. See the console for details.";
    return null;
  } finally {
    saving.value = false;
  }
}

async function save() {
  // Explicit Save gets a confirmation snackbar (Run has its own run feedback).
  if (await persist()) {
    showSavedSnackbar.value = true;
  }
}

// Run saves the current edits first, then runs exactly what was saved — so the
// run reflects on-screen edits and the runner's materialized-property
// write-back lands on the persisted pipeline.
async function saveAndRun() {
  if (!canRun.value) {
    return;
  }
  const saved = await persist();
  if (saved) {
    await controller.run(saved);
  }
}

onMounted(() => {
  if (Object.keys(propertiesStore.workerImageList).length === 0) {
    propertiesStore.fetchWorkerImageList();
  }
  loadMissingLinkedProperties();
});

defineExpose({
  localPipeline,
  statuses,
  canRun,
  canSave,
  isDirty,
  save,
  saveAndRun,
  askRemoveStep,
  confirmRemoveStep,
  materializedPropertyIdsToRemove,
  showSavedSnackbar,
  linkStates,
  handleStepUpdate,
  newStepSource,
  newStepToolId,
  newStepPropertyId,
  confirmAddStep,
  displayedPipeline,
  linkableProperties,
});
</script>

<style scoped>
.step-title {
  width: 100%;
}
</style>
