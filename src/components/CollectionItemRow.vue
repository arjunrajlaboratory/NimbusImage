<template>
  <div class="flex-grow-1 d-flex align-center">
    <!-- Collection type indicator -->
    <v-chip size="x-small" class="ma-1 type-indicator" color="grey-darken-1">
      Collection
    </v-chip>

    <v-tooltip
      :text="`Created: ${collection.created ? formatDateString(collection.created) : 'Unknown'}`"
      location="end"
    >
      <template v-slot:activator="{ props: activatorProps }">
        <span
          v-bind="activatorProps"
          class="text-caption"
          style="margin-left: 8px; margin-right: 8px; opacity: 0.4"
        >
          Modified:
          {{
            collection.updated
              ? formatDateString(collection.updated)
              : "Unknown"
          }}
        </span>
      </template>
    </v-tooltip>

    <v-spacer />

    <span class="chip-label">Datasets in collection:</span>

    <div class="d-flex flex-wrap">
      <!-- Dataset chips -->
      <template v-if="debouncedChipsPerItemId[collection._id]?.chips">
        <v-chip
          size="x-small"
          variant="outlined"
          v-for="(chipItem, i) in debouncedChipsPerItemId[collection._id]
            ?.chips"
          :key="'chip ' + i + ' collection ' + collection._id"
          class="ma-1 colored-chip"
          :style="{ '--chip-color': chipItem.color }"
          @click.stop="navigateToChip(chipItem)"
        >
          {{ chipItem.text }}
        </v-chip>
      </template>

      <!-- Loading state -->
      <v-chip
        v-else-if="computedChipsIds.has(collection._id)"
        size="x-small"
        class="ma-1"
        color="grey-lighten-1"
      >
        Loading datasets...
      </v-chip>

      <!-- No datasets state -->
      <v-chip v-else size="x-small" class="ma-1" color="grey-lighten-2">
        No datasets
      </v-chip>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from "vue-router";
import { IUPennCollection } from "@/girder";
import { formatDateString } from "@/utils/date";
import type { RouteLocationRaw } from "vue-router";

interface IChipAttrs {
  text: string;
  color: string;
  to?: RouteLocationRaw;
}

defineProps<{
  collection: IUPennCollection;
  debouncedChipsPerItemId: { [itemId: string]: any };
  computedChipsIds: Set<string>;
}>();

const router = useRouter();

function navigateToChip(chipItem: IChipAttrs) {
  if (chipItem.to) {
    router.push(chipItem.to);
  }
}

defineExpose({ navigateToChip });
</script>

<style lang="scss" scoped>
.type-indicator {
  border-radius: 4px;
  font-family: "Roboto Mono", monospace;
  font-size: 9px;
  letter-spacing: 0.5px;
  height: 16px;
  padding: 0 4px;
  font-weight: 500;
}

.chip-label {
  font-size: 0.9em;
}
</style>
