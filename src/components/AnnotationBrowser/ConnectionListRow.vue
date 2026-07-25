<template>
  <tr
    :data-connection-id="row.connection.id"
    @mouseover="emit('hover', row.connection.id)"
    @mouseleave="emit('hover', null)"
    @click="emit('navigate', row)"
    title="Go to connection location"
    :class="{
      'is-hovered': row.connection.id === hoveredId,
      'is-selected': connectionListStore.isConnectionSelected(
        row.connection.id,
      ),
    }"
  >
    <td class="connection-cell select-cell">
      <v-checkbox
        hide-details
        title
        :model-value="
          connectionListStore.isConnectionSelected(row.connection.id)
        "
        @click.stop="emit('toggle-select', row.connection.id)"
      />
    </td>
    <td class="connection-cell">
      <connection-endpoint :endpoint="row.parent" />
    </td>
    <td class="connection-cell arrow-cell">
      <v-icon size="x-small">mdi-arrow-right</v-icon>
    </td>
    <td class="connection-cell">
      <connection-endpoint :endpoint="row.child" />
    </td>
    <td class="connection-cell tags-cell">
      <v-chip
        v-for="tag in row.connection.tags"
        :key="tag"
        size="x-small"
        @click.stop="emit('clicked-tag', tag)"
        >{{ tag }}</v-chip
      >
    </td>
    <td class="connection-cell actions-cell">
      <v-tooltip text="Delete this connection">
        <template v-slot:activator="{ props: activatorProps }">
          <v-btn
            v-bind="activatorProps"
            variant="text"
            icon
            size="x-small"
            color="error"
            aria-label="Delete this connection"
            :disabled="!isLoggedIn"
            @click.stop="emit('delete', row.connection.id)"
          >
            <v-icon size="small">mdi-delete</v-icon>
          </v-btn>
        </template>
      </v-tooltip>
    </td>
  </tr>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import store from "@/store";
import connectionListStore from "@/store/connectionList";
import ConnectionEndpoint from "@/components/AnnotationBrowser/ConnectionEndpoint.vue";
import { IConnectionRow } from "@/utils/connections";

defineProps<{
  row: IConnectionRow;
  hoveredId: string | null;
}>();

const emit = defineEmits<{
  (e: "hover", id: string | null): void;
  (e: "navigate", row: IConnectionRow): void;
  (e: "toggle-select", id: string): void;
  (e: "delete", id: string): void;
  (e: "clicked-tag", tag: string): void;
}>();

const isLoggedIn = computed(() => store.isLoggedIn);
</script>

<style lang="scss" scoped>
.connection-cell {
  padding: 0 6px !important;
  white-space: nowrap;
}

/* The checkbox is absolutely sized by Vuetify, so the cell needs its own width
   or the neighbouring endpoint label overlaps it once .tags-cell takes the
   slack. */
.select-cell {
  width: 40px;
  min-width: 40px;
}

.arrow-cell {
  padding: 0 !important;
  width: 20px;
  text-align: center;
  opacity: 0.6;
}

/* Absorb the table's slack here so the endpoint columns stay left-packed.
   Without it, a track table (whose rows usually have no tags) spreads the
   endpoint columns across the full width. */
.tags-cell {
  width: 100%;
}

.actions-cell {
  width: 32px;
  text-align: right;
}

tr.is-hovered {
  background: rgba(var(--v-theme-on-surface), 0.06);
}

tr.is-selected {
  background: rgba(var(--v-theme-primary), 0.14);
}
</style>
