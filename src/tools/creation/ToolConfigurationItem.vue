<template>
  <v-card flat class="pa-0 ma-0">
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
              v-bind="item.meta"
              v-model="componentValue"
              ref="innerComponent"
              return-object
              @change="changed"
              dense
              small
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
import { VSelect, VCheckbox, VTextField, VRadioGroup } from "vuetify/lib";
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
  value: any;
  advanced?: boolean;
}>();

const emit = defineEmits<{
  (e: "input", value: any): void;
  (e: "change"): void;
}>();

const componentValue = computed({
  get() {
    return props.value;
  },
  set(newValue: any) {
    emit("input", newValue);
  },
});

const innerComponent = ref<any>(null);

function changed() {
  emit("change");
}

defineExpose({ componentValue, typeToComponentName, changed, innerComponent });
</script>
