<template>
  <v-dialog v-model="isAlertOpen">
    <v-alert v-if="alert" class="ma-0" :type="alert.type">
      {{ alert.message }}
    </v-alert>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";

export interface IAlert {
  type: "success" | "info" | "warning" | "error" | undefined;
  message: string;
}

// Interface for template ref typing when used from Class Components
export interface IAlertDialogRef {
  openAlert(alert: IAlert): void;
}

const alert = ref<IAlert | null>(null);

const isAlertOpen = computed({
  get: () => alert.value !== null,
  set: (val: boolean) => {
    if (!val) {
      alert.value = null;
    } else {
      alert.value = {
        type: "info",
        message: "Unknown alert",
      };
    }
  },
});

function openAlert(newAlert: IAlert) {
  alert.value = newAlert;
}

// Expose method for parent components using template refs
defineExpose({ openAlert });
</script>
