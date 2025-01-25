<template>
  <v-list-item
    dense
    :value="tool.id"
    :style="{ 'max-height': '32px' }"
    :id="getTourStepId(tool.name)"
    v-tour-trigger="getTourTriggerId(tool.name)"
    v-mousetrap="
      tool.hotkey
        ? {
            bind: tool.hotkey,
            handler: toggleTool,
            data: {
              section: 'Tools',
              description: `Toggle tool:  ${tool.name}`,
            },
          }
        : []
    "
    v-bind="$attrs"
    v-on="$listeners"
    @mouseover="isHovering = true"
    @mouseleave="isHovering = false"
  >
    <v-list-item-avatar>
      <tool-icon :tool="tool" />
    </v-list-item-avatar>
    <v-list-item-content>
      <v-list-item-title>
        {{ tool.name }}
        <v-progress-circular
          v-if="isToolLoading"
          indeterminate
          width="4"
          size="16"
        />
        <v-icon v-else-if="statusIcon">{{ statusIcon }}</v-icon>
      </v-list-item-title>
    </v-list-item-content>
    <v-list-item-action>
      <v-btn
        icon
        :max-height="32"
        @click.stop="editDialog = true"
        v-show="isHovering"
      >
        <v-icon>mdi-pen</v-icon>
      </v-btn>
    </v-list-item-action>
    <v-dialog v-model="editDialog">
      <tool-edition :tool="tool" @close="editDialog = false" />
    </v-dialog>
  </v-list-item>
</template>

<script lang="ts">
import { IToolConfiguration } from "@/store/model";
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import store from "@/store";
import ToolIcon from "@/tools/ToolIcon.vue";
import ToolEdition from "@/tools/ToolEdition.vue";
import jobs from "@/store/jobs";
import { toKebabCase } from "@/utils/strings";

@Component({
  components: { ToolIcon, ToolEdition },
})
export default class Toolset extends Vue {
  readonly store = store;
  @Prop()
  tool!: IToolConfiguration;

  getTourTriggerId(id: string): string {
    return `${toKebabCase(id)}-tourtrigger`;
  }

  isHovering = false;
  editDialog = false;
  statusIcon: null | string = null;

  getTourStepId(id: string): string {
    return `${toKebabCase(id)}-tourstep`;
  }

  toggleTool() {
    if (this.isToolSelected) {
      this.store.setSelectedToolId(null);
    } else {
      this.store.setSelectedToolId(this.tool.id);
    }
  }

  get isToolSelected() {
    return this.store.selectedTool?.configuration.id === this.tool.id;
  }

  get isToolLoading() {
    return !this.isToolSelected && !!this.jobId;
  }

  get jobId(): string | null {
    const jobId = jobs.jobIdForToolId[this.tool.id];
    return jobId ?? null;
  }

  @Watch("jobId")
  onJobChanged() {
    if (!this.jobId) {
      return;
    }
    jobs
      .getPromiseForJobId(this.jobId)
      .then(
        (success) => (this.statusIcon = success ? "mdi-check" : "mdi-close"),
      );
  }
}
</script>
