<template>
  <v-icon v-if="tool" :size="size">{{ iconName }}</v-icon>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { IToolConfiguration } from "@/store/model";

const toolTypeToIcon = {
  create: "mdi-shape-plus",
  snap: "mdi-arrow-collapse-vertical",
  select: "mdi-select-drag",
  edit: "mdi-vector-polygon",
  segmentation: "mdi-shape-polygon-plus",
  connection: "mdi-vector-line",
} as const;

const createShapeToIcon = {
  point: "mdi-dots-hexagon",
  polygon: "mdi-vector-polygon",
  line: "mdi-chart-timeline-variant",
} as const;

type toolType = keyof typeof toolTypeToIcon;
type shape = keyof typeof createShapeToIcon;

const props = withDefaults(
  defineProps<{
    tool?: IToolConfiguration;
    size?: number | string;
  }>(),
  { size: 20 },
);

const iconName = computed(() => {
  if (props.tool) {
    if (props.tool.type === "create") {
      const s = props.tool.values?.annotation?.shape as shape;
      if (s) {
        return createShapeToIcon[s];
      }
    }
    const type = props.tool.type as toolType;
    return toolTypeToIcon[type];
  }
  return "";
});

defineExpose({ iconName });
</script>
