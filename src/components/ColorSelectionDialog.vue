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

<script setup lang="ts">
import { ref, computed } from "vue";
import ColorPickerMenu from "@/components/ColorPickerMenu.vue";

const props = defineProps<{
  show: boolean;
}>();

const emit = defineEmits<{
  (e: "update:show", value: boolean): void;
  (
    e: "submit",
    payload: {
      useColorFromLayer: boolean;
      color: string;
      randomize: boolean;
    },
  ): void;
}>();

const colorOption = ref("layer");
const localCustomColor = ref("#FFFFFF");

const showDialog = computed({
  get: () => props.show,
  set: (value: boolean) => emit("update:show", value),
});

function submit() {
  emit("submit", {
    useColorFromLayer: colorOption.value === "layer",
    color: localCustomColor.value,
    randomize: colorOption.value === "random",
  });
  colorOption.value = "layer";
  localCustomColor.value = "#FFFFFF";
  showDialog.value = false;
}

defineExpose({ colorOption, localCustomColor, showDialog, submit });
</script>
