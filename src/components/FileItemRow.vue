<template>
  <div class="flex-grow-1 d-flex align-center">
    <!-- First chip only -->
    <v-chip
      v-if="debouncedChipsPerItemId[item._id]?.chips?.[0]"
      size="x-small"
      class="ma-1 type-indicator"
      v-bind="debouncedChipsPerItemId[item._id]?.chips?.[0]"
      @click.stop
    >
      {{ debouncedChipsPerItemId[item._id]?.chips?.[0].text }}
    </v-chip>
    <v-chip
      v-else-if="computedChipsIds.has(item._id)"
      size="x-small"
      class="ma-1 type-indicator"
      color="grey-darken-1"
    >
      Loading info...
    </v-chip>
    <v-tooltip text="Share Dataset">
      <template v-slot:activator="{ props: activatorProps }">
        <v-btn
          v-bind="activatorProps"
          v-if="debouncedChipsPerItemId[item._id]?.type === 'dataset'"
          size="x-small"
          icon
          class="ml-1"
          @click.stop="shareDialogVisible = true"
        >
          <v-icon size="x-small">mdi-share-variant</v-icon>
        </v-btn>
      </template>
    </v-tooltip>
    <v-tooltip :text="`Created: ${item.created ? formatDateString(item.created) : 'Unknown'}`" location="end">
      <template v-slot:activator="{ props: activatorProps }">
        <span
          v-bind="activatorProps"
          class="text-caption text-grey mx-2"
        >
          Modified: {{ item.updated ? formatDateString(item.updated) : "Unknown" }}
        </span>
      </template>
    </v-tooltip>
    <v-spacer />
    <span
      v-if="debouncedChipsPerItemId[item._id]?.type === 'configuration'"
      class="chip-label"
      >Datasets in collection:</span
    >
    <span
      v-else-if="debouncedChipsPerItemId[item._id]?.type === 'dataset'"
      class="chip-label"
      >In collections:</span
    >
    <div class="d-flex flex-wrap">
      <!-- Rest of the chips -->
      <v-chip
        size="x-small"
        v-for="(chipItem, i) in debouncedChipsPerItemId[item._id]?.chips?.slice(
          1,
        )"
        :key="'chip ' + i + ' item ' + item._id"
        class="ma-1"
        v-bind="chipItem"
        @click.stop
      >
        {{ chipItem.text }}
      </v-chip>
    </div>
    <slot name="actions"></slot>
    <share-dataset v-model="shareDialogVisible" :dataset="item" />
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { IGirderSelectAble } from "@/girder";
import { formatDateString } from "@/utils/date";
import ShareDataset from "./ShareDataset.vue";

withDefaults(
  defineProps<{
    item: IGirderSelectAble;
    debouncedChipsPerItemId: { [itemId: string]: any };
    computedChipsIds: Set<string>;
    showIcon?: boolean;
  }>(),
  {
    showIcon: true,
  },
);

const shareDialogVisible = ref(false);

defineExpose({ shareDialogVisible });
</script>
