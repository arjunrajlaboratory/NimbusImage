<template>
  <v-container class="pa-0">
    <v-row class="my-0" density="comfortable">
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

    <v-alert
      v-if="linkMessage"
      :type="linkState?.state === 'missing' ? 'warning' : 'info'"
      variant="tonal"
      density="compact"
      class="my-1 link-alert"
    >
      <div class="d-flex align-center ga-2">
        <span class="flex-grow-1 text-body-2">{{ linkMessage }}</span>
        <v-btn variant="text" size="small" @click="unlink">
          <v-icon start>mdi-link-variant-off</v-icon>
          Unlink
        </v-btn>
      </div>
    </v-alert>

    <!-- A linked step's worker is its source's; changing it means unlinking. -->
    <v-defaults-provider :defaults="lockedDefaults(isLinked)">
      <div :inert="isLinked || undefined">
        <v-row class="my-0" density="comfortable">
          <v-col class="py-1">
            <docker-image-select v-model="image" :imageFilter="imageFilter" />
          </v-col>
        </v-row>
      </div>
    </v-defaults-provider>

    <v-row v-if="fetchingInterface" class="my-0">
      <v-col class="py-2 d-flex align-center">
        <v-progress-circular indeterminate size="20" class="mr-2" />
        <span class="text-caption">Loading worker interface…</span>
      </v-col>
    </v-row>

    <!-- A linked step's settings are its source's: read-only here. -->
    <v-defaults-provider :defaults="lockedDefaults(isLinked)">
      <div :inert="isLinked || undefined">
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
          <v-row class="my-0" density="comfortable">
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
      </div>
    </v-defaults-provider>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { cloneDeep, omit } from "lodash";
import propertiesStore from "@/store/properties";
import DockerImageSelect from "@/components/DockerImageSelect.vue";
import WorkerInterfaceValues from "@/components/WorkerInterfaceValues.vue";
import TagPicker from "@/components/TagPicker.vue";
import AnnotationConfiguration from "@/tools/creation/templates/AnnotationConfiguration.vue";
import { getDefault } from "@/utils/workerInterface";
import { logError } from "@/utils/log";
import { TStepLinkState } from "@/utils/pipelineLinks";
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
  // Whether the step is linked to an existing tool/property (computed by the
  // parent, which knows the configuration's tools and properties).
  linkState?: TStepLinkState;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: TPipelineStep): void;
}>();

const fetchingInterface = ref(false);

// This component is a fully "controlled" widget: it never keeps its own copy
// of the step, it only derives from/patches `props.modelValue`. That avoids
// any need to reconcile a local clone against external updates (e.g. tag
// auto-wiring pushed down by PipelineEditor).
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

// A linked step's settings are its source's: only its own name and enabled
// flag may change, so its locked sections (whose child editors still re-emit,
// e.g. AnnotationConfiguration on mount) emit nothing.
function isLockedPatch(patch: object): boolean {
  return (
    isLinked.value &&
    Object.keys(patch).some((key) => key !== "name" && key !== "enabled")
  );
}

function patchStep(patch: TStepPatch) {
  if (isLockedPatch(patch)) {
    return;
  }
  // Branch so each spread is over a concrete member of the discriminated
  // union (a spread over the union widens `kind` and breaks assignability).
  if (step.value.kind === "annotation") {
    emit("update:modelValue", { ...step.value, ...patch });
  } else {
    emit("update:modelValue", { ...step.value, ...patch });
  }
}

function patchAnnotationStep(patch: Partial<IAnnotationPipelineStep>) {
  if (step.value.kind !== "annotation" || isLockedPatch(patch)) {
    return;
  }
  emit("update:modelValue", { ...step.value, ...patch });
}

function patchPropertyStep(patch: Partial<IPropertyPipelineStep>) {
  if (step.value.kind !== "property" || isLockedPatch(patch)) {
    return;
  }
  emit("update:modelValue", { ...step.value, ...patch });
}

const isAnnotation = computed(() => step.value.kind === "annotation");

const isLinked = computed(
  () => !!props.linkState && props.linkState.state !== "unlinked",
);

