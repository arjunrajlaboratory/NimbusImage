<template>
  <v-container class="pa-0">
    <v-row class="my-0" dense>
      <v-col cols="12" class="py-1">
        <v-text-field
          v-model="localPipeline.name"
          label="Pipeline name"
          density="compact"
          hide-details
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
        />
      </v-col>
    </v-row>

    <v-alert v-if="saveError" type="error" density="compact" class="my-2">
      {{ saveError }}
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
            <v-icon size="small" class="mr-2">
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
            <v-chip v-if="!step.enabled" size="x-small" class="mr-2"
              >disabled</v-chip
            >
          </div>
        </v-expansion-panel-title>
        <v-expansion-panel-text>
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
                :disabled="index === 0"
                @click="moveStep(index, -1)"
              >
                <v-icon start>mdi-arrow-up</v-icon>
                Move up
              </v-btn>
              <v-btn
                variant="text"
                size="small"
                :disabled="index === localPipeline.steps.length - 1"
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
          @click="openAddStepDialog"
        >
          <v-icon start>mdi-plus</v-icon>
          Add step
        </v-btn>
      </v-col>
    </v-row>

    <v-row class="my-2" dense>
      <v-col class="d-flex ga-2 py-1 justify-end">
        <v-btn variant="text" size="small" @click="emit('close')">
          Close
        </v-btn>
        <v-btn
          variant="flat"
          color="primary"
          size="small"
          :loading="saving"
          :disabled="!localPipeline.name || localPipeline.steps.length === 0"
          @click="save"
        >
          Save
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
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { cloneDeep, isEqual } from "lodash";
import store from "@/store";
import pipelinesStore from "@/store/pipelines";
import propertiesStore from "@/store/properties";
import { logError } from "@/utils/log";
import DockerImageSelect from "@/components/DockerImageSelect.vue";
import PipelineStepEditor from "@/components/pipelines/PipelineStepEditor.vue";
import { buildDefaultCoordinateAssignments } from "@/store/toolSuggestions";
import {
  AnnotationShape,
  clampToMaterializablePropertyShape,
  IAnnotationPipelineStep,
  IPipeline,
  IPropertyPipelineStep,
  IWorkerLabels,
  TPipelineStep,
  TPipelineStepKind,
} from "@/store/model";

const props = defineProps<{
  modelValue: IPipeline;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: IPipeline): void;
  (e: "saved", pipelineId: string): void;
  (e: "close"): void;
}>();

// Edited as a local deep clone so browsing/editing a pipeline doesn't mutate
// the persisted list until "Save" is pressed. Only resynced when the caller
// points the builder at a *different* pipeline (id change), never on every
// upstream prop tick, so our own emitted edits don't bounce back and forth.
// Auto-wiring runs on the initial clone too, so pipelines arriving with
// unwired property steps (AI suggestions, older saved pipelines) are wired
// as soon as they open in the builder.
function clonePipelineForEditing(pipeline: IPipeline): IPipeline {
  const clone = cloneDeep(pipeline);
  clone.steps = computeAutoWiredSteps(clone.steps);
  return clone;
}

const localPipeline = ref<IPipeline>(clonePipelineForEditing(props.modelValue));

watch(
  () => props.modelValue.id,
  () => {
    localPipeline.value = clonePipelineForEditing(props.modelValue);
  },
);

watch(
  localPipeline,
  (value) => {
    emit("update:modelValue", cloneDeep(value));
  },
  { deep: true },
);

const saving = ref(false);
const saveError = ref<string | null>(null);

// ---- Tag auto-wiring (spec: WORKER_PIPELINES.md §5) -----------------------
// Pure function: for every property step that hasn't been manually detached
// (autoWired !== false), pull tags/shape from the nearest preceding
// annotation step. Idempotent, so re-running it after every edit is safe.
function computeAutoWiredSteps(steps: TPipelineStep[]): TPipelineStep[] {
  let lastAnnotation: IAnnotationPipelineStep | null = null;
  return steps.map((step) => {
    if (step.kind === "annotation") {
      // Disabled steps are skipped by the runner, so they produce no
      // annotations for a downstream property step to read — don't wire
      // from them.
      if (step.enabled) {
        lastAnnotation = step;
      }
      return step;
    }
    if (step.autoWired === false || !lastAnnotation) {
      return step;
    }
    const wiredTags = lastAnnotation.annotation.tags;
    // The annotation step may produce a non-materializable shape
    // (rectangle/circle/ellipse); clamp so the property step stays computable.
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
      // Mirror computeAutoWiredSteps: disabled steps are not wiring sources.
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

// A step starts from a worker image ("annotation" / "property") or from an
// existing worker tool in the configuration ("tool"), which copies the
// tool's image, parameters and annotation setup into a new annotation step.
type TNewStepSource = TPipelineStepKind | "tool";

const showAddStepDialog = ref(false);
const newStepSource = ref<TNewStepSource>("annotation");
const newStepImage = ref<string | null>(null);
const newStepToolId = ref<string | null>(null);

// Worker-backed annotation tools of the current configuration (the same
// tool shape the runner's buildTransientTool produces).
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

async function save() {
  saving.value = true;
  saveError.value = null;
  try {
    await pipelinesStore.savePipeline(cloneDeep(localPipeline.value));
    emit("saved", localPipeline.value.id);
  } catch (error) {
    logError("Failed to save pipeline:", error);
    saveError.value = "Failed to save pipeline. See the console for details.";
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  if (Object.keys(propertiesStore.workerImageList).length === 0) {
    propertiesStore.fetchWorkerImageList();
  }
});

defineExpose({
  localPipeline,
  stepCaptions,
  handleStepUpdate,
  moveStep,
  removeStep,
  confirmAddStep,
  save,
});
</script>

<style scoped>
.step-title {
  width: 100%;
}
</style>
