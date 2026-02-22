<template>
  <div class="d-flex flex-column">
    <v-chip class="mb-2" variant="outlined" size="small" @click="emit('selectAll')">
      <v-icon start size="small">mdi-check-all</v-icon>
      Select All
    </v-chip>
    <v-chip variant="outlined" size="small" @click="emit('selectNone')">
      <v-icon start size="small">mdi-close-circle-outline</v-icon>
      Select None
    </v-chip>
  </div>
</template>

<script setup lang="ts">
const emit = defineEmits<{
  (e: "selectAll"): void;
  (e: "selectNone"): void;
}>();
</script>
