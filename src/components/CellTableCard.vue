<template>
  <v-card variant="tonal" class="cell-table-card pa-2 mt-3">
    <div class="text-caption text-medium-emphasis">Cell table</div>
    <template v-if="!spatialStore.hasTable">
      <div class="text-body-2">
        No expression table yet. Recompute one from the cell polygons and the
        transcripts.
      </div>
    </template>
    <template v-else>
      <v-select
        :model-value="activeItemId"
        :items="versionItems"
        item-title="title"
        item-value="value"
        density="compact"
        variant="outlined"
        hide-details
        :loading="switching"
        class="my-2"
        @update:model-value="activate"
      />
      <div class="text-caption status">{{ stalenessText }}</div>
    </template>
    <div class="d-flex align-center mt-2">
      <recompute-table-dialog
        :staleness="staleness"
        @recomputed="onRecomputed"
      />
      <v-spacer />
      <v-btn
        v-if="spatialStore.hasTable"
        icon="mdi-refresh"
        size="x-small"
        variant="text"
        aria-label="Check for edits"
        :loading="checking"
        @click="refresh(true)"
      />
    </div>
    <div v-if="error" class="text-caption text-error mt-1">{{ error }}</div>
  </v-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import store from "@/store";
import spatialStore from "@/store/spatial";
import propertyStore from "@/store/properties";
import { ISpatialStaleness, ISpatialVersions } from "@/store/model";
import { logError } from "@/utils/log";
import { extractErrorMessage } from "@/utils/errors";
import RecomputeTableDialog from "@/components/RecomputeTableDialog.vue";

/**
 * The expression table's versions and staleness (plan §13). Lives in the
 * Transcripts palette because recomputing needs the transcript store.
 * Switching the active table re-reads the registration and the live gene
 * columns, since every `["spatial", gene]` value now comes from another file.
 */

const props = defineProps<{ visible: boolean }>();

const versions = ref<ISpatialVersions | null>(null);
const staleness = ref<ISpatialStaleness | null>(null);
const checking = ref(false);
const switching = ref(false);
const error = ref<string | null>(null);
let refreshToken = 0;

const activeItemId = computed(() => versions.value?.active.itemId ?? null);

const versionItems = computed(() => {
  if (!versions.value) {
    return [];
  }
  const describe = (v: ISpatialVersions["active"]) => ({
    value: v.itemId,
    title: `${v.label} — ${v.nObs.toLocaleString()} cells × ${v.nVar.toLocaleString()} genes`,
  });
  return [
    describe(versions.value.active),
    ...versions.value.versions.map(describe),
  ];
});

const stalenessText = computed(() => {
  const s = staleness.value;
  if (!s) {
    return checking.value ? "Checking for edits…" : "";
  }
  if (s.upToDate) {
    return "Up to date with the cell polygons.";
  }
  const parts = [];
  if (s.added) parts.push(`${s.added.toLocaleString()} cells added`);
  if (s.changed) parts.push(`${s.changed.toLocaleString()} edited`);
  if (s.removed) parts.push(`${s.removed.toLocaleString()} removed`);
  const note = s.hasGeometryHashes
    ? ""
    : " (an imported table cannot tell edited cells; recompute once to start tracking)";
  return `${parts.join(", ")} since this table was built.${note}`;
});

async function refresh(force = false) {
  const datasetId = store.dataset?.id;
  if (!datasetId || !spatialStore.hasTable) {
    versions.value = null;
    staleness.value = null;
    return;
  }
  if (!force && versions.value && staleness.value) {
    return;
  }
  const token = ++refreshToken;
  checking.value = true;
  error.value = null;
  try {
    // Versions are instant; staleness scans the polygons (seconds on 700K
    // cells), so the select fills in first.
    const nextVersions = await store.spatialAPI.fetchVersions(datasetId);
    if (token === refreshToken) {
      versions.value = nextVersions;
    }
    const nextStaleness = await store.spatialAPI.fetchStaleness(datasetId);
    if (token === refreshToken) {
      staleness.value = nextStaleness;
    }
  } catch (caught) {
    logError("Failed to read table versions:", caught);
    if (token === refreshToken) {
      error.value = extractErrorMessage(caught);
    }
  } finally {
    if (token === refreshToken) {
      checking.value = false;
    }
  }
}

async function activate(itemId: string) {
  const datasetId = store.dataset?.id;
  if (!datasetId || itemId === activeItemId.value) {
    return;
  }
  switching.value = true;
  error.value = null;
  try {
    versions.value = await store.spatialAPI.activateVersion(datasetId, itemId);
    await afterTableChange();
  } catch (caught) {
    logError("Failed to switch the table version:", caught);
    error.value = extractErrorMessage(caught);
  } finally {
    switching.value = false;
  }
}

/** The active table is a different file now: re-read the registration, the
 * staleness and every live gene column. */
async function afterTableChange() {
  staleness.value = null;
  await propertyStore.refreshVirtualPropertyValues();
  await spatialStore.refreshInfo();
  await refresh(true);
}

async function onRecomputed() {
  await afterTableChange();
}

watch(
  () => [props.visible, spatialStore.hasTable, store.dataset?.id],
  ([visible]) => {
    if (visible) {
      refresh(true);
    }
  },
  { immediate: true },
);

defineExpose({ refresh, activate, stalenessText, versionItems, onRecomputed });
</script>

<style lang="scss" scoped>
.status {
  min-height: 1.5em;
}
</style>
