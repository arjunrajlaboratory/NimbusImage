<template>
  <div :class="{ background: !singleLayer }">
    <div v-if="!singleLayer" class="group-header pl-4 py-1">
      <div class="group-name-cell">
        <div class="subtitle-1">Group</div>
      </div>
      <div class="group-switch-cell" v-show="hasMultipleZ">
        <v-switch
          @click.stop
          @mousedown.stop
          @mouseup.stop
          class="toggleButton"
          v-model="isZMaxMerge"
          :title="`Toggle Z Max Merge for all layers`"
          density="compact"
          hide-details
        />
      </div>
      <div class="group-switch-cell">
        <v-switch
          @click.stop
          @mousedown.stop
          @mouseup.stop
          class="toggleButton"
          v-model="visible"
          :title="`Toggle Visibility for all layers`"
          density="compact"
          hide-details
        />
      </div>
    </div>
    <draggable
      v-bind="$attrs"
      :model-value="combinedLayers"
      :class="{ 'draggable-group': !singleLayer }"
      :animation="200"
      :fallbackOnBody="true"
      :swapThreshold="0.65"
      @start="startDragging"
      @end="endDragging"
      @update:model-value="update"
      :item-key="(el: any) => el.layer.id"
    >
      <template #item="{ element: combinedLayer }">
        <v-card class="mb-1 mx-1">
          <display-layer :model-value="combinedLayer.layer" />
        </v-card>
      </template>
    </draggable>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ICombinedLayer, IDisplaySlice } from "@/store/model";
import { SortableEvent } from "sortablejs";
import DisplayLayer from "./DisplayLayer.vue";
import draggable from "vuedraggable";
import store from "@/store";

const props = defineProps<{
  singleLayer: boolean;
  combinedLayers: ICombinedLayer[];
}>();

const emit = defineEmits<{
  (e: "update", value: ICombinedLayer[]): void;
  (e: "start", event: SortableEvent): void;
  (e: "end", event: SortableEvent): void;
}>();

const hasMultipleZ = computed(
  () => store.dataset && store.dataset.z.length > 1,
);

// Aggregate the group's state from the layer data rather than from child
// component instances — a string ref inside the draggable slot can't be
// collected into an array, which breaks .every/.forEach.
const isZMaxMerge = computed({
  get: () =>
    props.combinedLayers.length > 0 &&
    props.combinedLayers.every(({ layer }) => layer.z.type === "max-merge"),
  set: (value: boolean) => {
    const newZSlice: IDisplaySlice = value
      ? { type: "max-merge", value: null }
      : { type: "current", value: null };
    for (const { layer } of props.combinedLayers) {
      if ((layer.z.type === "max-merge") === value) {
        continue;
      }
      store.changeLayer({ layerId: layer.id, delta: { z: newZSlice } });
    }
  },
});

const visible = computed({
  get: () =>
    props.combinedLayers.length > 0 &&
    props.combinedLayers.every(({ layer }) => layer.visible),
  set: (value: boolean) => {
    for (const { layer } of props.combinedLayers) {
      if (layer.visible !== value) {
        store.toggleLayerVisibility(layer.id);
      }
    }
  },
});

function update(value: ICombinedLayer[]) {
  emit("update", value);
}

function startDragging(e: SortableEvent) {
  emit("start", e);
}

function endDragging(e: SortableEvent) {
  emit("end", e);
}

defineExpose({ hasMultipleZ, update, startDragging, endDragging });
</script>

<style lang="scss" scoped>
.draggable-group {
  margin-left: 6px;
}

.background {
  border-radius: 14px;
  border: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}

/* Mirror the per-layer row layout (DisplayLayer .layer-title-row) so the
   group's aggregate switches line up with the per-layer switch columns. The
   padding-right matches the expansion chevron that each layer row carries. */
.group-header {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  gap: 8px;
  /* The group header has no per-row expansion chevron, so reserve its
     footprint (~chevron width + the row's right padding) here so the group's
     aggregate switches line up with the per-layer switch columns. */
  padding-right: 53px;
}

.group-name-cell {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
}

.group-switch-cell {
  display: flex;
  justify-content: center;
  flex: 0 0 auto;
  padding: 0 4px;
}
</style>
