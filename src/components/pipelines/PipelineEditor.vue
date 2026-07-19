<template>
  <v-container class="pa-0">
    <v-row class="my-0" dense>
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
    <v-row class="my-0" dense>
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

    <v-row v-if="localPipeline.steps.length === 0" class="my-2" dense>
      <v-col class="text-caption text-medium-emphasis">
        No steps yet. Add a step to get started.
      </v-col>
    </v-row>

    <v-expansion-panels v-else variant="accordion" class="my-2">
      <v-expansion-panel
        v-for="(step, index) in localPipeline.steps"
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
            @update:model-value="handleStepUpdate(index, $event)"
          />
          <v-row class="my-0" dense>
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
                @click="removeStep(index)"
              >
                <v-icon start>mdi-delete</v-icon>
                Remove
              </v-btn>
            </v-col>
          </v-row>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <v-row class="my-2" dense>
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
    <v-row class="my-0" dense>
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
      dense
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

    <v-row class="my-2" dense>
      <v-col class="d-flex ga-2 py-1 justify-end">
        <v-btn
          variant="text"
          size="small"
          :loading="saving"
          :disabled="!canSave || isRunningThis"
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
    <v-dialog v-model="showAddStepDialog" max-width="480">
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
          </v-btn-toggle>
          <v-select
            v-if="newStepSource === 'tool'"
            v-model="newStepToolId"
            label="Tool"
            :items="workerTools"
            item-title="name"
            item-value="id"
            density="compact"
            hint="Copies the tool's worker, parameters and output tags into a new step"
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
            :disabled="
              newStepSource === 'tool' ? !newStepToolId : !newStepImage
            "
            @click="confirmAddStep"
          >
            Add
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <job-log-dialog
      v-model="showLogDialog"
      :job-id="logDialogJobId"
      :title="logDialogTitle"
    />
  </v-container>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from "vue";
