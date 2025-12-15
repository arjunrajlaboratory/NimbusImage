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

<script lang="ts">
import { Vue, Component } from "vue-property-decorator";
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

@Component
export default class DeleteConnections extends Vue {
  readonly store = store;
  readonly annotationStore = annotationStore;
  readonly deleteOptions = deleteOptions;

  dialog = false;
  deleting = false;
  selectedDeleteOption: TDeleteOptions = deleteOptions[0].value;

  get isLoggedIn() {
    return this.store.isLoggedIn;
  }

  cancel() {
    this.dialog = false;
  }

  async submit() {
    this.deleting = true;
    const allConnections = this.annotationStore.annotationConnections;
    let connectionsToDelete: IAnnotationConnection[] = [];
    switch (this.selectedDeleteOption) {
      case "dataset":
        connectionsToDelete = allConnections;
        break;
      case "location":
        const currentLocation = this.store.currentLocation;
        const currentLocationAnnotationIds = new Set(
          this.annotationStore.annotations
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
          this.annotationStore.selectedAnnotationIds,
        );
        connectionsToDelete = allConnections.filter(
          ({ childId, parentId }) =>
            selectedAnnotationIds.has(childId) ||
            selectedAnnotationIds.has(parentId),
        );
        break;
    }
    if (connectionsToDelete.length > 0) {
      await this.annotationStore.deleteConnections(
        connectionsToDelete.map(({ id }) => id),
      );
    }
    this.deleting = false;
    this.dialog = false;
    this.selectedDeleteOption = deleteOptions[0].value;
  }
}
</script>
