<template>
  <!-- Custom header content for a property column, shared by the client and
       server tables. Replaces Vuetify's default header content, so it must
       reproduce the default structure (label + sort icon) and add the remove
       button. The parent computes the sort icon (via the slot's getSortIcon)
       and passes plain values, so this component stays decoupled from
       Vuetify's internal column type. -->
  <div class="v-data-table-header__content">
    <span class="property-header-label">{{ title }}</span>
    <v-icon
      v-if="sortable"
      class="v-data-table-header__sort-icon"
      :icon="sortIcon"
    />
    <v-btn
      variant="text"
      size="x-small"
      density="compact"
      icon
      class="property-header-remove ml-1"
      :title="`Remove '${title}' from list`"
      @click.stop="emit('remove')"
    >
      <v-icon size="14">mdi-close</v-icon>
    </v-btn>
  </div>
</template>

<script lang="ts" setup>
defineProps<{
  title?: string;
  sortable?: boolean;
  // The sort glyph (e.g. "mdi-arrow-up"). Vuetify's getSortIcon is typed
  // IconValue but always returns a string for column sort arrows; the parent
  // narrows it.
  sortIcon: string;
}>();

const emit = defineEmits<{
  (e: "remove"): void;
}>();
</script>

<style lang="scss" scoped>
.property-header-label {
  vertical-align: middle;
  font-size: 12px;
  font-weight: 500;
  display: inline-block;
  max-width: 100%;
}

.property-header-remove {
  vertical-align: middle;
  opacity: 0.6;
}
.property-header-remove:hover {
  opacity: 1;
}
</style>
