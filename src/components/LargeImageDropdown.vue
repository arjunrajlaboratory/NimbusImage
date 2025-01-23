<template>
  <div style="position: relative">
    <v-select
      v-if="shouldShow"
      v-model="currentLargeImage"
      :items="formattedLargeImages"
      item-text="displayName"
      item-value="_id"
      label="Select Image"
      dense
      style="width: auto; padding: 4px 0"
      hide-details
    >
      <template v-slot:item="{ item }">
        <v-list-item-content style="flex: 1 1 auto; min-width: 0">
          <v-list-item-title>{{ item.displayName }}</v-list-item-title>
          <v-list-item-subtitle
            v-if="item.meta"
            class="text--secondary"
            style="font-size: 0.875rem; opacity: 0.7"
            >{{ formatMeta(item.meta) }}</v-list-item-subtitle
          >
        </v-list-item-content>
        <v-btn
          v-if="item.name !== 'multi-source2.json'"
          icon
          small
          color="error"
          class="ml-2"
          :loading="deletingImageId === item._id"
          @click.stop="deleteImage(item)"
        >
          <v-icon small>mdi-delete</v-icon>
        </v-btn>
      </template>
      <template v-slot:selection="{ item }">
        <v-list-item-content
          style="flex: 1 1 auto; min-width: 0; white-space: normal"
        >
          <v-list-item-title>{{ item.displayName }}</v-list-item-title>
          <v-list-item-subtitle
            v-if="item.meta"
            class="text--secondary"
            style="white-space: normal; font-size: 0.875rem; opacity: 0.7"
            >{{ formatMeta(item.meta) }}</v-list-item-subtitle
          >
        </v-list-item-content>
      </template>
    </v-select>

    <v-fade-transition>
      <v-overlay
        v-if="showNewImageIndicator"
        absolute
        opacity="0.2"
        color="success"
      >
      </v-overlay>
    </v-fade-transition>
  </div>
</template>

<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store from "@/store";
import { IGirderLargeImage } from "@/girder";

@Component
export default class LargeImageDropdown extends Vue {
  readonly store = store;
  deletingImageId: string | null = null;

  previousNumberOfImages = 0;
  showNewImageIndicator = false;

  mounted() {
    this.previousNumberOfImages = this.numberOfLargeImages;
    console.log("mounted", this.previousNumberOfImages);
  }

  get largeImages() {
    return this.store.allLargeImages;
  }

  get numberOfLargeImages() {
    return this.largeImages.length;
  }

  @Watch("numberOfLargeImages")
  onNumberOfLargeImagesChange(newValue: number) {
    if (
      newValue > this.previousNumberOfImages &&
      this.previousNumberOfImages > 0
    ) {
      this.showNewImageIndicator = true;
      setTimeout(() => {
        this.showNewImageIndicator = false;
      }, 1500); // Hide after 1.5 seconds
    }
    this.previousNumberOfImages = newValue;
  }

  get formattedLargeImages() {
    return this.largeImages.map((img: IGirderLargeImage) => ({
      ...img,
      displayName: this.formatName(img.name),
    }));
  }

  formatName(name: string): string {
    if (name === "multi-source2.json") {
      return "Original image";
    }
    // Handle cases like "output.tiff (1)" -> "output (1)"
    const baseName = name.replace(/^(.+)\.[^.\s(]+(.*)$/, "$1$2");
    return baseName;
  }

  formatMeta(meta: Record<string, any>): string {
    const pairs: string[] = [];

    // Add tool first if it exists
    if (meta.tool) {
      pairs.push(`tool: ${meta.tool}`);
    }

    // Add remaining keys in alphabetical order
    Object.entries(meta)
      .filter(([key]) => key !== "tool")
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([key, value]) => {
        pairs.push(`${key}: ${value}`);
      });

    return pairs.join("; ");
  }

  async deleteImage(image: IGirderLargeImage) {
    this.deletingImageId = image._id;
    try {
      await this.store.deleteLargeImage(image);
    } finally {
      this.deletingImageId = null;
    }
  }

  get currentLargeImage() {
    return this.store.currentLargeImage?._id || null;
  }

  set currentLargeImage(imageId: string | null) {
    if (imageId) {
      // Find the full image object from the ID
      const image = this.largeImages.find(
        (img: IGirderLargeImage) => img._id === imageId,
      );
      if (image) {
        this.store.updateCurrentLargeImage(image);
      }
    }
  }

  get shouldShow(): boolean {
    return this.largeImages.length > 1;
  }
}
</script>
