<template>
  <v-dialog v-model="dialogInternal" scrollable width="auto">
    <template #activator="{ on }" v-if="activatorDisabled === false">
      <div class="d-flex">
        <slot name="activator" v-bind="{ on }">
          <v-btn v-on="on" :disabled="disabled"> Choose... </v-btn>
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
          :location.sync="selected"
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
          :disabled="!selected || selected._modelType !== 'folder'"
          color="primary"
        >
          Select
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, getCurrentInstance } from "vue";
import { IGirderSelectAble } from "@/girder";
import CustomFileManager from "@/components/CustomFileManager.vue";
import { Breadcrumb as GirderBreadcrumb } from "@/girder/components";

const props = withDefaults(
  defineProps<{
    value?: IGirderSelectAble | null;
    title?: string;
    breadcrumb?: boolean;
    activatorDisabled?: boolean;
    disabled?: boolean;
    dialog?: boolean | null;
  }>(),
  {
    value: null,
    title: "Select a Folder",
    breadcrumb: false,
    activatorDisabled: false,
    disabled: false,
    dialog: null,
  },
);

const vm = getCurrentInstance()!.proxy;

const dialogInternalCache = ref(false);
const selected = ref<IGirderSelectAble | null>(null);

const dialogInternal = computed({
  get: () => props.dialog ?? dialogInternalCache.value,
  set: (value: boolean) => {
    dialogInternalCache.value = value;
    vm.$emit("update:dialog", value);
  },
});

const selectedName = computed(() =>
  selected.value ? selected.value.name : "Select a folder...",
);

onMounted(() => {
  selected.value = props.value ?? null;
});

watch(
  () => props.value,
  () => {
    selected.value = props.value ?? null;
  },
);

function select() {
  dialogInternal.value = false;
  vm.$emit("input", selected.value);
}

defineExpose({ dialogInternal, selectedName, select, selected });
</script>
