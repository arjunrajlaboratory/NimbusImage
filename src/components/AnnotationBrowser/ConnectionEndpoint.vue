<template>
  <div class="endpoint">
    <span class="endpoint-label" :class="{ 'is-missing': endpoint.missing }">
      <v-icon
        v-if="endpoint.missing"
        size="x-small"
        color="warning"
        class="mr-1"
        >mdi-alert</v-icon
      >{{ endpoint.missing ? "missing" : endpoint.label }}
    </span>
    <span v-if="endpoint.location" class="endpoint-location">
      {{ locationText }}
    </span>
  </div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import { IConnectionEndpoint } from "@/utils/connections";

const props = defineProps<{
  endpoint: IConnectionEndpoint;
}>();

// Locations are stored 0-based but shown 1-based everywhere in the UI, matching
// AnnotationListRow.
const locationText = computed(() => {
  const location = props.endpoint.location;
  if (!location) {
    return "";
  }
  return `T${location.Time + 1} Z${location.Z + 1} XY${location.XY + 1}`;
});
</script>

<style lang="scss" scoped>
.endpoint {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  padding: 2px 0;
}

.endpoint-label {
  font-size: 12px;
}

.endpoint-label.is-missing {
  color: rgb(var(--v-theme-warning));
  font-style: italic;
}

.endpoint-location {
  font-size: 10px;
  opacity: 0.6;
}
</style>
