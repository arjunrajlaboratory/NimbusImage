<template>
  <v-container class="pa-0 ma-0">
    <!--
      Dummy item group to prevent "change" events to be registered by a parent item group
      See: https://github.com/Kitware/UPennContrast/pull/391#issuecomment-1557606390
    -->
    <v-list-item-group>
      <template v-for="[id, item] in orderItemEntries">
        <span
          v-tooltip="{
            content: item.tooltip ? formattedTooltip(item.tooltip) : '',
            position: tooltipPosition,
            enabled: !!item.tooltip,
          }"
          :key="id"
        >
          <v-row class="pa-0 ma-0">
            <v-col class="pa-0 ma-0" cols="4">
              <v-subheader class="font-weight-bold" :id="getTourStepId(id)">
                {{ id }}
              </v-subheader>
            </v-col>
            <v-col class="pa-0 ma-0">
              <v-slider
                v-if="item.type === 'number'"
                v-bind="item.vueAttrs"
                v-model="interfaceValues[id]"
                :max="item.max"
                :min="item.min"
                :step="item.step || -1"
                class="align-center"
              >
                <template v-slot:append>
                  <v-text-field
                    v-model="interfaceValues[id]"
                    type="number"
                    :max="item.max"
                    :min="item.min"
                    :step="item.step || -1"
                    style="width: 60px"
                    class="mt-0 pt-0"
                    :label="item.unit ? item.unit : undefined"
                  ></v-text-field>
                </template>
              </v-slider>
              <div
                v-if="item.type === 'notes'"
                class="py-2 notes-container"
                v-html="item.value"
              ></div>
              <v-text-field
                v-if="item.type === 'text'"
                v-bind="item.vueAttrs"
                v-model="interfaceValues[id]"
                dense
              ></v-text-field>
              <tag-picker
                v-if="item.type === 'tags'"
                v-bind="item.vueAttrs"
                v-model="interfaceValues[id]"
              ></tag-picker>
              <layer-select
                :clearable="!item.required"
                v-if="item.type === 'layer'"
                v-bind="item.vueAttrs"
                v-model="interfaceValues[id]"
              ></layer-select>
              <v-select
                :clearable="!item.required"
                v-if="item.type === 'select'"
                v-bind="item.vueAttrs"
                v-model="interfaceValues[id]"
                :items="item.items"
              ></v-select>
              <channel-select
                :clearable="!item.required"
                v-if="item.type === 'channel'"
                v-bind="item.vueAttrs"
                v-model="interfaceValues[id]"
              ></channel-select>
              <channel-checkbox-group
                v-if="item.type === 'channelCheckboxes'"
                v-bind="item.vueAttrs"
                v-model="interfaceValues[id]"
              ></channel-checkbox-group>
              <v-checkbox
                v-if="item.type === 'checkbox'"
                v-bind="item.vueAttrs"
                v-model="interfaceValues[id]"
              ></v-checkbox>
            </v-col>
          </v-row>
        </span>
      </template>
    </v-list-item-group>
  </v-container>
</template>

<script setup lang="ts">
import { computed, watch, onMounted } from "vue";
import {
  IToolConfiguration,
  IWorkerInterface,
  IWorkerInterfaceValues,
} from "@/store/model";
import LayerSelect from "@/components/LayerSelect.vue";
import ChannelSelect from "@/components/ChannelSelect.vue";
import ChannelCheckboxGroup from "@/components/ChannelCheckboxGroup.vue";
import TagPicker from "@/components/TagPicker.vue";
import { getTourStepId } from "@/utils/strings";
import { getDefault } from "@/utils/workerInterface";

const props = withDefaults(
  defineProps<{
    value: IWorkerInterfaceValues;
    workerInterface: IWorkerInterface;
    tool?: IToolConfiguration | null;
    tooltipPosition?: "left" | "right";
  }>(),
  {
    tool: null,
    tooltipPosition: "right",
  },
);

const emit = defineEmits<{
  (e: "input", value: IWorkerInterfaceValues): void;
}>();

const interfaceValues = computed({
  get() {
    return props.value;
  },
  set(val: IWorkerInterfaceValues) {
    emit("input", val);
  },
});

const isLeft = computed(() => props.tooltipPosition === "left");
const isRight = computed(() => props.tooltipPosition === "right");

const orderItemEntries = computed(() => {
  const allEntries = Object.entries(props.workerInterface);
  const alphabeticalOrderItems = allEntries.filter(
    ([, { displayOrder }]) => displayOrder === undefined,
  );
  const explicitlySortedItems = allEntries
    .filter(([, { displayOrder }]) => displayOrder !== undefined)
    .sort(([, { displayOrder: a }], [, { displayOrder: b }]) => a! - b!);
  return [...explicitlySortedItems, ...alphabeticalOrderItems];
});

function formattedTooltip(text: string): string {
  return text.replace(/\n/g, "<br>");
}

function populateValues() {
  const values: IWorkerInterfaceValues = {};
  for (const id in props.workerInterface) {
    if (props.tool?.values?.workerInterfaceValues) {
      if (id in props.tool.values.workerInterfaceValues) {
        values[id] = props.tool.values.workerInterfaceValues[id];
      }
    } else {
      const interfaceTemplate = props.workerInterface[id];
      values[id] = getDefault(
        interfaceTemplate.type,
        interfaceTemplate.default,
      );
    }
  }
  interfaceValues.value = values;
}

onMounted(populateValues);
watch(() => props.workerInterface, populateValues);

defineExpose({
  interfaceValues,
  isLeft,
  isRight,
  orderItemEntries,
  formattedTooltip,
  populateValues,
});
</script>

<style scoped>
.notes-container {
  max-width: 300px;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
</style>
