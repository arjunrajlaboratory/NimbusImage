<template>
  <div class="transcripts-panel pa-3">
    <template v-if="!transcriptsStore.hasTranscripts">
      <p class="text-body-2 mb-2">
        {{
          transcriptsStore.error ??
          "No transcript store is registered for this dataset."
        }}
      </p>
      <p class="text-caption text-medium-emphasis mb-0">
        Register the 10x transcripts.zarr.zip with
        <code>xenium_register_transcripts.py</code> (nimbusimage-xenium-ingest
        skill).
      </p>
    </template>
    <template v-else>
      <v-switch
        :model-value="transcriptsStore.enabled"
        label="Show transcripts"
        color="primary"
        density="compact"
        hide-details
        class="mb-2"
        @update:model-value="transcriptsStore.setEnabled(!!$event)"
      />
      <v-autocomplete
        :model-value="transcriptsStore.symbols"
        :items="geneItems"
        :search="search"
        :loading="searching"
        :label="`Genes (up to ${MAX_TRANSCRIPT_GENES})`"
        multiple
        chips
        closable-chips
        clearable
        density="compact"
        variant="outlined"
        no-filter
        hide-no-data
        hide-details
        class="mb-2"
        @update:model-value="onSymbols"
        @update:search="onSearch"
      >
        <template #chip="{ item, props: chipProps }">
          <v-chip
            v-bind="chipProps"
            :style="{ borderLeft: `6px solid ${colorOf(String(item))}` }"
          >
            {{ item }}
          </v-chip>
        </template>
      </v-autocomplete>
      <div
        v-for="gene in transcriptsStore.genes"
        :key="gene.symbol"
        class="d-flex align-center gene-row"
      >
        <color-picker-menu
          :model-value="gene.color"
          class="mr-2"
          @update:model-value="
            transcriptsStore.setGeneColor({
              symbol: gene.symbol,
              color: $event,
            })
          "
        />
        <span class="text-body-2">{{ gene.symbol }}</span>
      </div>

      <div class="text-caption mt-3">
        Quality ≥ {{ transcriptsStore.minQv }}
        <span v-if="transcriptsStore.minQv === DEFAULT_TRANSCRIPT_MIN_QV">
          (Xenium's default)
        </span>
      </div>
      <v-slider
        :model-value="transcriptsStore.minQv"
        :min="0"
        :max="40"
        :step="1"
        density="compact"
        hide-details
        @update:model-value="transcriptsStore.setMinQv($event)"
      />

      <div class="text-caption mt-2">Rendering</div>
      <v-btn-toggle
        :model-value="transcriptsStore.mode"
        mandatory
        density="compact"
        variant="outlined"
        divided
        class="mb-2"
        @update:model-value="transcriptsStore.setMode($event)"
      >
        <v-btn value="auto" size="small">Auto</v-btn>
        <v-btn value="points" size="small">Points</v-btn>
        <v-btn value="density" size="small">Heat map</v-btn>
      </v-btn-toggle>
      <v-select
        :model-value="transcriptsStore.pointBudget"
        :items="budgetItems"
        item-title="title"
        item-value="value"
        label="Points on screen at most"
        density="compact"
        variant="outlined"
        hide-details
        class="mb-2"
        @update:model-value="transcriptsStore.setPointBudget($event)"
      />

      <div class="text-caption text-medium-emphasis status">
        {{ statusText }}
      </div>

      <cell-table-card :visible="visible" />

      <v-card v-if="readout" variant="tonal" class="mt-3 pa-2 readout">
        <div class="d-flex align-center">
          <span
            class="swatch mr-2"
            :style="{ background: colorOf(readout.symbol) }"
          />
          <strong>{{ readout.symbol }}</strong>
          <v-spacer />
          <v-btn
            icon="mdi-close"
            size="x-small"
            variant="text"
            aria-label="Dismiss"
            @click="transcriptsStore.setReadout(null)"
          />
        </div>
        <div class="text-caption">
          x {{ readout.x.toFixed(0) }}, y {{ readout.y.toFixed(0) }} px
          <span v-if="readout.quality !== null">
            · quality {{ readout.quality.toFixed(1) }}
          </span>
        </div>
        <div class="text-caption">{{ cellText }}</div>
        <v-btn
          v-if="readout.annotationId"
          size="small"
          variant="text"
          color="primary"
          prepend-icon="mdi-crosshairs-gps"
          :loading="navigating"
          class="mt-1"
          @click="goToCell"
        >
          Go to cell
        </v-btn>
        <div v-if="navigateError" class="text-caption text-error">
          {{ navigateError }}
        </div>
      </v-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { debounce } from "lodash";
import store from "@/store";
import spatialStore from "@/store/spatial";
import transcriptsStore, {
  DEFAULT_TRANSCRIPT_MIN_QV,
  MAX_TRANSCRIPT_GENES,
  TRANSCRIPT_POINT_BUDGETS,
} from "@/store/transcripts";
import ColorPickerMenu from "@/components/ColorPickerMenu.vue";
import CellTableCard from "@/components/CellTableCard.vue";
import { logError } from "@/utils/log";
import { extractErrorMessage } from "@/utils/errors";

/**
 * The Transcripts palette (SPATIAL_PLUGIN.md, Phase 3): picks the genes the
 * TranscriptOverlay draws, their colors, the quality threshold and the
 * rendering, and shows the overlay's status and the last clicked molecule.
 */

const props = defineProps<{ visible: boolean }>();

const search = ref("");
const searching = ref(false);
const results = ref<string[]>([]);
const navigating = ref(false);
const navigateError = ref<string | null>(null);

const readout = computed(() => transcriptsStore.readout);

// Picked genes stay listed even when the search no longer matches them, so
// their chips never lose their label.
const geneItems = computed(() =>
  Array.from(new Set([...transcriptsStore.symbols, ...results.value])),
);

const budgetItems = TRANSCRIPT_POINT_BUDGETS.map((value) => ({
  value,
  title: `${value.toLocaleString()} points`,
}));

function colorOf(symbol: string): string {
  return (
    transcriptsStore.genes.find((gene) => gene.symbol === symbol)?.color ??
    "#FFFFFF"
  );
}

const statusText = computed(() => {
  if (!transcriptsStore.enabled) {
    return "Overlay off.";
  }
  if (transcriptsStore.genes.length === 0) {
    return "Pick a gene to show its molecules.";
  }
  const status = transcriptsStore.status;
  if (!status) {
    return "Loading…";
  }
  const note = status.note ? ` ${status.note}` : "";
  switch (status.rendering) {
    case "points":
      return `${status.points.toLocaleString()} molecules (pyramid level ${status.level}).${note}`;
    case "density":
      return `Density heat map.${note}`;
    default:
      return note || "Nothing to show in this view.";
  }
});

const cellText = computed(() =>
  readout.value?.annotationId
    ? "Inside a segmented cell."
    : "Not inside a drawn cell outline.",
);

let searchToken = 0;
const runSearch = debounce(async (query: string) => {
  const datasetId = store.dataset?.id;
  if (!datasetId) {
    return;
  }
  const token = ++searchToken;
  searching.value = true;
  try {
    const found = await store.spatialAPI.searchTranscriptGenes(
      datasetId,
      query,
      25,
    );
    if (token === searchToken) {
      results.value = found;
    }
  } catch (error) {
    logError("Transcript gene search failed:", error);
  } finally {
    if (token === searchToken) {
      searching.value = false;
    }
  }
}, 250);

function onSearch(query: string) {
  search.value = query ?? "";
  runSearch(search.value);
}

function onSymbols(symbols: string[]) {
  transcriptsStore.setSymbols(symbols ?? []);
  search.value = "";
}

async function goToCell() {
  const annotationId = readout.value?.annotationId;
  if (!annotationId) {
    return;
  }
  navigating.value = true;
  navigateError.value = null;
  try {
    await transcriptsStore.goToCell(annotationId);
  } catch (error) {
    logError("Failed to navigate to the molecule's cell:", error);
    navigateError.value = extractErrorMessage(error);
  } finally {
    navigating.value = false;
  }
}

// The palette content stays mounted while hidden; look the registration up
// only when the palette is actually shown for the current dataset.
watch(
  () => [props.visible, store.dataset?.id],
  () => {
    if (props.visible) {
      transcriptsStore.ensureSchema();
      spatialStore.ensureInfo();
      if (results.value.length === 0) {
        runSearch("");
      }
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  runSearch.cancel();
});

defineExpose({ statusText, cellText, onSymbols, onSearch, goToCell });
</script>

<style lang="scss" scoped>
.transcripts-panel {
  width: 100%;
}

.gene-row {
  min-height: 32px;
}

.swatch {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.status {
  min-height: 1.5em;
}
</style>
