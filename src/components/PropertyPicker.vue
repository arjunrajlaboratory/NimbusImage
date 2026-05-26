<template>
  <v-dialog v-model="dialogOpen" max-width="1280px" width="92%">
    <template v-slot:activator="activatorBinding">
      <slot name="activator" v-bind="activatorBinding" />
    </template>
    <v-card class="property-picker-card">
      <v-card-title class="d-flex align-center">
        <span>{{ title }}</span>
        <v-chip
          v-if="selectedPaths.length > 0"
          size="x-small"
          variant="flat"
          color="primary"
          class="ml-3"
        >
          {{ selectedPaths.length }} selected
        </v-chip>
        <v-spacer />
        <v-btn-toggle
          v-model="viewMode"
          mandatory
          density="compact"
          variant="outlined"
          color="primary"
          class="view-toggle mr-2"
        >
          <v-btn value="tree" size="x-small" title="Tree view">
            <v-icon size="16">mdi-file-tree-outline</v-icon>
          </v-btn>
          <v-btn value="miller" size="x-small" title="Miller column view">
            <v-icon size="16">mdi-view-column-outline</v-icon>
          </v-btn>
        </v-btn-toggle>
        <v-btn
          variant="text"
          size="small"
          icon
          aria-label="Close"
          @click="dialogOpen = false"
        >
          <v-icon>mdi-close</v-icon>
        </v-btn>
      </v-card-title>

      <v-card-text>
        <v-text-field
          v-model="searchText"
          placeholder="Search properties"
          prepend-inner-icon="mdi-magnify"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          single-line
          class="mb-3"
        />
        <div v-if="hasNoProperties" class="empty-state pa-4">
          No properties have been computed yet. Click the Analyze icon in the
          app bar to set up and compute measurements.
        </div>
        <div v-else class="picker-body">
          <div class="picker-available">
            <h4 class="picker-section-title">Available</h4>
            <div v-if="tree.length === 0" class="empty-state pa-3">
              No matches.
            </div>
            <template v-else>
              <div v-if="viewMode === 'tree'" class="picker-tree">
                <property-tree-node
                  v-for="node in tree"
                  :key="node.path.join('.')"
                  :node="node"
                  :isPathSelected="isPathSelected"
                  :defaultExpanded="hasSearch"
                  @toggle="togglePath"
                />
              </div>
              <div v-else class="miller-columns-container">
                <div
                  v-for="(column, colIndex) in millerColumns"
                  :key="colIndex"
                  class="miller-column"
                  :class="{ dark: $vuetify.theme.current.dark }"
                >
                  <v-list density="compact">
                    <v-list-item
                      v-for="item in column"
                      :key="item.path.join('.')"
                      @click="millerSelectedPath = item.path"
                      :class="{ 'v-list-item--active': item.isSelected }"
                    >
                      <v-list-item-title>{{ item.name }}</v-list-item-title>
                      <template #append>
                        <v-checkbox
                          v-if="item.isLeaf"
                          :model-value="isPathSelected(item.path)"
                          @update:model-value="togglePath(item.path)"
                          @click.stop
                          hide-details
                          density="compact"
                        />
                        <v-icon v-else size="small">mdi-chevron-right</v-icon>
                      </template>
                    </v-list-item>
                  </v-list>
                </div>
              </div>
            </template>
          </div>
          <div class="picker-selected">
            <h4 class="picker-section-title">Selected</h4>
            <div v-if="selectedPaths.length === 0" class="empty-state pa-3">
              Nothing selected yet.
            </div>
            <ul v-else class="selected-list">
              <li
                v-for="path in selectedPaths"
                :key="path.join('.')"
                class="selected-item"
              >
                <span class="selected-label">{{ fullName(path) }}</span>
                <v-btn
                  variant="text"
                  size="x-small"
                  density="compact"
                  icon
                  class="selected-remove"
                  :title="`Remove ${fullName(path)}`"
                  @click="togglePath(path)"
                >
                  <v-icon size="14">mdi-close</v-icon>
                </v-btn>
              </li>
            </ul>
          </div>
        </div>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn variant="flat" color="primary" size="small" @click="onDone">
          Done
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import { findIndexOfPath } from "@/utils/paths";
import PropertyTreeNode, {
  IPropertyTreeNode,
} from "@/components/PropertyTreeNode.vue";

type TMode = "display" | "filter";
type TViewMode = "tree" | "miller";

interface IMillerItem {
  name: string;
  path: string[];
  isLeaf: boolean;
  isSelected: boolean;
}

const props = withDefaults(
  defineProps<{
    mode?: TMode;
  }>(),
  { mode: "display" },
);

const emit = defineEmits<{ (e: "done"): void }>();

const dialogOpen = ref(false);
const searchText = ref<string | null>(null);
const viewMode = ref<TViewMode>("tree");
const millerSelectedPath = ref<string[]>([]);

const hasSearch = computed(() => !!searchText.value);

const title = computed(() =>
  props.mode === "display"
    ? "Add properties to the list"
    : "Filter by properties",
);

