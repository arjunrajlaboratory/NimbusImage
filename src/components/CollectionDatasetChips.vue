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
    <span v-else class="no-datasets text-caption text-medium-emphasis ma-1">
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
  chipsPerCollectionId: { [collectionId: string]: IChipsPerItemId };
}>();

const router = useRouter();

// `undefined` means "chips haven't been computed for this collection yet",
// which is different from a collection that genuinely has no datasets.
const chips = computed(
  () => props.chipsPerCollectionId[props.collectionId]?.chips,
);

function navigateToChip(chipItem: IChipAttrs) {
  if (chipItem.to) {
    router.push(chipItem.to);
  }
}

defineExpose({ chips, navigateToChip });
</script>

<style lang="scss" scoped>
/* AnnotationBrowser/AnnotationList.vue ships an UNLAYERED, non-scoped
   `td span { display: block; text-align: center; margin: auto; }`. Vuetify 4
   puts its utility classes in a cascade layer, and unlayered rules beat every
   layered one regardless of specificity — so that rule overrides `ma-1` and
   centers these chips inside their cell, under a left-aligned column header.
   These scoped rules are also unlayered, so they win it back. `4px` restates
   exactly what `ma-1` intended, keeping the vertical gap for wrapped rows. */
.colored-chip {
  margin: 4px;
}

.no-datasets {
  text-align: left;
  margin: 4px;
}
</style>
