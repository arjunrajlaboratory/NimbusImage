<template>
  <v-dialog v-model="showDialog" width="50%">
    <v-card>
      <v-card-title> Color selected annotations </v-card-title>
      <v-card-text>
        <v-radio-group v-model="colorOption" class="mt-0">
          <v-radio value="layer" label="Use color from layer"></v-radio>
          <v-radio value="defined" label="Defined color"></v-radio>
          <v-radio value="random" label="Random color"></v-radio>
        </v-radio-group>
        <color-picker-menu
          v-if="colorOption === 'defined'"
          v-model="localCustomColor"
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn color="warning" @click="showDialog = false"> Cancel </v-btn>
        <v-btn color="primary" @click="submit"> Apply color </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { Vue, Component, Prop } from "vue-property-decorator";
import ColorPickerMenu from "@/components/ColorPickerMenu.vue";

@Component({
  components: { ColorPickerMenu },
})
export default class ColorSelectionDialog extends Vue {
  @Prop({ type: Boolean, required: true })
  show!: boolean;

  colorOption: string = "layer";
  localCustomColor: string = "#FFFFFF";

  get showDialog() {
    return this.show;
  }

  set showDialog(value: boolean) {
    this.$emit("update:show", value);
  }

  submit() {
    this.$emit("submit", {
      useColorFromLayer: this.colorOption === "layer",
      color: this.localCustomColor,
      randomize: this.colorOption === "random",
    });
    this.colorOption = "layer";
    this.localCustomColor = "#FFFFFF";
    this.showDialog = false;
  }
}
</script>
