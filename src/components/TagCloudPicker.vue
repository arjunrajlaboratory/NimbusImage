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

<script lang="ts">
import { Vue, Component, Watch, VModel, Prop } from "vue-property-decorator";
import store from "@/store";
import annotationStore from "@/store/annotation";
import SelectAllNoneChips from "./SelectAllNoneChips.vue";
import ColorPickerMenu from "@/components/ColorPickerMenu.vue";
import { IAnnotation } from "@/store/model";

@Component({
  components: {
    SelectAllNoneChips,
    ColorPickerMenu,
  },
})
export default class TagCloudPicker extends Vue {
  @VModel({ type: Array, default: () => [] })
  tags!: string[];

  readonly store = store;
  readonly annotationStore = annotationStore;

  @Prop({ required: true })
  allSelected!: boolean;

  allSelectedInternal = false;
  tagSearchFilter: string = "";
  tagColor = "#FFFFFF";
  colorOption = "defined";

  @Watch("allSelectedInternal")
  emiAllSelected() {
    this.$emit("update:allSelected", this.allSelectedInternal);
  }

  @Watch("allSelected")
  allSelectedPropChanged() {
    this.allSelectedInternal = this.allSelected;
  }

  mounted() {
    this.allSelectedPropChanged();
    this.updateTagsIfAllSelected();
  }

  get availableTags(): string[] {
    return Array.from(
      new Set([...this.annotationStore.annotationTags, ...this.store.toolTags]),
    );
  }

  get displayedTags(): string[] {
    if (!this.tagSearchFilter) {
      return this.availableTags;
    }
    const lowerCaseFilter = this.tagSearchFilter.toLowerCase();
    return this.availableTags.filter((tag) =>
      tag.toLowerCase().includes(lowerCaseFilter),
    );
  }

  @Watch("availableTags")
  @Watch("allSelected")
  updateTagsIfAllSelected() {
    if (this.allSelectedInternal) {
      this.tags = [...this.availableTags];
    }
  }

  setTagsFromUserInput(tags: string[]) {
    this.allSelectedInternal = false;
    this.tags = [...tags];
  }

  selectAll() {
    this.allSelectedInternal = true;
  }

  selectNone() {
    this.setTagsFromUserInput([]);
  }

  async handleTagAddToAll(tag: string) {
    await this.annotationStore.addTagsToAllAnnotations([tag]);
  }

  async handleTagRemoveFromAll(tag: string) {
    await this.annotationStore.removeTagsFromAllAnnotations([tag]);
  }

  async applyColorToTag(tag: string) {
    const annotationsWithTag = this.annotationStore.annotations.filter(
      (annotation: IAnnotation) => annotation.tags.includes(tag),
    );
    const annotationIds = annotationsWithTag.map((a: IAnnotation) => a.id);

    await this.annotationStore.colorAnnotationIds({
      annotationIds,
      color: this.tagColor,
      randomize: this.colorOption === "random",
    });
  }
}
</script>

<style lang="scss" scoped>
.selected-chip {
  border-color: #ffffff !important;
}
</style>
