<template>
  <v-container class="pa-0">
    <v-row class="my-0" dense>
      <v-col cols="8" class="py-1">
        <v-text-field
          v-model="name"
          label="Step name"
          density="compact"
          hide-details
        />
      </v-col>
      <v-col cols="4" class="py-1 d-flex align-center">
        <v-checkbox
          v-model="enabled"
          label="Enabled"
          density="compact"
          hide-details
        />
      </v-col>
    </v-row>

    <v-row class="my-0" dense>
      <v-col class="py-1">
        <docker-image-select v-model="image" :imageFilter="imageFilter" />
      </v-col>
    </v-row>

    <v-row v-if="fetchingInterface" class="my-0">
      <v-col class="py-2 d-flex align-center">
        <v-progress-circular indeterminate size="20" class="mr-2" />
        <span class="text-caption">Loading worker interface…</span>
      </v-col>
    </v-row>

    <template v-if="isAnnotation">
      <v-row class="my-0">
        <v-col class="py-1">
          <annotation-configuration
            :model-value="annotationSetup"
            @update:model-value="onAnnotationSetupChange"
          />
        </v-col>
      </v-row>
    </template>
    <template v-else>
      <v-row class="my-0" dense>
        <v-col cols="6" class="py-1">
          <v-select
            label="Shape"
            :items="shapeItems"
            item-title="text"
            item-value="value"
            v-model="propertyShape"
            density="compact"
          />
        </v-col>
        <v-col cols="6" class="py-1 d-flex align-center">
          <v-checkbox
            v-model="inputExclusive"
            label="Exclusive tag match"
            density="compact"
            hide-details
          />
        </v-col>
      </v-row>
      <v-row class="my-0">
        <v-col class="py-1">
          <div
            v-if="autoWiredCaption"
            class="text-caption text-medium-emphasis mb-1"
          >
            {{ autoWiredCaption }}
          </div>
          <tag-picker v-model="inputTags" />
        </v-col>
      </v-row>
    </template>

    <v-row v-if="workerInterface" class="my-0">
      <v-col class="py-1">
        <worker-interface-values
          :workerInterface="workerInterface"
          v-model="workerInterfaceValuesModel"
        />
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import propertiesStore from "@/store/properties";
import DockerImageSelect from "@/components/DockerImageSelect.vue";
import WorkerInterfaceValues from "@/components/WorkerInterfaceValues.vue";
import TagPicker from "@/components/TagPicker.vue";
import AnnotationConfiguration from "@/tools/creation/templates/AnnotationConfiguration.vue";
import { getDefault } from "@/utils/workerInterface";
import { logError } from "@/utils/log";
import {
  AnnotationNames,
  AnnotationShape,
  MATERIALIZABLE_PROPERTY_SHAPES,
  IAnnotationPipelineStep,
  IAnnotationSetup,
  IPipelineStepBase,
  IPropertyPipelineStep,
  IWorkerInterface,
  IWorkerInterfaceValues,
  IWorkerLabels,
  TPipelineStep,
} from "@/store/model";

const props = defineProps<{
  modelValue: TPipelineStep;
  // Shown above the input-tags picker for property steps, e.g.
  // "Reads tags from step 1 (Cellpose SAM)". Computed by the parent builder,
  // which has visibility into step ordering.
  autoWiredCaption?: string | null;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: TPipelineStep): void;
}>();

const fetchingInterface = ref(false);

// This component is a fully "controlled" widget: it never keeps its own copy
// of the step, it only derives from/patches `props.modelValue`. That avoids
// any need to reconcile a local clone against external updates (e.g. tag
// auto-wiring pushed down by PipelineBuilder).
const step = computed(() => props.modelValue);

// Kind-narrowed views of the step (TPipelineStep is a discriminated union on
// `kind`), so the per-kind computeds below need no `as` casts. The template
// only renders each kind's widgets when the step is that kind, so the null
// fallbacks in the getters are never user-visible.
const annotationStepValue = computed<IAnnotationPipelineStep | null>(() =>
  step.value.kind === "annotation" ? step.value : null,
);
const propertyStepValue = computed<IPropertyPipelineStep | null>(() =>
  step.value.kind === "property" ? step.value : null,
);

// Common (non-discriminant) fields shared by every step kind. Omitting `kind`
// keeps the patch from re-widening the discriminant when spread.
type TStepPatch = Partial<Omit<IPipelineStepBase, "kind">>;

function patchStep(patch: TStepPatch) {
  // Branch so each spread is over a concrete member of the discriminated
  // union (a spread over the union widens `kind` and breaks assignability).
  if (step.value.kind === "annotation") {
    emit("update:modelValue", { ...step.value, ...patch });
  } else {
    emit("update:modelValue", { ...step.value, ...patch });
  }
}

function patchAnnotationStep(patch: Partial<IAnnotationPipelineStep>) {
  if (step.value.kind !== "annotation") {
    return;
  }
  emit("update:modelValue", { ...step.value, ...patch });
}

function patchPropertyStep(patch: Partial<IPropertyPipelineStep>) {
  if (step.value.kind !== "property") {
    return;
  }
  emit("update:modelValue", { ...step.value, ...patch });
}

const isAnnotation = computed(() => step.value.kind === "annotation");

