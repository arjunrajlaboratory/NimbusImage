<template>
  <v-card class="property-creation-card">
    <div
      class="d-flex align-center px-4 py-2"
      id="create-property-header-tourstep"
    >
      <span class="text-subtitle-1">Create new property</span>
    </div>
    <v-card-text>
      <v-container class="pa-2">
        <v-row align="center" class="mb-1" dense>
          <v-col cols="3">
            <v-subheader dense>Measure by tag:</v-subheader>
          </v-col>
          <v-col cols="6">
            <tag-picker
              v-model="filteringTags"
              dense
              id="property-tag-picker-tourstep"
              v-tour-trigger="'property-tag-picker-tourtrigger'"
            />
          </v-col>
          <v-col cols="3">
            <v-checkbox
              v-model="areTagsExclusive"
              label="Exclusive"
              hide-details
              dense
            ></v-checkbox>
          </v-col>
        </v-row>
        <v-row align="center" dense>
          <v-col cols="3">
            <v-subheader dense id="shape-selection-tourstep">{{
              shapeSelectionString
            }}</v-subheader>
          </v-col>
          <v-col cols="9">
            <v-select
              v-model="filteringShape"
              :items="availableShapes"
              label="Shape"
              hide-details
              dense
              :disabled="filteringTags.length > 0"
            ></v-select>
          </v-col>
        </v-row>
      </v-container>
      <v-container class="elevation-3 mt-2 pa-2" v-if="filteringShape !== null">
        <div class="subtitle-1" mb-3>Measure this property:</div>
        <v-row dense>
          <v-col>
            <docker-image-select
              dense
              v-model="dockerImage"
              :imageFilter="propertyImageFilter"
              id="property-algorithm-select-tourstep"
              v-tour-trigger="'property-algorithm-select-tourtrigger'"
            />
          </v-col>
        </v-row>
        <template v-if="dockerImage !== null">
          <v-row dense>
            <v-col>
              <property-worker-menu
                v-model="interfaceValues"
                :image="dockerImage"
                dense
              />
            </v-col>
          </v-row>
          <v-row dense>
            <v-col>
              <v-textarea
                v-model="originalName"
                label="Property name"
                rows="1"
                dense
                hide-details
                :append-icon="isNameGenerated ? '' : 'mdi-refresh'"
                @click:append="isNameGenerated = true"
                @input="isNameGenerated = false"
              />
            </v-col>
          </v-row>
        </template>
      </v-container>
      <v-checkbox
        v-model="computeUponCreation"
        label="Compute upon creation"
        class="mt-2"
        dense
        hide-details
      />
      <div class="button-bar mt-2">
        <v-spacer></v-spacer>
        <v-btn
          class="mr-2"
          color="primary"
          small
          @click="createProperty"
          id="create-property-button-tourstep"
          v-tour-trigger="'create-property-button-tourtrigger'"
        >
          Create Property
        </v-btn>
        <v-btn class="mr-2" color="warning" small @click="reset">Reset</v-btn>
      </div>
    </v-card-text>
  </v-card>
</template>
<script setup lang="ts">
import { ref, computed, watch } from "vue";
import store from "@/store";
import propertiesStore from "@/store/properties";
import annotationStore from "@/store/annotation";
import {
  AnnotationShape,
  IWorkerLabels,
  IWorkerInterfaceValues,
} from "@/store/model";
import DockerImageSelect from "@/components/DockerImageSelect.vue";
import TagPicker from "@/components/TagPicker.vue";
import PropertyWorkerMenu from "@/components/PropertyWorkerMenu.vue";
import { tagFilterFunction } from "@/utils/annotation";

// Function to remove repeated words
function removeRepeatedWords(input: string): string {
  // Split the input string into words
  const words = input.split(" ");
  // Create a Set to track seen words
  const seenWords = new Set<string>();
  // Array to store the result
  const result: string[] = [];

  // Iterate over the words
  for (const word of words) {
    // Convert the word to lowercase for case-insensitive comparison
    const lowerCaseWord = word.toLowerCase();
    // If the word hasn't been seen before, add it to the result and mark it as seen
    if (!seenWords.has(lowerCaseWord)) {
      seenWords.add(lowerCaseWord);
      result.push(word);
    }
  }

  // Join the result array back into a string and return it
  return result.join(" ");
}

const props = withDefaults(
  defineProps<{
    applyToAllDatasets?: boolean;
  }>(),
  {
    applyToAllDatasets: false,
  },
);

const emit = defineEmits<{
  (e: "compute-property-batch", property: any): void;
}>();

const availableShapes = store.availableToolShapes;

const areTagsExclusive = ref<boolean>(false);
const filteringTags = ref<string[]>([]);
const filteringShape = ref<AnnotationShape | null>(null);