const allPaths = computed(() => propertyStore.computedPropertyPaths);
const hasNoProperties = computed(() => allPaths.value.length === 0);

const selectedPaths = computed(() =>
  props.mode === "display"
    ? propertyStore.displayedPropertyPaths
    : filterStore.filterPaths,
);

function fullName(path: string[]): string {
  return propertyStore.getFullNameFromPath(path) ?? path.join(" / ");
}

function labelForSegment(path: string[]): string {
  if (path.length === 1) {
    return propertyStore.getPropertyById(path[0])?.name ?? path[0];
  }
  return path[path.length - 1];
}

function isPathSelected(path: string[]): boolean {
  return findIndexOfPath(path, selectedPaths.value) >= 0;
}

function togglePath(path: string[]) {
  if (props.mode === "display") {
    propertyStore.togglePropertyPathVisibility(path);
  } else {
    filterStore.togglePropertyPathFiltering(path);
  }
}

const filteredPaths = computed(() => {
  const query = searchText.value?.toLowerCase();
  if (!query) return allPaths.value;
  return allPaths.value.filter((path) => {
    const name = propertyStore.getFullNameFromPath(path)?.toLowerCase();
    return name ? name.includes(query) : false;
  });
});

const millerColumns = computed((): IMillerItem[][] => {
  let remainingPaths = filteredPaths.value;
  const cols: IMillerItem[][] = [];
  for (
    let columnIdx = 0;
    columnIdx < millerSelectedPath.value.length + 1;
    ++columnIdx
  ) {
    const currentSelectedPath = millerSelectedPath.value.slice(0, columnIdx);
    remainingPaths = remainingPaths.filter((path) =>
      currentSelectedPath.every((segment, idx) => segment === path[idx]),
    );
    const segmentItems: Map<string, IMillerItem> = new Map();
    remainingPaths.forEach((path) => {
      const segment = path[columnIdx];
      if (!segment || segmentItems.has(segment)) return;
      const partial = path.slice(0, columnIdx + 1);
      segmentItems.set(segment, {
        name: labelForSegment(partial),
        path: partial,
        isLeaf: path.length === columnIdx + 1,
        isSelected: segment === millerSelectedPath.value[columnIdx],
      });
    });
    if (segmentItems.size <= 0) break;
    cols.push([...segmentItems.values()]);
  }
  return cols;
});

const tree = computed((): IPropertyTreeNode[] => {
  // Build a nested tree from the (possibly filtered) flat list of paths.
  // A node is a leaf iff some input path ends at exactly that node — a
  // node can have children as well (rare, but supported).
  const roots: IPropertyTreeNode[] = [];
  for (const path of filteredPaths.value) {
    let currentLevel = roots;
    for (let i = 0; i < path.length; i++) {
      const segment = path[i];
      const partialPath = path.slice(0, i + 1);
      const isTerminal = i === path.length - 1;
      let node = currentLevel.find(
        (n) => n.path[n.path.length - 1] === segment,
      );
      if (!node) {
        node = {
          label: labelForSegment(partialPath),
          path: partialPath,
          isLeaf: isTerminal,
          children: [],
        };
        currentLevel.push(node);
      } else if (isTerminal) {
        // Path ends here too — mark this existing node as a leaf.
        node.isLeaf = true;
      }
      currentLevel = node.children;
    }
  }
  return roots;
});

function onDone() {
  dialogOpen.value = false;
  emit("done");
}

function open() {
  dialogOpen.value = true;
}

defineExpose({
  dialogOpen,
  searchText,
  viewMode,
  selectedPaths,
  tree,
  millerColumns,
  millerSelectedPath,
  isPathSelected,
  togglePath,
  fullName,
  onDone,
  open,
});
</script>

<style lang="scss" scoped>
.property-picker-card {
  background: rgba(20, 22, 28, 0.92);
}

.empty-state {
  text-align: center;
  color: var(--nimbus-text-muted, #8a8f98);
  font-size: 13px;
}

.picker-body {
  display: flex;
  gap: 16px;
  min-height: 320px;
}

.picker-available {
  flex: 1 1 50%;
  min-width: 0;
  max-height: 380px;
  overflow: auto;
  padding-right: 4px;
}

.picker-tree {
  /* tree fills the available column */
}

.miller-columns-container {
  display: flex;
  gap: 6px;
  overflow-x: auto;
}

.miller-column {
  flex: 0 0 180px;
  overflow-y: auto;
  border: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.06));
  border-radius: 4px;
  max-height: 360px;
}

.view-toggle {
  /* Compact icon-only toggle in the picker header. */
}

.picker-selected {
  flex: 1 1 50%;
  min-width: 0;
  max-height: 380px;
  overflow: auto;
  border-left: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.06));
  padding-left: 14px;
}

.picker-section-title {
  font-family: var(--nimbus-font);
  font-size: 10.5px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--nimbus-text-muted, #8a8f98);
  margin: 0 0 10px;
}

.selected-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.selected-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.03);
  font-size: 13px;
}

.selected-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selected-remove {
  flex: 0 0 auto;
  opacity: 0.7;
}
.selected-remove:hover {
  opacity: 1;
}
</style>
