<template>
  <div class="property-category-filter">
    <v-text-field
      v-model="search"
      density="compact"
      variant="outlined"
      hide-details
      clearable
      prepend-inner-icon="mdi-magnify"
      :placeholder="`Search ${totalLabel} values`"
      class="pcf-search"
      @keydown.enter.prevent="toggleFirstShown"
    />

    <div v-if="modelValue.length > 0" class="pcf-chips">
      <v-chip
        v-for="value in modelValue"
        :key="value"
        size="x-small"
        closable
        label
        @click:close="toggle(value)"
      >
        {{ value }}
      </v-chip>
    </div>

    <div class="pcf-summary">
      <span>
        {{
          modelValue.length === 0
            ? "None selected — showing all"
            : `${modelValue.length} selected — showing any of them`
        }}
      </span>
      <v-spacer />
      <v-btn
        v-if="search && shownEntries.length > 0"
        variant="text"
        size="x-small"
        @click="selectShown"
      >
        Select {{ shownEntries.length }} shown
      </v-btn>
      <v-btn
        v-if="modelValue.length > 0"
        variant="text"
        size="x-small"
        @click="emit('update:modelValue', [])"
      >
        Clear
      </v-btn>
    </div>

    <v-progress-linear v-if="loading" indeterminate height="2" />
    <div v-if="error" class="pcf-hint pcf-error">{{ error }}</div>
    <div v-else-if="!loading && shownEntries.length === 0" class="pcf-hint">
      {{ search ? "No values match" : "No values" }}
    </div>
    <v-virtual-scroll
      v-else
      :items="shownEntries"
      :height="Math.min(shownEntries.length * ROW_HEIGHT, 240)"
      :item-height="ROW_HEIGHT"
      class="pcf-list"
    >
      <template #default="{ item }">
        <div
          :key="item.value"
          class="pcf-row"
          :class="{ 'pcf-row--selected': selectedSet.has(item.value) }"
          :title="item.value"
          @click="toggle(item.value)"
        >
          <v-icon size="16" class="pcf-check">
            {{
              selectedSet.has(item.value)
                ? "mdi-checkbox-marked"
                : "mdi-checkbox-blank-outline"
            }}
          </v-icon>
          <span class="pcf-value">{{ item.value }}</span>
          <span class="pcf-count">{{ item.count }}</span>
        </div>
      </template>
    </v-virtual-scroll>
    <div v-if="truncatedHint" class="pcf-hint">{{ truncatedHint }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from "vue";
import debounce from "lodash/debounce";
import store from "@/store";
import propertyStore from "@/store/properties";
import { IPropertyDistinctValues } from "@/store/model";
import { logError } from "@/utils/log";

const ROW_HEIGHT = 26;

const props = defineProps<{
  propertyPath: string[];
  modelValue: string[];
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string[]): void;
}>();

const search = ref<string | null>("");
// The unsearched list. When it is complete (not truncated) every search is
// answered locally; otherwise each search goes to the server.
const allValues = ref<IPropertyDistinctValues | null>(null);
const searchedValues = ref<IPropertyDistinctValues | null>(null);
const searchText = computed(() => (search.value ?? "").trim());
const loadingKind = ref({ all: false, search: false });
const loading = computed(
  () =>
    loadingKind.value.all || (!!searchText.value && loadingKind.value.search),
);
// Per list, like loading: a failed search must not outlive its search text,
// and must not hide a successfully loaded full list (or vice versa).
const failedKind = ref({ all: false, search: false });
const error = computed(() =>
  failedKind.value.all || (!!searchText.value && failedKind.value.search)
    ? "Could not load values"
    : "",
);

const selectedSet = computed(() => new Set(props.modelValue));
const searchesLocally = computed(
  () => allValues.value !== null && !allValues.value.truncated,
);

const shownEntries = computed(() => {
  const all = allValues.value?.values ?? [];
  const needle = searchText.value.toLowerCase();
  if (!needle) {
    return all;
  }
  if (searchesLocally.value) {
    return all.filter((entry) => entry.value.toLowerCase().includes(needle));
  }
  return searchedValues.value?.values ?? [];
});

