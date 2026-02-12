<template>
  <div class="d-flex overflow-auto flex-wrap">
    <select-all-none-chips
      @selectAll="selectAll"
      @selectNone="selectNone"
      class="ma-1"
    />
    <v-text-field
      v-model="tagSearchFilter"
      style="max-width: 150px"
      placeholder="Filter tags by..."
      class="ma-1"
    />
    <v-chip-group
      @change="setTagsFromUserInput($event)"
      :value="tags"
      column
      multiple
      active-class="selected-chip"
    >
      <v-chip
        v-for="tag in displayedTags"
        :key="tag"
        :value="tag"
        :class="{
          'selected-chip': tags.includes(tag),
        }"
        outlined
        x-small
        class="d-flex align-center"
      >
        {{ tag }}
        <v-menu offset-y :close-on-content-click="false" bottom>
          <template v-slot:activator="{ on, attrs }">
            <v-icon x-small class="ml-1" v-bind="attrs" v-on="on">
              mdi-chevron-down
            </v-icon>
          </template>
          <v-card min-width="250" @click.stop :ripple="false">
            <v-card-text>
              <v-list dense class="pa-0">
                <v-list-item @click="handleTagAddToAll(tag)">
                  <v-list-item-title
                    >Add tag to all annotations</v-list-item-title
                  >
                </v-list-item>
                <v-list-item @click="handleTagRemoveFromAll(tag)">
                  <v-list-item-title
                    >Remove tag from all annotations</v-list-item-title
                  >
                </v-list-item>
              </v-list>
              <v-divider class="my-3"></v-divider>
              <div>
                <div class="text-subtitle-2 mb-2">Set Color for Tag</div>
                <v-radio-group v-model="colorOption" class="mt-0">
                  <v-radio
                    value="layer"
                    label="Default to color of layer"
                  ></v-radio>
                  <v-radio value="defined" label="Defined color"></v-radio>
                  <v-radio value="random" label="Random color"></v-radio>
                </v-radio-group>
                <color-picker-menu
                  v-model="tagColor"
                  v-if="colorOption === 'defined'"
                />
              </div>
            </v-card-text>
            <v-card-actions>
              <v-spacer></v-spacer>
              <v-btn color="primary" @click="applyColorToTag(tag)"
                >Apply Color</v-btn
              >
            </v-card-actions>
          </v-card>
        </v-menu>
      </v-chip>
    </v-chip-group>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import SelectAllNoneChips from "./SelectAllNoneChips.vue";
import ColorPickerMenu from "@/components/ColorPickerMenu.vue";
import { IAnnotation } from "@/store/model";

const props = withDefaults(
  defineProps<{
    value: string[];
    allSelected: boolean;
  }>(),
  {
    value: () => [],
  },
);

const emit = defineEmits<{
  (e: "input", value: string[]): void;
  (e: "update:allSelected", value: boolean): void;
}>();

const tags = computed({
  get() {
    return props.value;
  },
  set(val: string[]) {
    emit("input", val);
  },
});

const allSelectedInternal = ref(false);
const tagSearchFilter = ref("");
const tagColor = ref("#FFFFFF");
const colorOption = ref("defined");

watch(allSelectedInternal, (val) => {
  emit("update:allSelected", val);
});

watch(
  () => props.allSelected,
  (val) => {
    allSelectedInternal.value = val;
  },
);

const availableTags = computed((): string[] => {
  return Array.from(
    new Set([...annotationStore.annotationTags, ...store.toolTags]),
  );
});

const displayedTags = computed((): string[] => {
  if (!tagSearchFilter.value) {
    return availableTags.value;
  }
  const lowerCaseFilter = tagSearchFilter.value.toLowerCase();
  return availableTags.value.filter((tag) =>
    tag.toLowerCase().includes(lowerCaseFilter),
  );
});

function updateTagsIfAllSelected() {
  if (allSelectedInternal.value) {
    tags.value = [...availableTags.value];
  }
}

watch(availableTags, updateTagsIfAllSelected);
watch(() => props.allSelected, updateTagsIfAllSelected);

function setTagsFromUserInput(newTags: string[]) {
  allSelectedInternal.value = false;
  tags.value = [...newTags];
}

function selectAll() {
  allSelectedInternal.value = true;
}

function selectNone() {
  setTagsFromUserInput([]);
}

async function handleTagAddToAll(tag: string) {
  await annotationStore.addTagsToAllAnnotations([tag]);
}

async function handleTagRemoveFromAll(tag: string) {
  await annotationStore.removeTagsFromAllAnnotations([tag]);
}

async function applyColorToTag(tag: string) {
  const annotationsWithTag = annotationStore.annotations.filter(
    (annotation: IAnnotation) => annotation.tags.includes(tag),
  );
  const annotationIds = annotationsWithTag.map((a: IAnnotation) => a.id);

  const isRandomColor = colorOption.value === "random";
  const color = colorOption.value === "layer" ? null : tagColor.value;

  await annotationStore.colorAnnotationIds({
    annotationIds,
    color,
    randomize: isRandomColor,
  });
}

onMounted(() => {
  allSelectedInternal.value = props.allSelected;
  updateTagsIfAllSelected();
});

defineExpose({
  tags,
  allSelectedInternal,
  tagSearchFilter,
  tagColor,
  colorOption,
  availableTags,
  displayedTags,
  selectAll,
  selectNone,
  setTagsFromUserInput,
  handleTagAddToAll,
  handleTagRemoveFromAll,
  applyColorToTag,
});
</script>

<style lang="scss" scoped>
.selected-chip {
  border-color: #ffffff !important;
}
</style>
