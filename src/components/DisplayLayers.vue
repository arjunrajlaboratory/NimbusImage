<template>
  <div
    id="layer-controls-tourstep"
    class="d-block mt-2"
    v-mousetrap="mousetrapGlobalToggles"
  >
    <v-expansion-panels class="layer-header-panels">
      <v-expansion-panel :disabled="true">
        <v-expansion-panel-title class="layer-header-title" hide-actions>
          <div class="layer-title-row" style="padding-right: 20px">
            <div class="layer-name-cell">
              <draggable
                v-model="dropZoneArray"
                group="layerZoneElement"
                class="ma-1 pa-1 drop"
                :class="{ dragging: isDragging, 'not-dragging': !isDragging }"
                :item-key="(el: any) => el.layer?.id || String(el)"
              >
                <template #item="{ element }">
                  <div>{{ element }}</div>
                </template>
                <template #footer>
                  <span>Drag layer here to create group</span>
                </template>
              </draggable>
            </div>
            <div
              class="text-caption header-col layer-switch-cell"
              title="hotkey Z"
              v-show="hasMultipleZ"
            >
              Z max-merge
            </div>
            <div
              class="text-caption header-col layer-switch-cell"
              title="hotkey 0"
            >
              Channel on/off
            </div>
          </div>
        </v-expansion-panel-title>
      </v-expansion-panel>
    </v-expansion-panels>
    <v-divider />
    <draggable
      v-model="groupsArrayWithSpacers"
      :animation="200"
      :fallbackOnBody="true"
      :swapThreshold="0.65"
      :item-key="(el: any) => el[0]"
    >
      <template #item="{ element }">
        <display-layer-group
          v-if="element[1]"
          group="layerZoneElement"
          :single-layer="element[0].startsWith(singleLayerPrefix)"
          :combined-layers="element[1]"
          @start="isDragging = true"
          @end="isDragging = false"
          @update="changeLayersInGroup($event, element[0])"
        />
        <draggable
          v-else
          :model-value="[]"
          @update:model-value="spacerUpdate($event, element[0])"
          group="layerZoneElement"
          class="group-spacer"
          :item-key="(el: any) => el.layer?.id || String(el)"
        >
          <template #item="{ element: spacerEl }">
            <div>{{ spacerEl }}</div>
          </template>
        </draggable>
      </template>
    </draggable>
  </div>
</template>
<script setup lang="ts">
import { ref, computed } from "vue";
import { IDisplayLayer, ICombinedLayer } from "@/store/model";
import { v4 as uuidv4 } from "uuid";
import DisplayLayerGroup from "./DisplayLayerGroup.vue";
import draggable from "vuedraggable";
import store from "@/store";
import { IHotkey } from "@/utils/v-mousetrap";

const singleLayerPrefix = "single-layer-group_";
const spacerPrefix = "spacer_";

function groupIdFromLayer(layer: IDisplayLayer) {
  return layer.layerGroup ?? singleLayerPrefix + layer.id;
}

function spacerIdBeforeGroup(groupIdAfterSpacerValue?: string) {
  return groupIdAfterSpacerValue
    ? spacerPrefix + groupIdAfterSpacerValue
    : spacerPrefix;
}

function groupIdAfterSpacer(spacerId: string) {
  if (spacerId === spacerPrefix) {
    return null;
  }
  return spacerId.slice(spacerPrefix.length);
}

const isDragging = ref(false);

const hasMultipleZ = computed(() => {
  return store.dataset && store.dataset.z.length > 1;
});

// Maps a layer groupId to a list of layers
const groupsMap = computed(() => {
  // A Map remembers order of insertion
  const groups: Map<string, ICombinedLayer[]> = new Map();
  if (!store.configuration) {
    return groups;
  }
  const configurationLayers = store.configuration.layers;
  const layers = store.layers;
  for (let layerIdx = 0; layerIdx < layers.length; ++layerIdx) {
    const layer = layers[layerIdx];
    const configurationLayer = configurationLayers[layerIdx];
    const groupId = groupIdFromLayer(layer);
    if (!groups.has(groupId)) {
      groups.set(groupId, []);
    }
    groups.get(groupId)!.push({ layer, configurationLayer });
  }
  return groups;
});

