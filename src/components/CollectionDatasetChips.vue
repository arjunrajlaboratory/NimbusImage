<template>
  <div class="d-flex flex-wrap align-center">
    <!-- Dataset chips -->
    <template v-if="chips?.length">
      <v-chip
        size="x-small"
        variant="outlined"
        v-for="(chipItem, i) in chips"
        :key="'chip ' + i + ' collection ' + collectionId"
        class="ma-1 colored-chip"
        :style="{ '--chip-color': `rgb(var(--v-theme-${chipItem.color}))` }"
        @click.stop="navigateToChip(chipItem)"
      >
        {{ chipItem.text }}
      </v-chip>
    </template>

    <!-- Not computed yet -->
    <v-chip v-else-if="!chips" size="x-small" class="ma-1" color="secondary">
      Loading datasets...
    </v-chip>

    <!-- Computed, but the collection has no datasets -->
    <span v-else class="text-caption text-medium-emphasis ma-1">
      No datasets
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import type { IChipAttrs, IChipsPerItemId } from "@/utils/collectionChips";

const props = defineProps<{
  collectionId: string;
  debouncedChipsPerItemId: { [itemId: string]: IChipsPerItemId };
}>();

const router = useRouter();

// `undefined` means "chips haven't been computed for this collection yet",
// which is different from a collection that genuinely has no datasets.
const chips = computed(
  () => props.debouncedChipsPerItemId[props.collectionId]?.chips,
);

function navigateToChip(chipItem: IChipAttrs) {
  if (chipItem.to) {
    router.push(chipItem.to);
  }
}

defineExpose({ chips, navigateToChip });
</script>
