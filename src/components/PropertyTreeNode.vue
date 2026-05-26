<template>
  <div class="property-tree-node">
    <div class="property-tree-row" :class="{ 'is-leaf': node.isLeaf }">
      <button
        v-if="!node.isLeaf"
        type="button"
        class="chevron-btn"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <v-icon size="14">
          {{ expanded ? "mdi-chevron-down" : "mdi-chevron-right" }}
        </v-icon>
      </button>
      <span v-else class="chevron-spacer" />

      <v-checkbox
        v-if="node.isLeaf"
        :model-value="isPathSelected(node.path)"
        @update:model-value="$emit('toggle', node.path)"
        :label="node.label"
        density="compact"
        hide-details
        class="leaf-checkbox"
      />
      <button
        v-else
        type="button"
        class="branch-label"
        @click="expanded = !expanded"
      >
        {{ node.label }}
      </button>
    </div>

    <div v-if="!node.isLeaf && expanded" class="property-tree-children">
      <property-tree-node
        v-for="child in node.children"
        :key="child.path.join('.')"
        :node="child"
        :isPathSelected="isPathSelected"
        :defaultExpanded="defaultExpanded"
        @toggle="$emit('toggle', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";

export interface IPropertyTreeNode {
  label: string;
  path: string[];
  isLeaf: boolean;
  children: IPropertyTreeNode[];
}

const props = withDefaults(
  defineProps<{
    node: IPropertyTreeNode;
    isPathSelected: (path: string[]) => boolean;
    defaultExpanded?: boolean;
  }>(),
  {
    defaultExpanded: false,
  },
);

defineEmits<{ (e: "toggle", path: string[]): void }>();

const expanded = ref(props.defaultExpanded);

watch(
  () => props.defaultExpanded,
  (val) => {
    expanded.value = val;
  },
);
</script>

<style lang="scss" scoped>
.property-tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
}

.chevron-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  color: var(--nimbus-text-muted, #8a8f98);

  &:hover {
    background: rgba(255, 255, 255, 0.05);
    color: var(--nimbus-text-secondary, #d0d6e0);
  }
}

.chevron-spacer {
  width: 20px;
}

.branch-label {
  display: inline-flex;
  align-items: center;
  flex: 1 1 auto;
  padding: 4px 6px;
  border: none;
  background: transparent;
  color: var(--nimbus-text-secondary, #d0d6e0);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  border-radius: 3px;

  &:hover {
    background: rgba(255, 255, 255, 0.04);
  }
}

.leaf-checkbox {
  flex: 1 1 auto;

  :deep(.v-label) {
    font-size: 13px;
    opacity: 1;
  }
}

.property-tree-children {
  margin-left: 20px;
  padding-left: 6px;
  border-left: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.06));
}
</style>