const originalName = ref("New Property");
const isNameGenerated = ref(true);

const interfaceValues = ref<IWorkerInterfaceValues>({});

const computeUponCreation = ref(true);

const dockerImage = ref<string | null>(null);

const deduplicatedName = computed(() => {
  // Find a name which is not already taken
  let count = 0;
  let candidateName = originalName.value;
  while (
    propertiesStore.properties.some(
      (property) => property.name === candidateName,
    )
  ) {
    candidateName = `${originalName.value} (${++count})`;
  }
  return candidateName;
});

const generatedName = computed(() => {
  let nameList = [];
  if (filteringTags.value.length) {
    nameList.push(filteringTags.value.join(", "));
  } else {
    if (areTagsExclusive.value) {
      nameList.push("No tag");
    } else {
      nameList.push("All");
    }
  }
  if (dockerImage.value) {
    const imageInterfaceName =
      propertiesStore.workerImageList[dockerImage.value]?.interfaceName;
    if (imageInterfaceName) {
      nameList.push(imageInterfaceName);
    } else {
      nameList.push(dockerImage.value);
    }
  } else {
    nameList.push("No image");
  }
  return removeRepeatedWords(nameList.join(" "));
});

function generatedNameChanged() {
  if (isNameGenerated.value) {
    originalName.value = generatedName.value;
  }
}

watch(isNameGenerated, generatedNameChanged);
watch(generatedName, generatedNameChanged);

const propertyImageFilter = computed(() => {
  return (labels: IWorkerLabels) => {
    return (
      labels.isPropertyWorker !== undefined &&
      ((labels.annotationShape || null) === filteringShape.value ||
        (labels.annotationShape || null) === AnnotationShape.Any)
    );
  };
});

function filteringShapeChanged() {
  dockerImage.value = null;
}

watch(filteringShape, filteringShapeChanged);

function filteringTagsChanged() {
  // If no tags are selected, then reset the shape to null
  if (filteringTags.value.length === 0) {
    filteringShape.value = null;
    return;
  }
  // The keys of counts are in AnnotationShape
  // Find the best matching shape for these tags
  const counts: { [key: string]: number } = {};
  for (const annotation of annotationStore.annotations) {
    if (
      tagFilterFunction(
        annotation.tags,
        filteringTags.value,
        areTagsExclusive.value,
      )
    ) {
      if (counts[annotation.shape] === undefined) {
        counts[annotation.shape] = 0;
      }
      ++counts[annotation.shape];
    }
  }
  let bestCount = 0;
  for (const shape in counts) {
    if (counts[shape] !== undefined && counts[shape] > bestCount) {
      bestCount = counts[shape];
      filteringShape.value = shape as AnnotationShape;
    }
  }
}

watch(filteringTags, filteringTagsChanged);

function dockerImageChanged() {
  isNameGenerated.value = true;
  if (dockerImage.value) {
    propertiesStore.fetchWorkerInterface({ image: dockerImage.value });
  }
}

watch(dockerImage, dockerImageChanged);

function createProperty() {
  if (!dockerImage.value || !filteringShape.value) {
    return;
  }
  propertiesStore
    .createProperty({
      name: deduplicatedName.value,
      image: dockerImage.value,
      tags: {
        tags: filteringTags.value,
        exclusive: areTagsExclusive.value,
      },
      shape: filteringShape.value,
      workerInterface: interfaceValues.value,
    })
    .then((property) => {
      propertiesStore.togglePropertyPathVisibility([property.id]);
      if (computeUponCreation.value) {
        if (props.applyToAllDatasets) {
          emit("compute-property-batch", property);
        } else {
          propertiesStore.computeProperty({
            property,
            errorInfo: { errors: [] },
          });
        }
      }
    });
  reset();
}

function reset() {
  filteringTags.value = [];
  areTagsExclusive.value = false;
  filteringShape.value = null;
  dockerImage.value = null;
  originalName.value = "New Property";
  isNameGenerated.value = true;
}

const shapeSelectionString = computed((): string => {
  return filteringTags.value.length > 0 ? "Of shape:" : "Or by shape:";
});

defineExpose({
  areTagsExclusive,
  filteringTags,
  filteringShape,
  originalName,
  isNameGenerated,
  interfaceValues,
  computeUponCreation,
  dockerImage,
  deduplicatedName,
  generatedName,
  propertyImageFilter,
  shapeSelectionString,
  createProperty,
  reset,
  availableShapes,
  generatedNameChanged,
  filteringShapeChanged,
  filteringTagsChanged,
  dockerImageChanged,
});
</script>
<style lang="scss" scoped>
.property-creation-card {
  position: relative; // Ensure proper stacking context
  z-index: 100; // Ensure card stays above other content
  overflow: visible !important;
}
</style>
