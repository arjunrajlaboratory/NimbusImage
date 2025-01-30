<template>
  <v-container class="pa-0">
    <v-subheader v-if="label" class="px-0">{{ label }}</v-subheader>
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

  @VModel({ type: Object })
  selectedChannels!: { [key: number]: boolean };

  get channelItems() {
    const res = [];
    if (this.store.dataset) {
      for (const channel of this.store.dataset.channels) {
        res.push({
          text:
            this.store.dataset.channelNames.get(channel) ||
            `Channel ${channel}`,
          value: channel,
        });
      }
    }
    return res;
  }

  created() {
    // Initialize selectedChannels if empty
    if (!this.selectedChannels) {
      const initial: { [key: number]: boolean } = {};
      if (this.store.dataset) {
        for (const channel of this.store.dataset.channels) {
          initial[channel] = false;
        }
      }
      this.selectedChannels = initial;
    }
  }
}
</script>