const name = computed({
  get: () => step.value.name,
  set: (value: string) => patchStep({ name: value }),
});

const enabled = computed({
  get: () => step.value.enabled,
  set: (value: boolean) => patchStep({ enabled: value }),
});

const imageFilter = computed(() => {
  return isAnnotation.value
    ? (labels: IWorkerLabels) => labels.isAnnotationWorker !== undefined
    : (labels: IWorkerLabels) => labels.isPropertyWorker !== undefined;
});

const workerInterface = computed<IWorkerInterface | null>(() => {
  return propertiesStore.getWorkerInterface(step.value.image) ?? null;
});

const workerInterfaceValuesModel = computed({
  get: () => step.value.workerInterfaceValues,
  set: (value: IWorkerInterfaceValues) =>
    patchStep({ workerInterfaceValues: value }),
});

const annotationSetup = computed<IAnnotationSetup | undefined>(
  () => annotationStepValue.value?.annotation,
);

function onAnnotationSetupChange(value: IAnnotationSetup) {
  patchAnnotationStep({ annotation: value });
}

const propertyShape = computed({
  get: () => propertyStepValue.value?.shape ?? AnnotationShape.Polygon,
  // Like a manual tag edit, a manual shape edit detaches auto-wiring —
  // otherwise PipelineBuilder's computeAutoWiredSteps would immediately
  // overwrite the shape from the upstream annotation step again.
  set: (value: AnnotationShape) =>
    patchPropertyStep({ shape: value, autoWired: false }),
});

const inputTags = computed({
  get: () => propertyStepValue.value?.inputTags.tags ?? [],
  set: (value: string[]) => {
    const current = propertyStepValue.value;
    if (!current) {
      return;
    }
    // A manual tag edit takes the step out of auto-wiring so PipelineBuilder
    // won't silently overwrite it on the next reorder/edit.
    patchPropertyStep({
      inputTags: { ...current.inputTags, tags: value },
      autoWired: false,
    });
  },
});

const inputExclusive = computed({
  get: () => propertyStepValue.value?.inputTags.exclusive ?? false,
  set: (value: boolean) => {
    const current = propertyStepValue.value;
    if (!current) {
      return;
    }
    patchPropertyStep({
      inputTags: { ...current.inputTags, exclusive: value },
    });
  },
});

// Property steps materialize into a property document, whose shape must be one
// the backend accepts (point/line/polygon) — offer only those.
const shapeItems = MATERIALIZABLE_PROPERTY_SHAPES.map((value) => ({
  text: AnnotationNames[value],
  value,
}));

async function ensureWorkerInterface(image: string) {
  // Only skip when a real (non-null) interface is already cached. A cached
  // `null` means a previous fetch failed or came back empty - retry it
  // rather than treating it as a permanent "no interface" answer.
  if (propertiesStore.getWorkerInterface(image) != null) {
    return;
  }
  fetchingInterface.value = true;
  try {
    await propertiesStore.fetchWorkerInterface({ image });
  } catch (error) {
    logError(`Failed to fetch worker interface for ${image}:`, error);
  } finally {
    fetchingInterface.value = false;
  }
}

function seedWorkerInterfaceValues(
  image: string,
  saved: IWorkerInterfaceValues,
): IWorkerInterfaceValues {
  const iface = propertiesStore.getWorkerInterface(image);
  if (!iface) {
    return {};
  }
  const values: IWorkerInterfaceValues = {};
  for (const id in iface) {
    values[id] =
      id in saved ? saved[id] : getDefault(iface[id].type, iface[id].default);
  }
  return values;
}

const image = computed({
  get: () => step.value.image,
  set: (value: string | null) => onImageChange(value),
});

// Guards onImageChange against out-of-order completion: two rapid image
// switches can resolve in reverse order (the first interface fetch may be
// slow while the second is cached), and only the latest selection may patch.
let imageChangeToken = 0;

async function onImageChange(newImage: string | null) {
  const token = ++imageChangeToken;
  const previous = step.value;
  const img = newImage ?? "";
  if (!img) {
    patchStep({ image: img, workerInterfaceValues: {} });
    return;
  }
  await ensureWorkerInterface(img);
  if (token !== imageChangeToken) {
    return;
  }
  const workerInterfaceValues = seedWorkerInterfaceValues(
    img,
    previous.workerInterfaceValues,
  );
  const labels = propertiesStore.workerImageList[img];
  const patch: TStepPatch = {
    image: img,
    workerInterfaceValues,
  };
  if (labels?.interfaceName && !previous.name) {
    patch.name = labels.interfaceName;
  }
  patchStep(patch);
}

onMounted(async () => {
  if (Object.keys(propertiesStore.workerImageList).length === 0) {
    await propertiesStore.fetchWorkerImageList();
  }
  const current = step.value;
  if (!current.image) {
    return;
  }
  await ensureWorkerInterface(current.image);
  if (Object.keys(current.workerInterfaceValues).length === 0) {
    const workerInterfaceValues = seedWorkerInterfaceValues(
      current.image,
      current.workerInterfaceValues,
    );
    if (Object.keys(workerInterfaceValues).length > 0) {
      patchStep({ workerInterfaceValues });
    }
  }
});

defineExpose({
  step,
  isAnnotation,
  workerInterface,
  image,
  name,
  enabled,
});
</script>
