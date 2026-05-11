<template>
  <v-card variant="flat" class="pa-0 ma-0">
    <v-card-title v-if="item.name && item.name.length" class="px-4 py-2 ma-0">
      {{ item.name }}
    </v-card-title>
    <v-card-text class="pa-2 ma-0">
      <v-container class="pa-2 pl-6">
        <v-row>
          <v-col :cols="item.type === 'select' ? 6 : 12" class="py-0">
            <!-- Tool configuration component. Type depends on item type. -->
            <component
              :is="typeToComponentName[item.type]"
              :advanced="advanced"
              v-bind="boundMeta"
              v-model="componentValue"
              ref="innerComponent"
              return-object
              @update:model-value="changed"
              density="compact"
            >
              <v-radio
                v-for="(value, index) in item.values"
                :key="index"
                v-bind="value"
              >
              </v-radio>
            </component>
          </v-col>
        </v-row>
      </v-container>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
// Manually import those vuetify components that might be used procedurally
import {
  VSelect,
  VCheckbox,
  VTextField,
  VRadioGroup,
} from "vuetify/components";
import AnnotationConfiguration from "@/tools/creation/templates/AnnotationConfiguration.vue";
import TagAndLayerRestriction from "@/tools/creation/templates/TagAndLayerRestriction.vue";
import DockerImage from "@/tools/creation/templates/DockerImage.vue";
import TagPicker from "@/components/TagPicker.vue";

// Used to determine :is="" value from template interface type
const typeToComponentName: Record<string, any> = {
  select: VSelect,
  annotation: AnnotationConfiguration,
  restrictTagsAndLayer: TagAndLayerRestriction,
  checkbox: VCheckbox,
  radio: VRadioGroup,
  text: VTextField,
  dockerImage: DockerImage,
  tags: TagPicker,
};

type TComponentType = keyof typeof typeToComponentName;

interface IItem {
  type: TComponentType;
  name?: string;
  meta?: any;
  values?: any;
}

const props = defineProps<{
  item: IItem;
  modelValue: any;
  advanced?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: any): void;
  (e: "change"): void;
}>();

const componentValue = computed({
  get() {
    return props.modelValue;
  },
  set(newValue: any) {
    emit("update:modelValue", newValue);
  },
});

// `meta.value` is the default-value seed consumed by ToolConfiguration's
// setDefaultValues — it must not fall through to the rendered component.
// On VCheckbox (VSelectionControl), a `value` prop redefines trueValue/falseValue
// and breaks the checked-state toggle.
const boundMeta = computed(() => {
  if (!props.item.meta) return {};
  return Object.fromEntries(
    Object.entries(props.item.meta).filter(([key]) => key !== "value"),
  );
});

const innerComponent = ref<any>(null);

function changed() {
  emit("change");
}

defineExpose({ componentValue, typeToComponentName, changed, innerComponent });
</script>
