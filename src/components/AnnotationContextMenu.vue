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

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import ColorPickerMenu from "@/components/ColorPickerMenu.vue";
import TagPicker from "@/components/TagPicker.vue";
import { IAnnotation } from "@/store/model";
import store from "@/store";
import annotationStore from "@/store/annotation";
import { tagFilterFunction } from "@/utils/annotation";
import { logError } from "@/utils/log";

@Component({
  components: { ColorPickerMenu, TagPicker },
})
export default class AnnotationContextMenu extends Vue {
  readonly store = store;
  readonly annotationStore = annotationStore;

  @Prop({ required: true })
  readonly show!: boolean;

  @Prop({ required: true })
  readonly x!: number;

  @Prop({ required: true })
  readonly y!: number;

  @Prop({ required: true })
  readonly annotation!: IAnnotation | null;

  selectedColor = "#FFFFFF";
  selectedTags: string[] = [];
  colorOption = "layer";
  applyToSameTags = false;
  copySuccess = false;

  get showMenu() {
    return this.show;
  }

  set showMenu(value: boolean) {
    if (!value) {
      this.$emit("cancel");
    }
  }

  @Watch("annotation", { immediate: true })
  onAnnotationChange() {
    if (this.annotation) {
      this.colorOption = this.annotation.color === null ? "layer" : "defined";
      this.selectedColor = this.annotation.color || "#FFFFFF";
      this.selectedTags = [...this.annotation.tags];
      this.applyToSameTags = false;
    }
  }

  cancel() {
    this.$emit("cancel");
  }

  save() {
    if (!this.annotation) {
      return;
    }

    // Determine color based on selected option
    const isRandomColor = this.colorOption === "random";
    const newColor = this.colorOption === "layer" ? null : this.selectedColor;
    const tagsChanged = !this.areTagsEqual(
      this.annotation.tags,
      this.selectedTags,
    );

    if (this.applyToSameTags) {
      // Get all annotations with the same original tags
      const annotationsWithSameTags = this.annotationStore.annotations.filter(
        (annotation: IAnnotation) =>
          this.annotation &&
          annotation.tags.length === this.annotation.tags.length &&
          annotation.tags.every((tag) => this.annotation!.tags.includes(tag)),
      );
      const annotationIds = annotationsWithSameTags.map(
        (a: IAnnotation) => a.id,
      );

      // Update colors if changed
      if (this.annotation.color !== newColor || isRandomColor) {
        this.annotationStore.colorAnnotationIds({
          annotationIds,
          color: newColor,
          randomize: isRandomColor,
        });
      }

      // Update tags if changed
      if (tagsChanged) {
        this.annotationStore.replaceTagsByAnnotationIds({
          annotationIds,
          tags: this.selectedTags,
        });
      }
    } else {
      // Single annotation updates
      if (this.annotation.color !== newColor || isRandomColor) {
        this.annotationStore.colorAnnotationIds({
          annotationIds: [this.annotation.id],
          color: newColor,
          randomize: isRandomColor,
        });
      }

      if (tagsChanged) {
        this.annotationStore.replaceTagsByAnnotationIds({
          annotationIds: [this.annotation.id],
          tags: this.selectedTags,
        });
      }
    }

    this.$emit("cancel"); // Close the menu
  }

  deleteAnnotation() {
    if (this.annotation) {
      this.annotationStore.deleteAnnotations([this.annotation.id]);
    }
    this.$emit("cancel"); // Close the menu
  }

  private areTagsEqual(tags1: string[], tags2: string[]): boolean {
    return tagFilterFunction(tags1, tags2, true);
  }

  async copyAnnotationId() {
    if (this.annotation) {
      try {
        await navigator.clipboard.writeText(this.annotation.id);
        this.copySuccess = true;
        setTimeout(() => {
          this.copySuccess = false;
        }, 2000);
      } catch (err) {
        logError("Failed to copy annotation ID:", err);
      }
    }
  }
}
</script>
<style>
.v-card {
  user-select: none;
}

.v-card::before {
  background-color: transparent !important;
}
</style>