// A list of tuples [groupId | spacerId, layers | null]
const groupsArrayWithSpacers = computed({
  get() {
    const groupsArray = Array.from(groupsMap.value.entries());
    const withSpacers: [string, ICombinedLayer[] | null][] = [];
    groupsArray.forEach((e) =>
      withSpacers.push([spacerIdBeforeGroup(e[0]), null], e),
    );
    withSpacers.push([spacerIdBeforeGroup(), null]);
    return withSpacers;
  },
  // Changes the order of the groups
  set(value) {
    changeGroupsInWrapper(value);
  },
});

const dropZoneArray = computed({
  get() {
    return [] as ICombinedLayer[];
  },
  // Create a group from the layer dropped in the zone
  set(value: ICombinedLayer[]) {
    if (value.length <= 0) {
      return;
    }
    createGroupFromLayer(value[0]);
  },
});

// Change the order of the groups
function changeGroupsInWrapper(groups: [string, ICombinedLayer[] | null][]) {
  isDragging.value = false;
  // Groups have changed position
  const newConfigurationLayers = [];
  for (const [, combinedLayers] of groups) {
    if (combinedLayers) {
      for (const { configurationLayer } of combinedLayers) {
        newConfigurationLayers.push(configurationLayer);
      }
    }
  }
  store.setConfigurationLayers(newConfigurationLayers);
}

// The user dropped a layer in the spacer between two groups
function spacerUpdate(combinedLayers: ICombinedLayer[], spacerId: string) {
  isDragging.value = false;
  if (!store.configuration || combinedLayers.length !== 1) {
    return;
  }
  const configurationLayers = store.configuration.layers;
  const layerToMove = combinedLayers[0].layer;
  const groupId = groupIdAfterSpacer(spacerId);

  // Find current position of item to move
  const currentPosition = store.getLayerIndexFromId(layerToMove.id);
  if (currentPosition === null) {
    return;
  }

  // Find position of insertion
  let insertPosition = groupId
    ? configurationLayers.findIndex(
        (layer) => groupIdFromLayer(layer) === groupId,
      )
    : configurationLayers.length;
  if (insertPosition < 0) {
    return;
  }

  // Move the element
  if (
    currentPosition !== insertPosition &&
    currentPosition !== insertPosition - 1
  ) {
    const layer = configurationLayers[currentPosition];
    if (currentPosition < insertPosition) {
      for (let i = currentPosition; i < insertPosition - 1; i++) {
        configurationLayers[i] = configurationLayers[i + 1];
      }
      configurationLayers[insertPosition - 1] = layer;
    } else {
      for (let i = currentPosition; i > insertPosition; i--) {
        configurationLayers[i] = configurationLayers[i - 1];
      }
      configurationLayers[insertPosition] = layer;
    }
  }
  store.setConfigurationLayers(configurationLayers);
}

