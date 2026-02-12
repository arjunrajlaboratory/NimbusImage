<template>
  <div v-if="toolValues">
    <v-container v-if="basicInternalTemplate.length > 0">
      <template v-for="(item, index) in basicInternalTemplate">
        <tool-configuration-item
          v-if="shouldShowConfigurationItem(item)"
          :key="index"
          :item="item"
          :advanced="false"
          @change="changed"
          v-model="toolValues[item.id]"
          :ref="getRefSetter(item.id)"
        />
      </template>
    </v-container>
    <v-expansion-panels
      v-if="advancedInternalTemplate.length > 0 && showAdvancedPanel"
      v-model="advancedPanel"
    >
      <v-expansion-panel>
        <v-expansion-panel-header class="title">
          Advanced options
        </v-expansion-panel-header>
        <v-expansion-panel-content eager>
          <v-container>
            <template v-for="(item, index) in advancedInternalTemplate">
              <tool-configuration-item
                v-if="shouldShowConfigurationItem(item)"
                :key="index"
                :item="item"
                :advanced="true"
                @change="changed"
                v-model="toolValues[item.id]"
                :ref="getRefSetter(item.id)"
              />
            </template>
          </v-container>
        </v-expansion-panel-content>
      </v-expansion-panel>
    </v-expansion-panels>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import Vue from "vue";
import store from "@/store";
import propertiesStore from "@/store/properties";
import ToolConfigurationItem from "@/tools/creation/ToolConfigurationItem.vue";
import AnnotationConfiguration from "@/tools/creation/templates/AnnotationConfiguration.vue";
import TagAndLayerRestriction from "@/tools/creation/templates/TagAndLayerRestriction.vue";
import DockerImage from "@/tools/creation/templates/DockerImage.vue";

const props = defineProps<{
  value: Record<string, any>;
  template: any;
  defaultValues: any;
}>();

const emit = defineEmits<{
  (e: "input", value: Record<string, any> | null): void;
}>();

const advancedPanel = ref<number | undefined>();
const toolValues = ref<Record<string, any> | null>(null);
const valueTemplates = ref<any>({});
const itemRefs = ref<Record<string, any[]>>({});

function setItemRef(id: string, el: any) {
  if (el) {
    if (!itemRefs.value[id]) itemRefs.value[id] = [];
    if (!itemRefs.value[id].includes(el)) itemRefs.value[id].push(el);
  }
}

function getRefSetter(id: string) {
  return (el: any) => setItemRef(id, el);
}

// All interface elements that should be displayed
const internalTemplate = computed(() => {
  return [
    ...(props.template?.interface || []),
    ...Object.entries(valueTemplates.value)
      .map(([, value]: any[]) => value)
      .reduce((arr: any[], interfaceList: any[]) => {
        return [...arr, ...interfaceList];
      }, []),
  ];
});

const advancedInternalTemplate = computed(() => {
  return internalTemplate.value.filter(
    (item) => item.advanced || item.type === "annotation",
  );
});

const basicInternalTemplate = computed(() => {
  return internalTemplate.value.filter(
    (item) => !item.advanced || item.type === "annotation",
  );
});

const showAdvancedPanel = computed(() => {
  const dockerImage = toolValues.value?.image?.image;
  return dockerImage
    ? propertiesStore.showAdvancedOptionsPanel(dockerImage)
    : true;
});

function shouldShowConfigurationItem(item: any) {
  if (item.type !== "annotation") {
    return true;
  }
  const dockerImage = toolValues.value?.image?.image;
  return dockerImage
    ? propertiesStore.showAnnotationConfigurationPanel(dockerImage)
    : true;
}

function initialize() {
  valueTemplates.value = {};
  // Add default values
  setDefaultValues();
  // Add interface elements from current values
  updateInterface();
  // Add default values to new elements
  setDefaultValues();
}

function reset() {
  advancedPanel.value = undefined;
  toolValues.value = props.defaultValues
    ? structuredClone(props.defaultValues)
    : {};
  initialize();
  changed();
}

function changed() {
  valueTemplates.value = {};
  updateInterface();
  setDefaultValues();
  emit("input", toolValues.value);
}

function updateValues() {
  changed();
}

function setDefaultValues() {
  internalTemplate.value.forEach((item) => {
    if (toolValues.value === null || toolValues.value[item.id] !== undefined) {
      return;
    }
    const capturedToolValues = toolValues.value;
    const setItemValue = (value: any) =>
      Vue.set(capturedToolValues, item.id, value);
    switch (item.type) {
      case "select":
        if (item?.meta?.items.length) {
          const [firstValue] = item.meta.items;
          setItemValue({ ...firstValue });
        }
        break;

      case "radio":
        if (item.values?.length) {
          const [firstValue] = item.values;
          setItemValue(firstValue.value);
        }
        break;

      case "text":
        if (item.meta?.value) {
          setItemValue(item.meta?.value);
        } else if (item.meta?.type === "number") {
          setItemValue("0.0");
        } else {
          setItemValue("");
        }
        break;

      case "checkbox":
        if (item.meta?.value) {
          setItemValue(!!item.meta?.value);
        } else {
          setItemValue(false);
        }
        break;

      default:
        // The itemRefs are referencing child refs
        if (Array.isArray(itemRefs.value[item.id])) {
          const innerComponents = (itemRefs.value[item.id] as Vue[]).reduce(
            (innerComps, configItem) => [
              ...innerComps,
              (configItem as any).$refs["innerComponent"] as Vue,
            ],
            [] as Vue[],
          );
          switch (item.type) {
            case "annotation":
              const annotations = innerComponents as any[];
              if (annotations.length) {
                setItemValue({});
                annotations.forEach((annotation) =>
                  (annotation as any).reset(),
                );
              }
              break;

            case "restrictTagsAndLayer":
              const restricts = innerComponents as any[];
              if (restricts.length) {
                setItemValue({});
                restricts.forEach((restrict) => restrict.reset());
              }
              break;

            case "dockerImage":
              const dockerImages = innerComponents as any[];
              if (dockerImages.length) {
                setItemValue(null);
                dockerImages.forEach((dockerImage) => dockerImage.reset());
              }
              break;

            default:
              break;
          }
        }
        break;
    }
  });
}

function updateInterface() {
  // Go through values to see if additional interface elements need to be added
  Object.entries(toolValues.value ?? {}).forEach(([key, value]: any[]) => {
    if (value?.meta?.interface) {
      valueTemplates.value = {
        ...valueTemplates.value,
        [key]: value.meta.interface,
      };
    }
  });
}

// Watches
watch(() => props.template, reset);
watch(() => props.defaultValues, reset);
watch(toolValues, updateValues);

onMounted(() => {
  reset();
});

defineExpose({
  advancedPanel,
  toolValues,
  valueTemplates,
  internalTemplate,
  advancedInternalTemplate,
  basicInternalTemplate,
  showAdvancedPanel,
  reset,
  changed,
  setDefaultValues,
  updateInterface,
  shouldShowConfigurationItem,
  initialize,
  itemRefs,
});
</script>
