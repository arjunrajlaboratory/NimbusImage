<template>
  <div :class="{ background: !singleLayer }">
    <v-row dense v-if="!singleLayer" class="pl-4 py-1 pr-8">
      <v-col class="textCol">
        <div class="subtitle-1">Group</div>
      </v-col>
      <v-col class="denseCol">
        <v-switch
          @click.native.stop
          @mousedown.native.stop
          @mouseup.native.stop
          class="toggleButton"
          v-model="isZMaxMerge"
          :title="`Toggle Z Max Merge for all layers`"
          v-show="hasMultipleZ"
          dense
          hide-details
        />
      </v-col>
      <v-col class="denseCol">
        <v-switch
          @click.native.stop
          @mousedown.native.stop
          @mouseup.native.stop
          class="toggleButton"
          v-model="visible"
          :title="`Toggle Visibility for all layers`"
          dense
          hide-details
        />
      </v-col>
    </v-row>
    <draggable
      v-bind="$attrs"
      :value="combinedLayers"
      :class="{ 'draggable-group': !singleLayer }"
      :animation="200"
      :fallbackOnBody="true"
      :swapThreshold="0.65"
      @start="startDragging"
      @end="endDragging"
      @input="update"
    >
      <transition-group type="transition">
        <v-card
          v-for="combinedLayer in combinedLayers"
          :key="combinedLayer.layer.id"
          class="mb-1 mx-1"
        >
          <display-layer ref="displayLayerRefs" :value="combinedLayer.layer" />
        </v-card>
      </transition-group>
    </draggable>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { ICombinedLayer } from "@/store/model";
import { SortableEvent } from "sortablejs";
import DisplayLayer from "./DisplayLayer.vue";
import draggable from "vuedraggable";
import store from "@/store";

defineProps<{
  singleLayer: boolean;
  combinedLayers: ICombinedLayer[];
}>();

const emit = defineEmits<{
  (e: "update", value: ICombinedLayer[]): void;
  (e: "start", event: SortableEvent): void;
  (e: "end", event: SortableEvent): void;
}>();

const displayLayerRefs = ref<InstanceType<typeof DisplayLayer>[]>([]);

onMounted(() => {
  // displayLayerRefs is populated automatically via template ref
});

const hasMultipleZ = computed(
  () => store.dataset && store.dataset.z.length > 1,
);

const isZMaxMerge = computed({
  get: () =>
    displayLayerRefs.value?.every((displayLayer) => displayLayer.isZMaxMerge) ??
    false,
  set: (value: boolean) => {
    displayLayerRefs.value?.forEach(
      (displayLayer) => (displayLayer.isZMaxMerge = value),
    );
  },
});

const visible = computed({
  get: () =>
    displayLayerRefs.value?.every((displayLayer) => displayLayer.visible) ??
    false,
  set: (value: boolean) => {
    displayLayerRefs.value?.forEach(
      (displayLayer) => (displayLayer.visible = value),
    );
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
  background-color: grey;
}
</style>

<style>
.denseCol {
  flex-grow: 0;
  font-size: 0.8em;
}

.textCol {
  overflow: hidden;
}
</style>
