<template>
  <v-expansion-panels
    id="layer-controls-tourstep"
    class="d-block mt-2"
    multiple
    accordion
    v-mousetrap="mousetrapGlobalToggles"
  >
    <v-expansion-panel>
      <div class="pr-8">
        <v-row dense>
          <v-col cols="7">
            <draggable
              v-model="dropZoneArray"
              group="layerZoneElement"
              class="ma-1 pa-1 drop"
              :class="{ dragging: isDragging, 'not-dragging': !isDragging }"
            >
              Drag layer here to create group
            </draggable>
          </v-col>
          <v-col
            class="text-caption header-col"
            title="hotkey Z"
            v-show="hasMultipleZ"
          >
            Z max-merge
          </v-col>
          <v-col class="text-caption header-col" title="hotkey 0">
            Channel on/off
          </v-col>
        </v-row>
      </div>
    </v-expansion-panel>
    <v-divider />
    <draggable
      v-model="groupsArrayWithSpacers"
      :animation="200"
      :fallbackOnBody="true"
      :swapThreshold="0.65"
    >
      <transition-group type="transition">
        <template v-for="[groupId, combinedLayers] in groupsArrayWithSpacers">
          <display-layer-group
            v-if="combinedLayers"
            :key="groupId + '_layers'"
            group="layerZoneElement"
            :single-layer="groupId.startsWith(singleLayerPrefix)"
            :combined-layers="combinedLayers"
            @start="isDragging = true"
            @end="isDragging = false"
            @update="changeLayersInGroup($event, groupId)"
          />
          <draggable
            v-else
            :value="[]"
            :key="groupId + '_spacer'"
            @input="spacerUpdate($event, groupId)"
            group="layerZoneElement"
            class="group-spacer"
          />
        </template>
      </transition-group>
    </draggable>
    <v-expansion-panel readonly class="add-layer">
      <v-btn @click="addLayer" icon title="Add new layer">
        <v-icon>mdi-plus-circle</v-icon>
      </v-btn>
    </v-expansion-panel>
  </v-expansion-panels>
</template>
<script lang="ts">
import { IDisplayLayer, ICombinedLayer } from "@/store/model";
import { v4 as uuidv4 } from "uuid";
import { Vue, Component } from "vue-property-decorator";
import DisplayLayerGroup from "./DisplayLayerGroup.vue";
import draggable from "vuedraggable";
import store from "@/store";
import { IHotkey } from "@/utils/v-mousetrap";

const singleLayerPrefix = "single-layer-group_";
const spacerPrefix = "spacer_";

function groupIdFromLayer(layer: IDisplayLayer) {
  return layer.layerGroup ?? singleLayerPrefix + layer.id;
}

function spacerIdBeforeGroup(groupIdAfterSpacer?: string) {
  return groupIdAfterSpacer ? spacerPrefix + groupIdAfterSpacer : spacerPrefix;
}

function groupIdAfterSpacer(spacerId: string) {
  if (spacerId === spacerPrefix) {
    return null;
  }
  return spacerId.slice(spacerPrefix.length);
}

@Component({
  components: {
    DisplayLayerGroup,
    draggable,
  },
})
export default class DisplayLayers extends Vue {
  readonly store = store;
  readonly singleLayerPrefix = singleLayerPrefix;

  isDragging: boolean = false;

  get hasMultipleZ() {
    return this.store.dataset && this.store.dataset.z.length > 1;
  }

  // Maps a layer groupId to a list of layers
  get groupsMap() {
    // A Map remembers order of insertion
    const groups: Map<string, ICombinedLayer[]> = new Map();
    if (!this.store.configuration) {
      return groups;
    }
    const configurationLayers = this.store.configuration.layers;
    const layers = this.store.layers;
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
  }

  // A list of tuples [groupId | spacerId, layers | null]
  get groupsArrayWithSpacers() {
    const groupsArray = Array.from(this.groupsMap.entries());
    const withSpacers: [string, ICombinedLayer[] | null][] = [];
    groupsArray.forEach((e) =>
      withSpacers.push([spacerIdBeforeGroup(e[0]), null], e),
    );
    withSpacers.push([spacerIdBeforeGroup(), null]);
    return withSpacers;
  }

  // Changes the order of the groups
  set groupsArrayWithSpacers(value) {
    this.changeGroupsInWrapper(value);
  }

  get dropZoneArray() {
    return [];
  }

  // Create a group from the layer dropped in the zone
  set dropZoneArray(value: ICombinedLayer[]) {
    if (value.length <= 0) {
      return;
    }
    this.createGroupFromLayer(value[0]);
  }

  // Change the order of the groups
  changeGroupsInWrapper(groups: [string, ICombinedLayer[] | null][]) {
    this.isDragging = false;
    // Groups have changed position
    const newConfigurationLayers = [];
    for (const [, combinedLayers] of groups) {
      if (combinedLayers) {
        for (const { configurationLayer } of combinedLayers) {
          newConfigurationLayers.push(configurationLayer);
        }
      }
    }
    this.store.setConfigurationLayers(newConfigurationLayers);
  }

  // The user dropped a layer in the spacer between two groups
  spacerUpdate(combinedLayers: ICombinedLayer[], spacerId: string) {
    this.isDragging = false;
    if (!this.store.configuration || combinedLayers.length !== 1) {
      return;
    }
    const configurationLayers = this.store.configuration.layers;
    const layerToMove = combinedLayers[0].layer;
    const groupId = groupIdAfterSpacer(spacerId);

    // Find current position of item to move
    const currentPosition = this.store.getLayerIndexFromId(layerToMove.id);
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
    this.store.setConfigurationLayers(configurationLayers);
  }

  // The user moved a layer within a group
  changeLayersInGroup(combinedLayers: ICombinedLayer[], groupId: string) {
    this.isDragging = false;
    // Layers of this group have changed (layer added, removed or changed position)
    if (!this.store.configuration) {
      return;
    }
    const configurationLayers = this.store.configuration.layers;

    // Get the id of all layers in the group
    const layerIdsInGroup = new Set();
    for (const { configurationLayer } of combinedLayers) {
      layerIdsInGroup.add(configurationLayer.id);
    }

    const layerGroup = groupId.startsWith(this.singleLayerPrefix)
      ? null
      : groupId;

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
    this.store.setConfigurationLayers([
      ...layersBeforeGroup,
      ...orderedLayersInGroup,
      ...layersAfterGroup,
    ]);
  }

  createGroupFromLayer(combinedLayer: ICombinedLayer) {
    const newGroupId = uuidv4();
    this.store.changeLayer({
      layerId: combinedLayer.layer.id,
      delta: {
        layerGroup: newGroupId,
      },
    });
  }

  addLayer() {
    this.store.addLayer();
  }

  // Mousetrap bindings
  mousetrapGlobalToggles: IHotkey[] = [
    {
      bind: "z",
      handler: this.store.toggleGlobalZMaxMerge,
      data: {
        section: "Layer control",
        description: "Toggle Z max-merge for all layers",
      },
    },
    {
      bind: "0",
      handler: this.store.toggleGlobalLayerVisibility,
      data: {
        section: "Layer control",
        description: "Show/hide all layers",
      },
    },
  ];
}
</script>

<style lang="scss" scoped>
.add-layer {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.header-col {
  display: flex;
  justify-content: center;
  align-items: center;
  text-align: center;
}

.drop {
  border: dashed;
  text-align: center;
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
