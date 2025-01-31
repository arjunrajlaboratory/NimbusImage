<template>
  <v-container class="pa-0">
    <v-subheader v-if="label" class="px-0">{{ label }}</v-subheader>
    <template v-if="channelItems && channelItems.length">
      <v-row v-for="item in channelItems" :key="item.value" class="ma-0">
        <v-col cols="12" class="pa-1">
          <v-checkbox
            v-model="selectedChannels[item.value]"
            :label="item.text"
            dense
            hide-details
            v-bind="$attrs"
          ></v-checkbox>
        </v-col>
      </v-row>
    </template>
  </v-container>
</template>

<script lang="ts">
import { Vue, Component, Prop, VModel } from "vue-property-decorator";
import store from "@/store";

@Component({})
export default class ChannelCheckboxGroup extends Vue {
  readonly store = store;

  @Prop({ default: "" })
  readonly label!: string;

  @VModel({ type: Object, default: () => ({}) })
  selectedChannels!: { [key: number]: boolean };

  get channelItems() {
    if (!this.store.dataset) return [];

    return this.store.dataset.channels.map((channel: number) => ({
      text:
        this.store.dataset?.channelNames?.get(channel) || `Channel ${channel}`,
      value: channel,
    }));
  }

  created() {
    // Initialize selectedChannels with an empty object if undefined
    this.selectedChannels = this.selectedChannels || {};

    // Then add any missing channels
    if (this.store.dataset?.channels) {
      const updatedChannels = { ...this.selectedChannels };
      for (const channel of this.store.dataset.channels) {
        if (!(channel in updatedChannels)) {
          updatedChannels[channel] = false;
        }
      }
      this.selectedChannels = updatedChannels;
    }
  }
}
</script>
