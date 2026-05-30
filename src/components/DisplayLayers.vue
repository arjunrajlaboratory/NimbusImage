<template>
  <div
    :data-tour="TOUR_ANCHORS.layerControls"
    class="d-block"
    v-mousetrap="mousetrapGlobalToggles"
  >
    <div class="layer-title-row layer-header-row">
      <div class="layer-name-cell">
        <v-menu v-model="groupMenuOpen" :close-on-content-click="false">
          <template v-slot:activator="{ props: menuProps }">
            <v-btn
              v-bind="menuProps"
              variant="text"
              size="x-small"
              color="primary"
              prepend-icon="mdi-group"
              class="make-group-btn"
              :disabled="ungroupedLayers.length < 1"
            >
              Make layer group…
            </v-btn>
          </template>
          <v-card min-width="220">
            <v-list density="compact" class="py-1">
              <v-list-subheader>Group these layers</v-list-subheader>
              <v-list-item
                v-for="layer in ungroupedLayers"
                :key="layer.id"
                @click="toggleGroupSelection(layer.id)"
              >
                <template v-slot:prepend>
                  <v-icon size="18" class="mr-1">
                    {{
                      groupSelection.includes(layer.id)
                        ? "mdi-checkbox-marked"
                        : "mdi-checkbox-blank-outline"
                    }}
                  </v-icon>
                  <v-icon :color="layer.color" size="12" class="mr-2">
                    mdi-circle
                  </v-icon>
                </template>
                <v-list-item-title>{{ layer.name }}</v-list-item-title>
              </v-list-item>
              <v-list-item v-if="ungroupedLayers.length === 0">
                <v-list-item-title class="text-medium-emphasis">
                  No ungrouped layers
                </v-list-item-title>
              </v-list-item>
            </v-list>
            <v-divider />
            <div class="d-flex align-center pa-2">
              <v-spacer />
              <v-btn
                size="small"
                variant="flat"
                color="primary"
                :disabled="groupSelection.length < 1"
                @click="createGroupFromSelection"
              >
                Create group
              </v-btn>
            </div>
          </v-card>
        </v-menu>
      </div>
      <div
        class="text-caption header-col layer-switch-cell"
        title="hotkey Z"
        v-show="hasMultipleZ"
      >
        Z max-merge
      </div>
      <div class="text-caption header-col layer-switch-cell" title="hotkey 0">
        Channel on/off
      </div>
    </div>
    <v-divider />
    <draggable
      v-model="groupsArrayWithSpacers"
      :animation="200"
      :fallbackOnBody="true"
      :swapThreshold="0.65"
      :item-key="(el: any) => el[0]"
      @start="isDragging = true"
      @end="isDragging = false"
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
import { ref, computed, watch } from "vue";
import { IDisplayLayer, ICombinedLayer } from "@/store/model";
import DisplayLayerGroup from "./DisplayLayerGroup.vue";
import draggable from "vuedraggable";
import store from "@/store";
import { TOUR_ANCHORS } from "@/tours/anchors";
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

// Mirror drag state to the store so palette layout (which observes this
// palette's height) can pause its reactive updates while a drag is in
// progress — a mid-drag re-render corrupts vuedraggable's vnode tree.
watch(isDragging, (dragging) => store.setIsLayerDragging(dragging));

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

// "Make layer group…" dropdown: pick one or more ungrouped layers to form a new
// group. Dragging layers in/out of an existing group still works too.
const ungroupedLayers = computed(() =>
  store.layers.filter((layer) => !layer.layerGroup),
);
const groupMenuOpen = ref(false);
const groupSelection = ref<string[]>([]);

function toggleGroupSelection(layerId: string) {
  const index = groupSelection.value.indexOf(layerId);
  if (index >= 0) {
    groupSelection.value.splice(index, 1);
  } else {
    groupSelection.value.push(layerId);
  }
}

async function createGroupFromSelection() {
  await store.groupLayers([...groupSelection.value]);
  groupSelection.value = [];
  groupMenuOpen.value = false;
}

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
  ungroupedLayers,
  groupMenuOpen,
  groupSelection,
  toggleGroupSelection,
  createGroupFromSelection,
  changeGroupsInWrapper,
  spacerUpdate,
  changeLayersInGroup,
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
  font-size: 11px;
  line-height: 1.15;
  color: var(--nimbus-text-muted, #8a8f98);
}

/* Column-label row (Z max-merge / Channel on/off) plus the "Make layer group…"
   trigger. The padding-right reserves the per-layer expansion chevron's
   footprint so the labels line up over the switch columns. */
.layer-header-row {
  padding-right: 33px;
  min-height: 26px;
}

.make-group-btn {
  text-transform: none;
  letter-spacing: normal;
  padding-inline: 4px;
}

.group-spacer {
  padding-bottom: 10px;
  margin-bottom: -10px;
}
</style>
