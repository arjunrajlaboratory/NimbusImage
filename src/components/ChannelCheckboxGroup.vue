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

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import store from "@/store";

const props = withDefaults(
  defineProps<{
    value?: Record<number, boolean>;
    label?: string;
  }>(),
  {
    value: () => ({}),
    label: "",
  },
);

const emit = defineEmits<{
  (e: "input", value: Record<number, boolean>): void;
}>();

const selectedChannels = ref<Record<number, boolean>>({});

watch(
  () => props.value,
  (val) => {
    selectedChannels.value = val ?? {};
  },
  { immediate: true, deep: true },
);

watch(
  selectedChannels,
  (val) => {
    emit("input", { ...val });
  },
  { deep: true },
);

const channelItems = computed(() => {
  if (!store.dataset) return [];
  return store.dataset.channels.map((channel: number) => ({
    text: store.dataset?.channelNames?.get(channel) || `Channel ${channel}`,
    value: channel,
  }));
});

// Initialize missing channels (equivalent to created() hook)
if (store.dataset?.channels) {
  const updatedChannels = { ...props.value };
  for (const channel of store.dataset.channels) {
    if (!(channel in updatedChannels)) {
      updatedChannels[channel] = false;
    }
  }
  selectedChannels.value = updatedChannels;
}
</script>
