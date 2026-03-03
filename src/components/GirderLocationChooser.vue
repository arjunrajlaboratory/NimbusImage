<template>
  <v-dialog v-model="dialogInternal" scrollable width="auto">
    <template
      #activator="{ props: activatorProps }"
      v-if="activatorDisabled === false"
    >
      <div class="d-flex">
        <slot name="activator" v-bind="{ props: activatorProps }">
          <v-btn v-bind="activatorProps" :disabled="disabled">
            Choose...
          </v-btn>
        </slot>
        <girder-breadcrumb
          v-if="breadcrumb && selected"
          class="pl-4"
          root-location-disabled
          :location="selected"
          readonly
        />
      </div>
    </template>
    <v-card class="pa-2" style="min-width: 70vh">
      <v-card-title>{{ title }}</v-card-title>
      <v-card-text style="height: 70vh">
        <custom-file-manager
          v-model:location="selected"
          v-bind="$attrs"
          :initial-items-per-page="-1"
          :items-per-page-options="[-1]"
          :menu-enabled="false"
          :more-chips="false"
          :clickable-chips="false"
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click.prevent="dialogInternal = false" color="warning">
          Cancel
        </v-btn>
        <v-btn
          @click.prevent="select"
          :disabled="!isFolderSelected"
          color="primary"
        >
          Select
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { IGirderLocation } from "@/girder";

import CustomFileManager from "@/components/CustomFileManager.vue";
import { Breadcrumb as GirderBreadcrumb } from "@/girder/components";

const props = withDefaults(
  defineProps<{
    modelValue?: IGirderLocation | null;
    title?: string;
    breadcrumb?: boolean;
    activatorDisabled?: boolean;
    disabled?: boolean;
    dialog?: boolean | null;
  }>(),
  {
    modelValue: null,
    title: "Select a Folder",
    breadcrumb: false,
    activatorDisabled: false,
    disabled: false,
    dialog: null,
  },
);

const emit = defineEmits<{
  (e: "update:dialog", value: boolean): void;
  (e: "update:modelValue", value: any): void;
}>();

const dialogInternalCache = ref(false);
const selected = ref<IGirderLocation | null>(null);

const dialogInternal = computed({
  get: () => props.dialog ?? dialogInternalCache.value,
  set: (value: boolean) => {
    dialogInternalCache.value = value;
    emit("update:dialog", value);
  },
});

const isFolderSelected = computed(
  () =>
    selected.value &&
    "_modelType" in selected.value &&
    selected.value._modelType === "folder",
);

const selectedName = computed(() =>
  selected.value && "name" in selected.value
    ? selected.value.name
    : "Select a folder...",
);

onMounted(() => {
  selected.value = props.modelValue ?? null;
});

watch(
  () => props.modelValue,
  () => {
    selected.value = props.modelValue ?? null;
  },
);

function select() {
  dialogInternal.value = false;
  emit("update:modelValue", selected.value);
}

defineExpose({ dialogInternal, selectedName, select, selected });
</script>
