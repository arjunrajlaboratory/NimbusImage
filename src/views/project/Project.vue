<template>
  <router-view></router-view>
</template>
<script setup lang="ts">
import projects from "@/store/projects";
import { useRouteMapper } from "@/utils/useRouteMapper";

useRouteMapper({
  projectId: {
    parse: String,
    get: () => projects.currentProjectId,
    set: (value: string) => projects.setSelectedProject(value),
  },
});
</script>
