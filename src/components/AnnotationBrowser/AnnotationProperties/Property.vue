<!-- eslint-disable vue/multi-word-component-names -->
<template>
  <v-container class="ma-0 pa-0">
    <v-row class="mr-4">
      <!-- Property name -->
      <v-col class="d-flex px-2">
        <div class="d-flex align-center">
          {{ property.name }}
        </div>
      </v-col>
      <!-- Compute button -->
      <v-col class="px-0" cols="1">
        <v-btn small fab @click.native.stop :disabled="false" @click="compute">
          <v-badge
            color="red"
            :value="uncomputed[property.id].length > 0 && !status.running"
            :content="uncomputed[property.id].length"
          >
            <template v-if="status.running">
              <v-progress-circular indeterminate />
            </template>
            <template v-else>
              <v-icon color="primary"> mdi-play </v-icon>
            </template>
          </v-badge>
        </v-btn>
      </v-col>
    </v-row>
    <v-row v-if="status.running">
      <v-progress-linear
        :indeterminate="!status.progressInfo.progress"
        :value="100 * (status.progressInfo.progress || 0)"
        class="text-progress"
      >
        <strong class="pr-4">
          {{ status.progressInfo.title }}
        </strong>
        {{ status.progressInfo.info }}
      </v-progress-linear>
    </v-row>
    <v-row
      v-for="(warning, index) in filteredWarnings"
      :key="'warning-' + index"
    >
      <v-alert type="warning" dense class="mb-2">
        <div class="error-main">{{ warning.title }}: {{ warning.warning }}</div>
        <div v-if="warning.info" class="error-info">{{ warning.info }}</div>
      </v-alert>
    </v-row>
    <v-row v-for="(error, index) in filteredErrors" :key="'error-' + index">
      <v-alert type="error" dense class="mb-2">
        <div class="error-main">{{ error.title }}: {{ error.error }}</div>
        <div v-if="error.info" class="error-info">{{ error.info }}</div>
      </v-alert>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import Vue from "vue";
import { computed } from "vue";
import propertyStore, { IPropertyStatus } from "@/store/properties";
import {
  IAnnotationProperty,
  IErrorInfoList,
  MessageType,
} from "@/store/model";

const props = withDefaults(
  defineProps<{
    property: IAnnotationProperty;
    applyToAllDatasets?: boolean;
  }>(),
  {
    applyToAllDatasets: false,
  },
);

const emit = defineEmits<{
  (e: "compute-property-batch", property: IAnnotationProperty): void;
}>();

const status = computed((): IPropertyStatus => {
  return propertyStore.getStatus(props.property.id);
});

const uncomputed = computed(() => {
  return propertyStore.uncomputedAnnotationsPerProperty;
});

const filteredErrors = computed(() => {
  return (
    status.value.errorInfo?.errors.filter(
      (error) => error.error && error.type === MessageType.ERROR,
    ) || []
  );
});

const filteredWarnings = computed(() => {
  return (
    status.value.errorInfo?.errors.filter(
      (error) => error.warning && error.type === MessageType.WARNING,
    ) || []
  );
});

function compute() {
  if (status.value.running) {
    return;
  }

  if (props.applyToAllDatasets) {
    emit("compute-property-batch", props.property);
    return;
  }

  // Create a new error info object for this computation
  const errorInfo: IErrorInfoList = { errors: [] };

  // Ensure the property status exists
  if (!propertyStore.propertyStatuses[props.property.id]) {
    Vue.set(propertyStore.propertyStatuses, props.property.id, {
      running: false,
      previousRun: null,
      progressInfo: {},
      errorInfo: { errors: [] },
    });
  }

  // Update the status with the new error info
  Vue.set(
    propertyStore.propertyStatuses[props.property.id],
    "errorInfo",
    errorInfo,
  );

  propertyStore.computeProperty({
    property: props.property,
    errorInfo,
  });
}

defineExpose({ status, uncomputed, filteredErrors, filteredWarnings, compute });
</script>

<style lang="scss">
.text-progress {
  height: fit-content !important;
  min-height: 10px;
  padding: 4px;
}

.text-progress .v-progress-linear__content {
  position: relative;
}

.text-progress .v-progress-linear__background {
  height: 100%;
}

.text-progress .v-progress-linear__buffer {
  height: 100%;
}

.text-progress .v-progress-linear__determinate {
  height: 100%;
  top: 0;
}

.error-main {
  font-weight: 500;
  max-width: 300px;
}

.error-info {
  font-size: 0.875em;
  margin-top: 4px;
  max-width: 300px;
  word-wrap: break-word; /* Ensures long words don't overflow */
  opacity: 0.9;
}
</style>
