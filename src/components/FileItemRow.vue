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
    <v-btn
      v-if="debouncedChipsPerItemId[item._id]?.type === 'dataset'"
      x-small
      icon
      class="ml-1"
      @click.stop="shareDialogVisible = true"
      v-tooltip="'Share Dataset'"
    >
      <v-icon x-small>mdi-share-variant</v-icon>
    </v-btn>
    <span
      class="text-caption grey--text mx-2"
      v-tooltip="{
        content: `Created: ${item.created ? formatDateString(item.created) : 'Unknown'}`,
        position: 'right',
      }"
    >
      Modified: {{ item.updated ? formatDateString(item.updated) : "Unknown" }}
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
    <share-dataset v-model="shareDialogVisible" :dataset="item" />
  </div>
</template>

<script lang="ts">
import { Vue, Component, Prop } from "vue-property-decorator";
import { IGirderSelectAble } from "@/girder";
import { formatDateString } from "@/utils/date";
import ShareDataset from "./ShareDataset.vue";

@Component({
  components: {
    ShareDataset,
  },
})
export default class ItemRow extends Vue {
  @Prop({ required: true })
  item!: IGirderSelectAble;

  @Prop({ required: true })
  debouncedChipsPerItemId!: { [itemId: string]: any };

  @Prop({ required: true })
  computedChipsIds!: Set<string>;

  @Prop({ default: true })
  showIcon!: boolean;

  shareDialogVisible = false;

  formatDateString = formatDateString;
}
</script>