const linkMessage = computed<string | null>(() => {
  const linkState = props.linkState;
  if (!linkState || linkState.state === "unlinked") {
    return null;
  }
  if (linkState.state === "missing") {
    if (linkState.reason === "noWorker") {
      return `The tool "${linkState.sourceName}" this step is linked to no longer has a worker image. It runs with the last saved copy of the tool's settings. Unlink to edit them.`;
    }
    return linkState.sourceKind === "tool"
      ? "The tool this step was linked to was deleted. It runs with the last saved copy of the tool's settings. Unlink to edit them."
      : "The property this step is linked to is not available (deleted, or not loaded yet). A run checks again: if it was deleted, the step computes a new property from the last saved copy of its settings.";
  }
  return linkState.sourceKind === "tool"
    ? `Linked to tool "${linkState.sourceName}": runs with the tool's current settings. Edit them in the Tools panel, or Unlink to customize this step.`
    : `Linked to property "${linkState.sourceName}": computes that property as it is defined. Unlink to customize this step (the pipeline then computes its own copy of the property).`;
});

// Locked sections render every Vuetify control disabled (a global default, so
// it reaches the inputs inside child components and their own v-forms); the
// wrapper's `inert` also blocks focus and clicks on anything else. Parameter
// help tooltips are therefore unavailable on a locked step.
function lockedDefaults(locked: boolean) {
  return locked ? { global: { disabled: true } } : {};
}

// Turn a linked step into an independent copy of its current settings. An
// unlinked property step keeps its tags rather than auto-wiring over them, and
// is renamed: the pipeline now computes its own copy of the property, named
// after the step, which would otherwise share the original's name.
function unlink() {
  const current = step.value;
  // Keep the values the step was showing (including displayed defaults).
  const workerInterfaceValues = cloneDeep(displayedWorkerInterfaceValues.value);
  if (current.kind === "annotation") {
    emit("update:modelValue", {
      ...omit(current, "sourceToolId"),
      workerInterfaceValues,
    });
  } else {
    emit("update:modelValue", {
      ...omit(current, "sourcePropertyId"),
      name: `${current.name} (pipeline copy)`,
      workerInterfaceValues,
      autoWired: false,
    });
  }
}

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

// The parameter values shown. A linked step's unset parameters show the
// worker's defaults, as the tool's own menu does, without writing them (its
// settings are read-only here). (An unlinked step is seeded on mount instead;
// see onMounted.) Saved values the interface no longer declares are kept, so
// Unlink does not drop them.
const displayedWorkerInterfaceValues = computed<IWorkerInterfaceValues>(() =>
  isLinked.value && workerInterface.value
    ? {
        ...seedWorkerInterfaceValues(
          step.value.image,
          step.value.workerInterfaceValues,
        ),
        ...step.value.workerInterfaceValues,
      }
    : step.value.workerInterfaceValues,
);

const workerInterfaceValuesModel = computed({
  get: () => displayedWorkerInterfaceValues.value,
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
  // otherwise auto-wiring (computeAutoWiredSteps, in the editor and the
  // runner) would overwrite the shape from the upstream annotation step again.
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
    // A manual tag edit takes the step out of auto-wiring so PipelineEditor
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

// The image can change from outside the editor too: a linked step follows its
// tool's image live. Load the new image's interface then, or its parameters
// would not show (onImageChange covers only a pick made here; the mount
// covers the first image).
watch(
  () => step.value.image,
  (newImage, oldImage) => {
    if (newImage && newImage !== oldImage) {
      void ensureWorkerInterface(newImage);
    }
  },
);

onMounted(async () => {
  if (Object.keys(propertiesStore.workerImageList).length === 0) {
    await propertiesStore.fetchWorkerImageList();
  }
  const current = step.value;
  if (!current.image) {
    return;
  }
  await ensureWorkerInterface(current.image);
  // A different image picked while this fetch ran has been seeded by
  // onImageChange; this image's defaults would overwrite it.
  if (step.value.image !== current.image) {
    return;
  }
  // Linked steps show defaults without writing them
  // (displayedWorkerInterfaceValues).
  if (
    !isLinked.value &&
    Object.keys(current.workerInterfaceValues).length === 0
  ) {
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
  isLinked,
  unlink,
  isAnnotation,
  workerInterface,
  image,
  name,
  enabled,
});
</script>

<style scoped>
.link-alert :deep(.v-alert__content) {
  width: 100%;
}
</style>
