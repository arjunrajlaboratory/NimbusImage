<template>
  <v-menu v-model="showMenu" :position-x="x" :position-y="y" absolute offset-y>
    <v-card min-width="300" @click.stop :ripple="false">
      <v-card-title class="text-subtitle-1">Edit Annotation</v-card-title>
      <v-card-text>
        <div class="mb-4">
          <div class="text-subtitle-2 mb-2">Color Options</div>
          <v-radio-group v-model="colorOption" class="mt-0">
            <v-radio value="layer" label="Default to color of layer"></v-radio>
            <v-radio value="random" label="Random color"></v-radio>
            <v-radio value="defined" label="Defined color"></v-radio>
          </v-radio-group>
          <color-picker-menu
            v-model="selectedColor"
            v-if="colorOption === 'defined'"
            class="mt-2"
          />
        </div>
        <v-divider class="my-3"></v-divider>
        <div>
          <div class="text-subtitle-2 mb-2">Change Tags</div>
          <tag-picker v-model="selectedTags" />
        </div>
        <v-divider class="my-3"></v-divider>
        <div>
          <v-checkbox
            v-model="applyToSameTags"
            label="Apply to all annotations with same tags"
            class="mb-2"
          />
        </div>
        <div class="d-flex align-center position-relative">
          <v-btn text small class="px-0" @click="copyAnnotationId">
            <v-icon
              small
              class="mr-1"
              :color="copySuccess ? 'success' : undefined"
            >
              {{ copySuccess ? "mdi-check" : "mdi-content-copy" }}
            </v-icon>
            Copy Annotation ID to clipboard
          </v-btn>
        </div>
      </v-card-text>
      <v-card-actions>
        <v-btn color="error" @click="deleteAnnotation"> Delete Object </v-btn>
        <v-spacer></v-spacer>
        <v-btn color="secondary" @click="cancel"> Cancel </v-btn>
        <v-btn color="primary" @click="save"> Apply </v-btn>
      </v-card-actions>
    </v-card>
  </v-menu>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import ColorPickerMenu from "@/components/ColorPickerMenu.vue";
import TagPicker from "@/components/TagPicker.vue";
import { IAnnotation } from "@/store/model";
import annotationStore from "@/store/annotation";
import { tagFilterFunction } from "@/utils/annotation";
import { logError } from "@/utils/log";

const props = defineProps<{
  show: boolean;
  x: number;
  y: number;
  annotation: IAnnotation | null;
}>();

const emit = defineEmits<{
  (e: "cancel"): void;
}>();

const selectedColor = ref("#FFFFFF");
const selectedTags = ref<string[]>([]);
const colorOption = ref("layer");
const applyToSameTags = ref(false);
const copySuccess = ref(false);

const showMenu = computed({
  get: () => props.show,
  set: (value: boolean) => {
    if (!value) {
      emit("cancel");
    }
  },
});

watch(
  () => props.annotation,
  () => {
    if (props.annotation) {
      colorOption.value = props.annotation.color === null ? "layer" : "defined";
      selectedColor.value = props.annotation.color || "#FFFFFF";
      selectedTags.value = [...props.annotation.tags];
      applyToSameTags.value = false;
    }
  },
  { immediate: true },
);

function cancel() {
  emit("cancel");
}

function save() {
  if (!props.annotation) {
    return;
  }

  // Determine color based on selected option
  const isRandomColor = colorOption.value === "random";
  const newColor = colorOption.value === "layer" ? null : selectedColor.value;
  const tagsChanged = !areTagsEqual(props.annotation.tags, selectedTags.value);

  if (applyToSameTags.value) {
    // Get all annotations with the same original tags
    const annotationsWithSameTags = annotationStore.annotations.filter(
      (annotation: IAnnotation) =>
        props.annotation &&
        annotation.tags.length === props.annotation.tags.length &&
        annotation.tags.every((tag) => props.annotation!.tags.includes(tag)),
    );
    const annotationIds = annotationsWithSameTags.map((a: IAnnotation) => a.id);

    // Update colors if changed
    if (props.annotation.color !== newColor || isRandomColor) {
      annotationStore.colorAnnotationIds({
        annotationIds,
        color: newColor,
        randomize: isRandomColor,
      });
    }

    // Update tags if changed
    if (tagsChanged) {
      annotationStore.replaceTagsByAnnotationIds({
        annotationIds,
        tags: selectedTags.value,
      });
    }
  } else {
    // Single annotation updates
    if (props.annotation.color !== newColor || isRandomColor) {
      annotationStore.colorAnnotationIds({
        annotationIds: [props.annotation.id],
        color: newColor,
        randomize: isRandomColor,
      });
    }

    if (tagsChanged) {
      annotationStore.replaceTagsByAnnotationIds({
        annotationIds: [props.annotation.id],
        tags: selectedTags.value,
      });
    }
  }

  emit("cancel"); // Close the menu
}

function deleteAnnotation() {
  if (props.annotation) {
    annotationStore.deleteAnnotations([props.annotation.id]);
  }
  emit("cancel"); // Close the menu
}

function areTagsEqual(tags1: string[], tags2: string[]): boolean {
  return tagFilterFunction(tags1, tags2, true);
}

async function copyAnnotationId() {
  if (props.annotation) {
    try {
      await navigator.clipboard.writeText(props.annotation.id);
      copySuccess.value = true;
      setTimeout(() => {
        copySuccess.value = false;
      }, 2000);
    } catch (err) {
      logError("Failed to copy annotation ID:", err);
    }
  }
}

defineExpose({
  showMenu,
  selectedColor,
  selectedTags,
  colorOption,
  applyToSameTags,
  copySuccess,
  cancel,
  save,
  deleteAnnotation,
  copyAnnotationId,
});
</script>
<style>
.v-card {
  user-select: none;
}

.v-card::before {
  background-color: transparent !important;
}
</style>
