<template>
  <router-view></router-view>
</template>
<script lang="ts">
import projects from "@/store/projects";
import routeMapper from "@/utils/routeMapper";

export default routeMapper({
  projectId: {
    parse: String,
    get: () => projects.currentProjectId,
    set: (value: string) => projects.setSelectedProject(value),
  },
});
</script>
