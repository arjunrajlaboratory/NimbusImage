<template>
  <!-- Only datasets with a registered spatial table (upenncontrast_spatial
       plugin) have gene counts to offer. -->
  <v-card v-if="spatialStore.hasTable" class="gene-expression-card">
    <div class="d-flex align-center px-4 py-2">
      <span class="panel-section-title">Gene expression</span>
    </div>
    <v-card-text class="pt-0">
      <p class="gene-expression-hint">
        Gene counts come from this dataset's spatial table
        <span v-if="tableSize">({{ tableSize }})</span>, not from a computation,
        so they are not listed until you add them. Added genes can be used in
        filters, plots, color-by and the object list.
      </p>
      <div v-if="addedGenes.length > 0" class="added-genes">
        <span class="added-genes-label">Added:</span>
        <v-chip
          v-for="gene in shownGenes"
          :key="gene"
          size="small"
          variant="tonal"
          class="mr-1 mb-1"
        >
          {{ gene }}
        </v-chip>
        <span v-if="hiddenGeneCount > 0" class="added-genes-more">
          +{{ hiddenGeneCount }} more
        </span>
      </div>
      <!-- Opens the app-level dialog (App.vue): this card sits inside
           "Measure objects", which unmounts its content on close. -->
      <v-btn
        variant="outlined"
        color="primary"
        size="small"
        prepend-icon="mdi-dna"
        class="mt-2"
        @click="openGenesDialog"
      >
        Add genes…
      </v-btn>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed, watch } from "vue";
import store from "@/store";
import propertyStore, { isVirtualPropertyPath } from "@/store/properties";
import spatialStore from "@/store/spatial";
import { openGenesDialog } from "@/utils/genesDialog";

// The Analyze palette keeps its content mounted while closed, so the
// registry lookup waits until the card can actually be seen.
const props = withDefaults(defineProps<{ visible?: boolean }>(), {
  visible: true,
});

const MAX_SHOWN_GENES = 8;

watch(
  () => [props.visible, store.dataset?.id],
  ([visible]) => {
    if (visible) {
      spatialStore.ensureInfo();
    }
  },
  { immediate: true },
);

const tableSize = computed(() => {
  const info = spatialStore.info;
  if (!info) {
    return "";
  }
  return `${info.nObs.toLocaleString()} cells × ${info.nVar.toLocaleString()} genes`;
});

// Genes already added as live columns (["spatial", symbol] paths).
const addedGenes = computed(() =>
  propertyStore.virtualPropertyPaths
    .filter((path) => isVirtualPropertyPath(path) && path.length > 1)
    .map((path) => path[1]),
);

const shownGenes = computed(() => addedGenes.value.slice(0, MAX_SHOWN_GENES));

const hiddenGeneCount = computed(() =>
  Math.max(0, addedGenes.value.length - MAX_SHOWN_GENES),
);
</script>

<style lang="scss" scoped>
.gene-expression-hint {
  font-size: 0.875rem;
  opacity: 0.8;
  margin-bottom: 8px;
}

.added-genes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}

.added-genes-label {
  font-size: 0.875rem;
  margin-right: 8px;
  margin-bottom: 4px;
}

.added-genes-more {
  font-size: 0.8125rem;
  opacity: 0.7;
  margin-bottom: 4px;
}
</style>
