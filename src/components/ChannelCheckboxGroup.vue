<template>
  <v-container class="pa-0">
    <v-list-subheader v-if="label" class="px-0">{{ label }}</v-list-subheader>
    <template v-if="channelItems && channelItems.length">
      <v-row v-for="item in channelItems" :key="item.value" class="ma-0">
        <v-col cols="12" class="pa-1">
          <v-checkbox
            v-model="selectedChannels[item.value]"
            :label="item.text"
            density="compact"
            hide-details
            v-bind="$attrs"
          ></v-checkbox>
        </v-col>
      </v-row>
    </template>
  </v-container>
</template>

<script setup lang="ts">
import { computed } from "vue";
import store from "@/store";

const props = withDefaults(
  defineProps<{
    modelValue?: Record<number, boolean>;
    label?: string;
  }>(),
  {
    modelValue: () => ({}),
    label: "",
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: Record<number, boolean>): void;
}>();

// Computed getter/setter mirrors the original @VModel behavior:
// checkbox mutations go directly through Vue's reactivity on the object,
// and full-object assignments emit "update:modelValue" to the parent.
const selectedChannels = computed({
  get() {
    return props.modelValue;
  },
  set(val: Record<number, boolean>) {
    emit("update:modelValue", val);
  },
});

const channelItems = computed(() => {
  if (!store.dataset) return [];
  return store.dataset.channels.map((channel: number) => ({
    text: store.dataset?.channelNames?.get(channel) || `Channel ${channel}`,
    value: channel,
  }));
});

// Initialize missing channels (equivalent to created() hook)
if (store.dataset?.channels) {
  const current = selectedChannels.value || {};
  const updatedChannels = { ...current };
  for (const channel of store.dataset.channels) {
    if (!(channel in updatedChannels)) {
      updatedChannels[channel] = false;
    }
  }
  selectedChannels.value = updatedChannels;
}
</script>
