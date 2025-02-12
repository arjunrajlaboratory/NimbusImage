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
<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store from "@/store";
import propertiesStore from "@/store/properties";
import annotationStore from "@/store/annotation";
import {
  AnnotationShape,
  IWorkerLabels,
  IWorkerInterfaceValues,
} from "@/store/model";
import TagFilterEditor from "@/components/AnnotationBrowser/TagFilterEditor.vue";
import LayerSelect from "@/components/LayerSelect.vue";
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

// Popup for new tool configuration
@Component({
  components: {
    LayerSelect,
    TagFilterEditor,
    DockerImageSelect,
    TagPicker,
    PropertyWorkerMenu,
  },
})
export default class PropertyCreation extends Vue {
  readonly store = store;
  readonly propertyStore = propertiesStore;
  readonly annotationStore = annotationStore;

  availableShapes = this.store.availableToolShapes;

  areTagsExclusive: boolean = false;
  filteringTags: string[] = [];
  filteringShape: AnnotationShape | null = null;

  originalName = "New Property";
  isNameGenerated = true;

  interfaceValues: IWorkerInterfaceValues = {};

  computeUponCreation = true;

  get deduplicatedName() {
    // Find a name which is not already taken
    let count = 0;
    let candidateName = this.originalName;
    while (
      this.propertyStore.properties.some(
        (property) => property.name === candidateName,
      )
    ) {
      candidateName = `${this.originalName} (${++count})`;
    }
    return candidateName;
  }

  get generatedName() {
    let nameList = [];
    if (this.filteringTags.length) {
      nameList.push(this.filteringTags.join(", "));
    } else {
      if (this.areTagsExclusive) {
        nameList.push("No tag");
      } else {
        nameList.push("All");
      }
    }
    if (this.dockerImage) {
      const imageInterfaceName =
        this.propertyStore.workerImageList[this.dockerImage]?.interfaceName;
      if (imageInterfaceName) {
        nameList.push(imageInterfaceName);
      } else {
        nameList.push(this.dockerImage);
      }
    } else {
      nameList.push("No image");
    }
    return removeRepeatedWords(nameList.join(" "));
  }

  @Watch("isNameGenerated")
  @Watch("generatedName")
  generatedNameChanged() {
    if (this.isNameGenerated) {
      this.originalName = this.generatedName;
    }
  }

  dockerImage: string | null = null;

  get propertyImageFilter() {
    return (labels: IWorkerLabels) => {
      return (
        labels.isPropertyWorker !== undefined &&
        (labels.annotationShape || null) === this.filteringShape
      );
    };
  }

  @Watch("filteringShape")
  filteringShapeChanged() {
    this.dockerImage = null;
  }

  @Watch("filteringTags")
  filteringTagsChanged() {
    // If no tags are selected, then reset the shape to null
    if (this.filteringTags.length === 0) {
      this.filteringShape = null;
      return;
    }
    // The keys of counts are in AnnotationShape
    // Find the best matching shape for these tags
    const counts: { [key: string]: number } = {};
    for (const annotation of this.annotationStore.annotations) {
      if (
        tagFilterFunction(
          annotation.tags,
          this.filteringTags,
          this.areTagsExclusive,
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
        this.filteringShape = shape as AnnotationShape;
      }
    }
  }

  @Watch("dockerImage")
  dockerImageChanged() {
    this.isNameGenerated = true;
    if (this.dockerImage) {
      this.propertyStore.fetchWorkerInterface({ image: this.dockerImage });
    }
  }

  createProperty() {
    if (!this.dockerImage || !this.filteringShape) {
      return;
    }
    this.propertyStore
      .createProperty({
        name: this.deduplicatedName,
        image: this.dockerImage,
        tags: {
          tags: this.filteringTags,
          exclusive: this.areTagsExclusive,
        },
        shape: this.filteringShape,
        workerInterface: this.interfaceValues,
      })
      .then((property) => {
        this.propertyStore.togglePropertyPathVisibility([property.id]);
        if (this.computeUponCreation) {
          this.propertyStore.computeProperty(property);
        }
      });
    this.reset();
  }

  reset() {
    this.filteringTags = [];
    this.areTagsExclusive = false;
    this.filteringShape = null;
    this.dockerImage = null;
    this.originalName = "New Property";
    this.isNameGenerated = true;
  }

  get shapeSelectionString(): string {
    return this.filteringTags.length > 0 ? "Of shape:" : "Or by shape:";
  }
}
</script>
<style lang="scss" scoped>
.property-creation-card {
  position: relative; // Ensure proper stacking context
  z-index: 100; // Ensure card stays above other content
  overflow: visible !important;
}
</style>
