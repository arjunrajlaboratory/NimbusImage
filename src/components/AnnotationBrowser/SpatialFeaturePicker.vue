<template>
  <v-autocomplete
    :model-value="modelValue"
    :items="items"
    :search="search"
    :loading="searching"
    :label="label"
    :hint="hint"
    :persistent-hint="!!hint"
    multiple
    chips
    closable-chips
    clearable
    density="compact"
    variant="outlined"
    no-filter
    hide-no-data
    @update:model-value="onUpdate"
    @update:search="onSearch"
  >
    <template #item="{ item, props: itemProps }">
      <v-list-item v-bind="itemProps" :title="String(item)">
        <template #append>
          <span class="feature-type">{{ featureTypeOf(String(item)) }}</span>
        </template>
      </v-list-item>
    </template>
  </v-autocomplete>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { debounce } from "lodash";
import store from "@/store";
import { ISpatialFeature } from "@/store/model";
import { logError } from "@/utils/log";

// Symbols picked from the dataset's spatial table, searched server-side as
// the user types (4,624 genes is too many to preload into a select). The
// picked symbols stay listed even when the current search no longer matches
// them, so chips never lose their label.
const props = withDefaults(
  defineProps<{
    modelValue: string[];
    max?: number;
    label?: string;
  }>(),
  { max: 64, label: "Genes" },
);

const emit = defineEmits<{
  (event: "update:modelValue", value: string[]): void;
}>();

const search = ref("");
const searching = ref(false);
const results = ref<ISpatialFeature[]>([]);
const featureTypes = ref<Record<string, string | null>>({});

const items = computed(() => {
  const symbols = new Set(props.modelValue);
  for (const feature of results.value) {
    symbols.add(feature.symbol);
  }
  return [...symbols];
});

const hint = computed(() =>
  props.modelValue.length >= props.max
    ? `At most ${props.max} genes per request`
    : "",
);

function featureTypeOf(symbol: string): string {
  return featureTypes.value[symbol] ?? "";
}

let searchSequence = 0;

async function runSearch(query: string) {
  const datasetId = store.dataset?.id;
  if (!datasetId) {
    return;
  }
  const sequence = ++searchSequence;
  searching.value = true;
  try {
    const found = await store.spatialAPI.searchFeatures(datasetId, query);
    if (sequence !== searchSequence) {
      return;
    }
    results.value = found;
    for (const feature of found) {
      featureTypes.value[feature.symbol] = feature.featureType;
    }
  } catch (error) {
    if (sequence === searchSequence) {
      logError("Feature search failed:", error);
    }
  } finally {
    if (sequence === searchSequence) {
      searching.value = false;
    }
  }
}

const debouncedSearch = debounce(runSearch, 200);

function onSearch(value: string) {
  search.value = value ?? "";
  debouncedSearch(search.value);
}

function onUpdate(value: string[]) {
  emit("update:modelValue", value.slice(0, props.max));
}

// Populate the list on mount so opening the menu shows something before the
// first keystroke.
watch(
  () => store.dataset?.id,
  (datasetId) => {
    results.value = [];
    if (datasetId) {
      runSearch("");
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  debouncedSearch.cancel();
});

defineExpose({ items, runSearch, onSearch, onUpdate, results });
</script>

<style lang="scss" scoped>
.feature-type {
  font-size: 11px;
  opacity: 0.6;
}
</style>