import { cloneDeep, isEqual } from "lodash";
import store from "@/store";
import pipelinesStore from "@/store/pipelines";
import propertiesStore from "@/store/properties";
import annotationStore from "@/store/annotation";
import { logError } from "@/utils/log";
import DockerImageSelect from "@/components/DockerImageSelect.vue";
import PipelineStepEditor from "@/components/pipelines/PipelineStepEditor.vue";
import JobLogDialog from "@/components/JobLogDialog.vue";
import { buildDefaultCoordinateAssignments } from "@/store/toolSuggestions";
import {
  PipelineRunController,
  PipelineRunControllerKey,
  stepStatusColor,
  stepStatusIcon,
} from "@/components/pipelines/usePipelineRun";
import {
  AnnotationShape,
  clampToMaterializablePropertyShape,
  IAnnotationPipelineStep,
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

const controller = inject<PipelineRunController>(PipelineRunControllerKey)!;

// Edited as a local deep clone so editing doesn't mutate the persisted list
// until Save/Run. Re-clone only when pointed at a *different* pipeline (id
// change). Auto-wiring runs on the initial clone so pipelines arriving with
// unwired property steps (older saved pipelines) are wired on open.
function clonePipelineForEditing(pipeline: IPipeline): IPipeline {
  const clone = cloneDeep(pipeline);
  clone.steps = computeAutoWiredSteps(clone.steps);
  return clone;
}

const localPipeline = ref<IPipeline>(clonePipelineForEditing(props.pipeline));

watch(
  () => props.pipeline.id,
  () => {
    localPipeline.value = clonePipelineForEditing(props.pipeline);
  },
);

const saving = ref(false);
const saveError = ref<string | null>(null);

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
  localPipeline.value.steps.forEach((step, index) => {
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
// Pure function: for every property step that hasn't been manually detached
// (autoWired !== false), pull tags/shape from the nearest preceding enabled
// annotation step. Idempotent, so re-running after every edit is safe.
function computeAutoWiredSteps(steps: TPipelineStep[]): TPipelineStep[] {
  let lastAnnotation: IAnnotationPipelineStep | null = null;
  return steps.map((step) => {
    if (step.kind === "annotation") {
      if (step.enabled) {
        lastAnnotation = step;
      }
      return step;
    }
    if (step.autoWired === false || !lastAnnotation) {
      return step;
    }
    const wiredTags = lastAnnotation.annotation.tags;
    const wiredShape = clampToMaterializablePropertyShape(
      lastAnnotation.annotation.shape,
    );
    if (
      step.shape === wiredShape &&
      step.autoWired === true &&
      isEqual(step.inputTags.tags, wiredTags)
    ) {
      return step;
    }
    return {
      ...step,
      shape: wiredShape,
      inputTags: { ...step.inputTags, tags: [...wiredTags] },
      autoWired: true,
    };
  });
}

const stepCaptions = computed<(string | null)[]>(() => {
  let lastAnnotation: { index: number; step: IAnnotationPipelineStep } | null =
    null;
  return localPipeline.value.steps.map((step, index) => {
    if (step.kind === "annotation") {
      if (step.enabled) {
        lastAnnotation = { index, step };
      }
      return null;
    }
    if (step.autoWired === false) {
      return null;
    }
    if (!lastAnnotation) {
      return "No preceding annotation step — add one above to auto-wire tags";
    }
    return `Reads tags from step ${lastAnnotation.index + 1} (${lastAnnotation.step.name})`;
  });
});

function updateSteps(steps: TPipelineStep[]) {
  localPipeline.value.steps = computeAutoWiredSteps(steps);
}

function handleStepUpdate(index: number, newStep: TPipelineStep) {
  const steps = localPipeline.value.steps.slice();
  steps[index] = newStep;
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

// ---- Add step dialog -------------------------------------------------
type TNewStepSource = TPipelineStepKind | "tool";

const showAddStepDialog = ref(false);
const newStepSource = ref<TNewStepSource>("annotation");
const newStepImage = ref<string | null>(null);
const newStepToolId = ref<string | null>(null);

const workerTools = computed(() =>
  store.tools.filter((tool) => tool.type === "segmentation"),
);

function openAddStepDialog() {
  newStepSource.value = "annotation";
  newStepImage.value = null;
  newStepToolId.value = null;
  showAddStepDialog.value = true;
}

const newStepImageFilter = computed(() => {
  return newStepSource.value === "annotation"
    ? (labels: IWorkerLabels) => labels.isAnnotationWorker !== undefined
    : (labels: IWorkerLabels) => labels.isPropertyWorker !== undefined;
});

// Import an existing worker tool as an annotation step: the inverse of the
// runner's buildTransientTool mapping.
function stepFromTool(toolId: string): IAnnotationPipelineStep | null {
  const tool = workerTools.value.find((t) => t.id === toolId);
  const image = tool?.values?.image?.image;
  if (!tool || !image) {
    return null;
  }
  return {
    id: pipelinesStore.createStepId(),
    kind: "annotation",
    name: tool.name,
    image,
    workerInterfaceValues: cloneDeep(tool.values.workerInterfaceValues ?? {}),
    enabled: true,
    annotation: tool.values.annotation
      ? cloneDeep(tool.values.annotation)
      : {
          tags: [],
          coordinateAssignments: buildDefaultCoordinateAssignments(),
          shape: AnnotationShape.Polygon,
          color: undefined,
        },
    connectTo: tool.values.connectTo
      ? cloneDeep(tool.values.connectTo)
      : undefined,
    jobDateTag: tool.values.jobDateTag ?? undefined,
  };
}

function confirmAddStep() {
  if (newStepSource.value === "tool") {
    if (!newStepToolId.value) {
      return;
    }
    const toolStep = stepFromTool(newStepToolId.value);
    if (toolStep) {
      updateSteps([...localPipeline.value.steps, toolStep]);
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
      annotation: {
        tags: [],
        coordinateAssignments: buildDefaultCoordinateAssignments(),
        shape: labels?.annotationShape ?? AnnotationShape.Polygon,
        color: undefined,
      },
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
  try {
    await pipelinesStore.savePipeline(cloneDeep(localPipeline.value));
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
  await persist();
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
});

defineExpose({
  localPipeline,
  statuses,
  canRun,
  canSave,
  save,
  saveAndRun,
});
</script>

<style scoped>
.step-title {
  width: 100%;
}
</style>
