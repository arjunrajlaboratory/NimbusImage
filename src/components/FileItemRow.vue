<template>
  <div class="flex-grow-1 d-flex align-center">
    <!-- First chip only -->
    <v-chip
      v-if="debouncedChipsPerItemId[item._id]?.chips?.[0]"
      x-small
      class="ma-1 type-indicator"
      v-bind="debouncedChipsPerItemId[item._id]?.chips?.[0]"
      @click.stop
    >
      {{ debouncedChipsPerItemId[item._id]?.chips?.[0].text }}
    </v-chip>
    <v-chip
      v-else-if="computedChipsIds.has(item._id)"
      x-small
      class="ma-1 type-indicator"
      color="grey darken-1"
    >
      Loading info...
    </v-chip>
    <span
      class="text-caption grey--text mx-2"
      v-tooltip="{
        content: `Created: ${formatDateString(item.created)}`,
        position: 'right',
      }"
    >
      Modified: {{ formatDateString(item.updated) }}
    </span>
    <v-spacer />
    <span
      v-if="debouncedChipsPerItemId[item._id]?.type === 'configuration'"
      class="chip-label"
      >Datasets in collection:</span
    >
    <span
      v-else-if="debouncedChipsPerItemId[item._id]?.type === 'dataset'"
      class="chip-label"
      >In collections:</span
    >
    <div class="d-flex flex-wrap">
      <!-- Rest of the chips -->
      <v-chip
        x-small
        v-for="(chipItem, i) in debouncedChipsPerItemId[item._id]?.chips?.slice(
          1,
        )"
        :key="'chip ' + i + ' item ' + item._id"
        class="ma-1"
        v-bind="chipItem"
        @click.stop
      >
        {{ chipItem.text }}
      </v-chip>
    </div>
    <slot name="actions"></slot>
  </div>
</template>

<script lang="ts">
import { Vue, Component, Prop } from "vue-property-decorator";
import { IGirderSelectAble } from "@/girder";
import { vuetifyConfig } from "@/girder";
import { formatDateString } from "@/utils/date";

@Component
export default class ItemRow extends Vue {
  @Prop({ required: true })
  item!: IGirderSelectAble;

  @Prop({ required: true })
  debouncedChipsPerItemId!: { [itemId: string]: any };

  @Prop({ required: true })
  computedChipsIds!: Set<string>;

  @Prop({ default: true })
  showIcon!: boolean;

  formatDateString = formatDateString;

  iconToMdi(icon: string) {
    return vuetifyConfig.icons.values[icon] || `mdi-${icon}`;
  }

  iconFromItem(selectable: IGirderSelectAble) {
    if (selectable._modelType === "file" || selectable._modelType === "item") {
      return "file";
    }
    if (selectable._modelType === "folder") {
      return "folder";
    }
    if (selectable._modelType === "user") {
      return "user";
    }
    return "file";
  }
}
</script>