// The user moved a layer within a group
function changeLayersInGroup(
  combinedLayers: ICombinedLayer[],
  groupId: string,
) {
  isDragging.value = false;
  // Layers of this group have changed (layer added, removed or changed position)
  if (!store.configuration) {
    return;
  }
  const configurationLayers = store.configuration.layers;

  // Get the id of all layers in the group
  const layerIdsInGroup = new Set();
  for (const { configurationLayer } of combinedLayers) {
    layerIdsInGroup.add(configurationLayer.id);
  }

  const layerGroup = groupId.startsWith(singleLayerPrefix) ? null : groupId;

  // Create 3 groups of layers: before group, in group, after group
  // Also set the layerGroup attribute of each layer
  const layersBeforeGroup: IDisplayLayer[] = [];
  const layersAfterGroup: IDisplayLayer[] = [];
  const layersInGroup: Map<string, IDisplayLayer> = new Map();
  let isLayerBeforeGroup = true;
  for (const currentLayer of configurationLayers) {
    const currentGroupId = groupIdFromLayer(currentLayer);
    const wasInGroup = currentGroupId === groupId;
    const isInGroup = layerIdsInGroup.has(currentLayer.id);
    if (wasInGroup && !isInGroup) {
      // Removed from the group
      currentLayer.layerGroup = null;
    } else if (!wasInGroup && isInGroup) {
      // Added to the group
      currentLayer.layerGroup = layerGroup;
    }
    if (isInGroup) {
      layersInGroup.set(currentLayer.id, currentLayer);
    } else {
      if (isLayerBeforeGroup) {
        layersBeforeGroup.push(currentLayer);
      } else {
        layersAfterGroup.push(currentLayer);
      }
    }
    if (wasInGroup) {
      isLayerBeforeGroup = false;
    }
  }

  // Sort layers in group as in combinedLayers parameter
  const orderedLayersInGroup = [];
  for (const { configurationLayer } of combinedLayers) {
    const layerId = configurationLayer.id;
    const newLayer = layersInGroup.get(layerId);
    if (newLayer) {
      orderedLayersInGroup.push(newLayer);
    }
  }

  // Set the new configuration layers
  store.setConfigurationLayers([
    ...layersBeforeGroup,
    ...orderedLayersInGroup,
    ...layersAfterGroup,
  ]);
}

function createGroupFromLayer(combinedLayer: ICombinedLayer) {
  const newGroupId = uuidv4();
  store.changeLayer({
    layerId: combinedLayer.layer.id,
    delta: {
      layerGroup: newGroupId,
    },
  });
}

// Mousetrap bindings
const mousetrapGlobalToggles: IHotkey[] = [
  {
    bind: "z",
    handler: store.toggleGlobalZMaxMerge,
    data: {
      section: "Layer control",
      description: "Toggle Z max-merge for all layers",
    },
  },
  {
    bind: "0",
    handler: store.toggleGlobalLayerVisibility,
    data: {
      section: "Layer control",
      description: "Show/hide all layers",
    },
  },
];

defineExpose({
  isDragging,
  hasMultipleZ,
  groupsMap,
  groupsArrayWithSpacers,
  dropZoneArray,
  changeGroupsInWrapper,
  spacerUpdate,
  changeLayersInGroup,
  createGroupFromLayer,
  mousetrapGlobalToggles,
  singleLayerPrefix,
});
</script>

<style lang="scss" scoped>
.layer-title-row {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
}

.layer-name-cell {
  flex: 1 1 0;
  min-width: 0;
}

.layer-switch-cell {
  flex: 0 0 auto;
}

.header-col {
  display: flex;
  justify-content: center;
  align-items: center;
  text-align: center;
  padding: 0 4px;
  max-width: 60px;
}

/* Header uses a real expansion panel title for pixel-perfect alignment
   with layer rows, but is non-interactive */
.layer-header-panels {
  pointer-events: none;
}

.layer-header-panels
  :deep(.v-expansion-panel--disabled .v-expansion-panel-title) {
  color: rgb(var(--v-theme-on-surface)) !important;
}

.layer-header-panels
  :deep(.v-expansion-panel--disabled .v-expansion-panel-title__overlay) {
  opacity: 0 !important;
}

.layer-header-title {
  min-height: 32px !important;
  cursor: default !important;
  font-size: 0.75rem !important;
}

.drop {
  border: dashed;
  text-align: center;
  pointer-events: auto;
}

.dragging {
  opacity: 0.5;
}

.not-dragging {
  opacity: 0;
}

.group-spacer {
  padding-bottom: 10px;
  margin-bottom: -10px;
}
</style>