const totalLabel = computed(() => {
  const values = allValues.value;
  if (!values) {
    return "";
  }
  return `${values.values.length}${values.truncated ? "+" : ""}`;
});

const truncatedHint = computed(() => {
  const current = searchText.value ? searchedValues.value : allValues.value;
  if (searchesLocally.value || !current?.truncated) {
    return "";
  }
  return `Showing the ${current.values.length} most common — type to narrow`;
});

// Sequence guards, one per list: a slow response for an earlier search (or
// the previous property) must not overwrite a newer one, but a search started
// while the full list is still loading must not discard that list either.
const requestSeq = { all: 0, search: 0 };

async function fetchValues(searchFor: string) {
  const datasetId = store.dataset?.id;
  if (!datasetId) {
    return;
  }
  const kind = searchFor ? "search" : "all";
  const seq = ++requestSeq[kind];
  const isCurrent = () => seq === requestSeq[kind];
  loadingKind.value[kind] = true;
  failedKind.value[kind] = false;
  try {
    const result = await propertyStore.propertiesAPI.getPropertyDistinctValues(
      datasetId,
      props.propertyPath,
      searchFor,
    );
    if (!isCurrent()) {
      return;
    }
    if (searchFor) {
      searchedValues.value = result;
    } else {
      allValues.value = result;
    }
  } catch (e) {
    if (isCurrent()) {
      failedKind.value[kind] = true;
    }
    logError("Failed to load property values", e);
  } finally {
    if (isCurrent()) {
      loadingKind.value[kind] = false;
    }
  }
}

const debouncedServerSearch = debounce(fetchValues, 300);

// Keyed on the dataset too: the Filters panel keys these rows by index, so
// after a dataset switch with the same configuration this component can be
// reused for an identical path whose values belong to the old dataset.
watch(
  () => `${store.dataset?.id}|${props.propertyPath.join(".")}`,
  () => {
    allValues.value = null;
    searchedValues.value = null;
    requestSeq.search++;
    loadingKind.value.search = false;
    debouncedServerSearch.cancel();
    void fetchValues("");
  },
  { immediate: true },
);

watch(searchText, (text) => {
  searchedValues.value = null;
  failedKind.value.search = false;
  requestSeq.search++;
  loadingKind.value.search = false;
  if (text && !searchesLocally.value) {
    debouncedServerSearch(text);
  } else {
    debouncedServerSearch.cancel();
  }
});

onBeforeUnmount(() => debouncedServerSearch.cancel());

function toggle(value: string) {
  emit(
    "update:modelValue",
    selectedSet.value.has(value)
      ? props.modelValue.filter((selected) => selected !== value)
      : [...props.modelValue, value],
  );
}

function selectShown() {
  const added = shownEntries.value
    .map((entry) => entry.value)
    .filter((value) => !selectedSet.value.has(value));
  emit("update:modelValue", [...props.modelValue, ...added]);
}

// Enter picks the exact match if there is one, else the top result, and
// clears the box so the next value can be typed straight away.
function toggleFirstShown() {
  const needle = searchText.value.toLowerCase();
  if (!needle) {
    return;
  }
  const entries = shownEntries.value;
  const entry =
    entries.find((candidate) => candidate.value.toLowerCase() === needle) ??
    entries[0];
  if (entry) {
    toggle(entry.value);
    search.value = "";
  }
}

defineExpose({
  search,
  allValues,
  shownEntries,
  error,
  toggle,
  selectShown,
  toggleFirstShown,
});
</script>

<style scoped lang="scss">
.property-category-filter {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pcf-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 96px;
  overflow-y: auto;
}

.pcf-summary {
  display: flex;
  align-items: center;
  font-size: 12px;
  opacity: 0.8;
}

.pcf-list {
  border: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.12));
  border-radius: 4px;
}

.pcf-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;

  &:hover {
    background: rgba(var(--v-theme-on-surface), 0.06);
  }
}

.pcf-row--selected .pcf-check {
  color: rgb(var(--v-theme-primary));
}

.pcf-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pcf-count {
  flex: 0 0 auto;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}

.pcf-hint {
  font-size: 12px;
  opacity: 0.7;
}

.pcf-error {
  color: rgb(var(--v-theme-error));
  opacity: 1;
}
</style>
