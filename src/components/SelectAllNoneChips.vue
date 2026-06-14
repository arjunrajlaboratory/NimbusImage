<template>
  <div class="select-all-none">
    <v-btn
      variant="text"
      size="x-small"
      density="compact"
      class="select-all-none-btn"
      @click="emit('selectAll')"
    >
      <v-icon start size="14">mdi-check-all</v-icon>
      Select all
    </v-btn>
    <v-btn
      variant="text"
      size="x-small"
      density="compact"
      class="select-all-none-btn"
      @click="emit('selectNone')"
    >
      <v-icon start size="14">mdi-close-circle-outline</v-icon>
      Select none
    </v-btn>
  </div>
</template>

<script setup lang="ts">
const emit = defineEmits<{
  (e: "selectAll"): void;
  (e: "selectNone"): void;
}>();
</script>

<style lang="scss" scoped>
.select-all-none {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin: 0 4px 4px 0;
}

.select-all-none-btn {
  font-size: 11px;
  letter-spacing: 0;
  text-transform: none;
  color: var(--nimbus-text-muted, #8a8f98);
  padding-inline: 6px;
  min-width: 0;

  &:hover {
    color: var(--nimbus-text-secondary, #d0d6e0);
  }
}
</style>
