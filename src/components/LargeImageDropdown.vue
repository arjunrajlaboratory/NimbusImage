<template>
  <div style="position: relative">
    <div class="d-flex align-center">
      <v-select
        v-if="shouldShow"
        v-model="currentLargeImage"
        :items="formattedLargeImages"
        item-text="displayName"
        item-value="_id"
        label="Select Image"
        dense
        style="width: auto; padding: 4px 0; flex: 1"
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
            v-if="item.name !== DEFAULT_LARGE_IMAGE_SOURCE"
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

      <v-btn
        v-if="showDownloadButton"
        icon
        small
        :loading="downloading"
        title="Download image file"
        @click="downloadImage"
      >
        <v-icon small>mdi-download</v-icon>
      </v-btn>
    </div>

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
import { DEFAULT_LARGE_IMAGE_SOURCE } from "@/girder/index";
import { logError } from "@/utils/log";
import { downloadToClient } from "@/utils/download";

@Component
export default class LargeImageDropdown extends Vue {
  readonly store = store;
  readonly DEFAULT_LARGE_IMAGE_SOURCE = DEFAULT_LARGE_IMAGE_SOURCE;
  deletingImageId: string | null = null;
  downloading = false;

  previousNumberOfImages = 0;
  showNewImageIndicator = false;

  mounted() {
    this.previousNumberOfImages = this.numberOfLargeImages;
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
    if (name === DEFAULT_LARGE_IMAGE_SOURCE) {
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
      } else {
        logError("LargeImageDropdown", "Current large image not found");
      }
    }
  }

  get shouldShow(): boolean {
    return this.largeImages.length > 1;
  }

  get showDownloadButton(): boolean {
    return this.store.isAdmin && this.store.currentLargeImage != null;
  }

  async downloadImage() {
    const image = this.store.currentLargeImage;
    if (!image) {
      return;
    }
    this.downloading = true;
    try {
      const data = await this.store.api.downloadResource(image);
      downloadToClient({
        href: URL.createObjectURL(data),
        download: image.name,
      });
    } catch (error) {
      logError("Failed to download image:", error);
    } finally {
      this.downloading = false;
    }
  }
}
</script>
