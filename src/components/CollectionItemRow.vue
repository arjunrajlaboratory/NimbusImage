<template>
  <div class="flex-grow-1 d-flex align-center">
    <!-- Collection type indicator -->
    <v-chip x-small class="ma-1 type-indicator" color="grey darken-1">
      Collection
    </v-chip>

    <span
      class="text-caption grey--text mx-2"
      v-tooltip="{
        content: `Created: ${collection.created ? formatDateString(collection.created) : 'Unknown'}`,
        position: 'right',
      }"
    >
      Modified:
      {{
        collection.updated ? formatDateString(collection.updated) : "Unknown"
      }}
    </span>

    <v-spacer />

    <span class="chip-label">Datasets in collection:</span>

    <div class="d-flex flex-wrap">
      <!-- Dataset chips -->
      <template v-if="debouncedChipsPerItemId[collection._id]?.chips">
        <v-chip
          x-small
          v-for="(chipItem, i) in debouncedChipsPerItemId[collection._id]
            ?.chips"
          :key="'chip ' + i + ' collection ' + collection._id"
          class="ma-1"
          v-bind="chipItem"
          @click.stop="navigateToChip(chipItem)"
        >
          {{ chipItem.text }}
        </v-chip>
      </template>

      <!-- Loading state -->
      <v-chip
        v-else-if="computedChipsIds.has(collection._id)"
        x-small
        class="ma-1"
        color="grey lighten-1"
      >
        Loading datasets...
      </v-chip>

      <!-- No datasets state -->
      <v-chip v-else x-small class="ma-1" color="grey lighten-2">
        No datasets
      </v-chip>
    </div>
  </div>
</template>

<script lang="ts">
import { Vue, Component, Prop } from "vue-property-decorator";
import { IUPennCollection } from "@/girder";
import { formatDateString } from "@/utils/date";
import { RawLocation } from "vue-router";

interface IChipAttrs {
  text: string;
  color: string;
  to?: RawLocation;
}

@Component
export default class CollectionItemRow extends Vue {
  @Prop({ required: true })
  collection!: IUPennCollection;

  @Prop({ required: true })
  debouncedChipsPerItemId!: { [itemId: string]: any };

  @Prop({ required: true })
  computedChipsIds!: Set<string>;

  formatDateString = formatDateString;

  navigateToChip(chipItem: IChipAttrs) {
    if (chipItem.to) {
      this.$router.push(chipItem.to);
    }
  }
}
</script>

<style lang="scss" scoped>
.type-indicator {
  border-radius: 4px !important;
  font-family: "Roboto Mono", monospace !important;
  font-size: 9px !important;
  letter-spacing: 0.5px !important;
  height: 16px !important;
  padding: 0 4px !important;
  font-weight: 500 !important;
}

.chip-label {
  font-size: 0.9em;
}
</style>
