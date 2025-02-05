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
              <div v-if="item.type === 'notes'" class="py-2 notes-container">
                {{ item.value }}
              </div>
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

<script lang="ts">
import { Vue, Component, Prop, Watch, VModel } from "vue-property-decorator";
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

// Popup for new tool configuration
@Component({
  components: {
    LayerSelect,
    ChannelSelect,
    ChannelCheckboxGroup,
    TagPicker,
  },
})
export default class WorkerInterfaceValues extends Vue {
  @Prop()
  readonly workerInterface!: IWorkerInterface;

  @Prop()
  readonly tool!: IToolConfiguration;

  @VModel({ type: Object }) interfaceValues!: IWorkerInterfaceValues;
  @Prop({ default: "right", type: String })
  readonly tooltipPosition!: "left" | "right";

  getTourStepId = getTourStepId;

  // Computed properties to determine tooltip alignment
  get isLeft() {
    return this.tooltipPosition === "left";
  }
  get isRight() {
    return this.tooltipPosition === "right";
  }

  get orderItemEntries() {
    const allEntries = Object.entries(this.workerInterface);
    const alphabeticalOrderItems = allEntries.filter(
      ([, { displayOrder }]) => displayOrder === undefined,
    );
    const explicitlySortedItems = allEntries
      .filter(([, { displayOrder }]) => displayOrder !== undefined)
      .sort(([, { displayOrder: a }], [, { displayOrder: b }]) => a! - b!);
    return [...explicitlySortedItems, ...alphabeticalOrderItems];
  }

  formattedTooltip(text: string): string {
    return text.replace(/\n/g, "<br>");
  }

  mounted() {
    this.populateValues();
  }

  @Watch("workerInterface")
  populateValues() {
    const interfaceValues: IWorkerInterfaceValues = {};
    for (const id in this.workerInterface) {
      if (id in this.tool.values.workerInterfaceValues) {
        interfaceValues[id] = this.tool.values.workerInterfaceValues[id];
      } else {
        const interfaceTemplate = this.workerInterface[id];
        interfaceValues[id] = getDefault(
          interfaceTemplate.type,
          interfaceTemplate.default,
        );
      }
    }
    this.interfaceValues = interfaceValues;
  }
}
</script>

<style scoped>
.notes-container {
  max-width: 300px;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
</style>
