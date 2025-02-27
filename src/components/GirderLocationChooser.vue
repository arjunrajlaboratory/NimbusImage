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

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import store from "@/store";
import { IGirderSelectAble } from "@/girder";

@Component({
  components: {
    CustomFileManager: () => import("@/components/CustomFileManager.vue"),
    GirderBreadcrumb: () =>
      import("@/girder/components").then((mod) => mod.Breadcrumb),
  },
})
export default class GirderLocationChooser extends Vue {
  readonly store = store;

  @Prop()
  value!: IGirderSelectAble | null;

  @Prop({
    default: "Select a Folder",
  })
  title!: string;

  @Prop({
    default: false,
  })
  breadcrumb!: boolean;

  @Prop({
    default: false,
  })
  activatorDisabled!: boolean;

  @Prop({
    default: false,
  })
  disabled!: boolean;

  // Use the computed dialogInternal instead of dialog or dialogInternalCache
  @Prop({
    default: null,
  })
  private dialog!: boolean | null;
  private dialogInternalCache: boolean = false;

  selected: IGirderSelectAble | null = null;

  mounted() {
    this.valueChanged();
  }

  @Watch("value")
  valueChanged() {
    this.selected = this.value;
  }

  get dialogInternal() {
    return this.dialog ?? this.dialogInternalCache;
  }

  set dialogInternal(value: boolean) {
    this.dialogInternalCache = value;
    this.$emit("update:dialog", value);
  }

  get selectedName() {
    return this.selected ? this.selected.name : "Select a folder...";
  }

  select() {
    this.dialogInternal = false;
    this.$emit("input", this.selected);
  }
}
</script>
