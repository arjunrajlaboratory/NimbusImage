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

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import store from "@/store";
import { IGirderLargeImage } from "@/girder";
import { DEFAULT_LARGE_IMAGE_SOURCE } from "@/girder/index";
import { logError } from "@/utils/log";

const deletingImageId = ref<string | null>(null);
const previousNumberOfImages = ref(0);
const showNewImageIndicator = ref(false);

const largeImages = computed(() => store.allLargeImages);
const numberOfLargeImages = computed(() => largeImages.value.length);

onMounted(() => {
  previousNumberOfImages.value = numberOfLargeImages.value;
});

watch(numberOfLargeImages, (newValue) => {
  if (
    newValue > previousNumberOfImages.value &&
    previousNumberOfImages.value > 0
  ) {
    showNewImageIndicator.value = true;
    setTimeout(() => {
      showNewImageIndicator.value = false;
    }, 1500);
  }
  previousNumberOfImages.value = newValue;
});

const formattedLargeImages = computed(() =>
  largeImages.value.map((img: IGirderLargeImage) => ({
    ...img,
    displayName: formatName(img.name),
  })),
);

function formatName(name: string): string {
  if (name === DEFAULT_LARGE_IMAGE_SOURCE) {
    return "Original image";
  }
  return name.replace(/^(.+)\.[^.\s(]+(.*)$/, "$1$2");
}

function formatMeta(meta: Record<string, any>): string {
  const pairs: string[] = [];
  if (meta.tool) {
    pairs.push(`tool: ${meta.tool}`);
  }
  Object.entries(meta)
    .filter(([key]) => key !== "tool")
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([key, value]) => {
      pairs.push(`${key}: ${value}`);
    });
  return pairs.join("; ");
}

async function deleteImage(image: IGirderLargeImage) {
  deletingImageId.value = image._id;
  try {
    await store.deleteLargeImage(image);
  } finally {
    deletingImageId.value = null;
  }
}

const currentLargeImage = computed({
  get: () => store.currentLargeImage?._id || null,
  set: (imageId: string | null) => {
    if (imageId) {
      const image = largeImages.value.find(
        (img: IGirderLargeImage) => img._id === imageId,
      );
      if (image) {
        store.updateCurrentLargeImage(image);
      } else {
        logError("LargeImageDropdown", "Current large image not found");
      }
    }
  },
});

const shouldShow = computed(() => largeImages.value.length > 1);

defineExpose({
  shouldShow,
  formatName,
  currentLargeImage,
  formatMeta,
  previousNumberOfImages,
});
</script>
