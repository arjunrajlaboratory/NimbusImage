<template>
  <v-card class="d-flex flex-column property-list">
    <div class="property-header">
      <div class="d-flex align-center px-4 py-2">
        <span class="text-subtitle-1">Object Properties</span>
        <v-spacer></v-spacer>
        <template v-if="uncomputedProperties.length <= 0">
          <span class="text-none px-2 success--text">
            Computations done
            <v-icon small color="success">mdi-check</v-icon>
          </span>
        </template>
        <v-btn
          v-else
          text
          small
          color="primary"
          class="text-none px-2"
          @click="computeUncomputedProperties"
          :disabled="uncomputedRunning > 0"
        >
          {{
            uncomputedRunning > 0
              ? "Running uncomputed properties"
              : "Compute all"
          }}
          <template v-if="uncomputedRunning > 0">
            <v-progress-circular
              indeterminate
              size="16"
              width="2"
              class="ml-1"
            />
          </template>
          <template v-else>
            <v-icon small right>mdi-play</v-icon>
          </template>
        </v-btn>
      </div>
      <v-divider></v-divider>
    </div>
    <div class="property-content">
      <v-expansion-panels>
        <v-expansion-panel
          v-for="(property, index) in properties"
          :key="`${property.id} ${index}`"
        >
          <v-expansion-panel-header>
            <annotation-property :property="property" />
          </v-expansion-panel-header>
          <v-expansion-panel-content>
            <annotation-property-body :property="property" />
          </v-expansion-panel-content>
        </v-expansion-panel>
      </v-expansion-panels>
    </div>
  </v-card>
</template>

<script lang="ts">
import { Vue, Component } from "vue-property-decorator";
import store from "@/store";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";

import TagFilterEditor from "@/components/AnnotationBrowser/TagFilterEditor.vue";
import AnnotationProperty from "@/components/AnnotationBrowser/AnnotationProperties/Property.vue";
import AnnotationPropertyBody from "@/components/AnnotationBrowser/AnnotationProperties/PropertyBody.vue";
import { IAnnotationProperty } from "@/store/model";

@Component({
  components: {
    TagFilterEditor,
    AnnotationProperty,
    AnnotationPropertyBody,
  },
})
export default class PropertyList extends Vue {
  readonly store = store;
  readonly propertyStore = propertyStore;
  readonly filterStore = filterStore;

  get properties() {
    return propertyStore.properties;
  }

  get uncomputedProperties() {
    const res: IAnnotationProperty[] = [];
    for (const property of this.propertyStore.properties) {
      if (
        this.propertyStore.uncomputedAnnotationsPerProperty[property.id]
          .length > 0
      ) {
        res.push(property);
      }
    }
    return res;
  }

  get uncomputedRunning() {
    let value = 0;
    for (const property of this.uncomputedProperties) {
      if (this.propertyStore.propertyStatuses[property.id]?.running) {
        value++;
      }
    }
    return value;
  }

  computeUncomputedProperties() {
    for (const property of this.uncomputedProperties) {
      this.propertyStore.computeProperty({
        property,
        errorInfo: { errors: [] },
      });
    }
  }
}
</script>

<style scoped>
.property-list {
  height: 100%;
}

.property-header {
  flex: 0 0 auto;
}

.property-content {
  flex: 1 1 auto;
  overflow-y: scroll;
}
</style>
