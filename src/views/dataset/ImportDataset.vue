<template>
  <v-container>
    <v-form v-model="valid">
      <v-text-field
        :value="pathName"
        label="Path"
        readonly
        required
        :error-messages="errorMessages"
        :success-messages="successMessages"
        placeholder="Choose folder with images..."
        :rules="rules"
      >
        <template #append>
          <girder-location-chooser
            v-model="path"
            title="Select a Folder with Images"
          />
        </template>
      </v-text-field>

      <div class="button-bar">
        <v-btn :disabled="!valid" color="success" class="mr-4" @click="submit"
          >Import</v-btn
        >
      </div>
    </v-form>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, watch, getCurrentInstance } from "vue";
import store from "@/store";
import { IGirderLocation } from "@/girder";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";

const vm = getCurrentInstance()!.proxy;

const valid = ref(false);
const path = ref<IGirderLocation | null>(null);
const errorMessages = ref<string[]>([]);
const successMessages = ref<string[]>([]);

const pathName = computed(() => {
  return path.value ? (path.value as any).name : "";
});

const rules = computed(() => {
  return [(v: string) => v.trim().length > 0 || `value is required`];
});

watch(path, (value) => {
  errorMessages.value = [];
  successMessages.value = [];

  if (value) {
    store.api
      .getImages((value as any)._id)
      .then((images: any[]) => {
        if (images.length > 0) {
          successMessages.value.push(
            `Detected ${images.length} ${
              images.length > 1 ? "images" : "image"
            }`,
          );
        } else {
          errorMessages.value.push(`No contained images detected`);
        }
      })
      .catch((error: any) => {
        errorMessages.value.push(
          `Cannot resolve number of contained images: ${error}`,
        );
      });
  }
});

function submit() {
  if (!valid.value) {
    return;
  }

  store.importDataset(path.value as any).then((ds: any) => {
    if (ds) {
      vm.$router.push({
        name: "dataset",
        params: { datasetId: ds.id },
      });
    }
  });
}

defineExpose({
  valid,
  path,
  errorMessages,
  successMessages,
  pathName,
  rules,
  submit,
});
</script>
