<template>
  <v-dialog v-model="dialog">
    <template v-slot:activator="{ on, attrs }">
      <v-btn
        v-bind="{ ...attrs, ...$attrs }"
        v-on="on"
        :disabled="!isLoggedIn"
        v-description="{
          section: 'Object list actions',
          title: 'Delete connections',
          description:
            'Open a dialog to delete annotation connections for dataset, location or selected anntoations',
        }"
      >
        <v-icon>mdi-trash-can</v-icon>
        Delete connections
      </v-btn>
    </template>
    <v-card>
      <v-card-title> Delete annotation connections </v-card-title>
      <v-card-text>
        <v-radio-group v-model="selectedDeleteOption" mandatory>
          <template v-slot:label>
            <div class="subtitle-1">
              <strong> What connections do you want to remove? </strong>
            </div>
          </template>
          <v-radio
            v-for="{ label, value } in deleteOptions"
            :key="value"
            :label="label"
            :value="value"
          />
        </v-radio-group>
      </v-card-text>
      <v-card-actions :disabled="deleting">
        <v-spacer />
        <v-btn @click.prevent="cancel" color="warning"> Cancel </v-btn>
        <v-btn @click.prevent="submit" color="primary">
          Submit: delete connections
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import { IAnnotationConnection } from "@/store/model";

const deleteOptions = [
  { label: "All dataset connections", value: "dataset" },
  { label: "Connections at current location", value: "location" },
  { label: "Connections to and from selected annotations", value: "selected" },
] as const satisfies readonly {
  readonly label: string;
  readonly value: string;
}[];

type TDeleteOptions = (typeof deleteOptions)[number]["value"];

const dialog = ref(false);
const deleting = ref(false);
const selectedDeleteOption = ref<TDeleteOptions>(deleteOptions[0].value);

const isLoggedIn = computed(() => store.isLoggedIn);

function cancel() {
  dialog.value = false;
}

async function submit() {
  deleting.value = true;
  const allConnections = annotationStore.annotationConnections;
  let connectionsToDelete: IAnnotationConnection[] = [];
  switch (selectedDeleteOption.value) {
    case "dataset":
      connectionsToDelete = allConnections;
      break;
    case "location":
      const currentLocation = store.currentLocation;
      const currentLocationAnnotationIds = new Set(
        annotationStore.annotations
          .filter(
            ({ location }) =>
              location.Time === currentLocation.time &&
              location.XY === currentLocation.xy &&
              location.Z === currentLocation.z,
          )
          .map(({ id }) => id),
      );
      connectionsToDelete = allConnections.filter(
        ({ childId, parentId }) =>
          currentLocationAnnotationIds.has(childId) ||
          currentLocationAnnotationIds.has(parentId),
      );
      break;
    case "selected":
      const selectedAnnotationIds = new Set(
        annotationStore.selectedAnnotationIds,
      );
      connectionsToDelete = allConnections.filter(
        ({ childId, parentId }) =>
          selectedAnnotationIds.has(childId) ||
          selectedAnnotationIds.has(parentId),
      );
      break;
  }
  if (connectionsToDelete.length > 0) {
    await annotationStore.deleteConnections(
      connectionsToDelete.map(({ id }) => id),
    );
  }
  deleting.value = false;
  dialog.value = false;
  selectedDeleteOption.value = deleteOptions[0].value;
}

defineExpose({
  isLoggedIn,
  dialog,
  cancel,
  selectedDeleteOption,
  submit,
  deleting,
});
</script>
