<template>
  <router-view></router-view>
</template>
<script setup lang="ts">
import store from "@/store";
import { useRouteMapper } from "@/utils/useRouteMapper";

useRouteMapper({
  configurationId: {
    parse: String,
    get: () => store.selectedConfigurationId,
    set: (value: string) => store.setSelectedConfiguration(value),
  },
});
</script>
