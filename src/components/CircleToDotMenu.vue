<template>
  <v-card>
    <v-card-subtitle class="pa-2"> Menu of: {{ tool.name }} </v-card-subtitle>
    <v-row no-gutters class="pa-2">
      <v-slider
        v-model="radius"
        :thumb-label="true"
        min="1"
        max="100"
        label="Radius"
      />
    </v-row>
  </v-card>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { IToolConfiguration } from "@/store/model";

const props = defineProps<{
  tool: IToolConfiguration;
}>();

const radius = ref(0);

function syncRadiusFromTool() {
  radius.value = props.tool.values.radius;
}

onMounted(syncRadiusFromTool);

watch(() => props.tool, syncRadiusFromTool);

watch(radius, (val) => {
  // eslint-disable-next-line vue/no-mutating-props
  props.tool.values.radius = val;
});

defineExpose({ radius });
</script>
