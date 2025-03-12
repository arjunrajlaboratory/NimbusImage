<template>
  <v-card>
    <v-card-title>
      Profile settings:&nbsp;<b> {{ store.userName }} </b>
    </v-card-title>
    <v-card-text>
      <v-container>
        <div>
          <h3>Username:</h3>
          <p>{{ store.userName }}</p>
        </div>
        <div>
          <h3>Girder domain:</h3>
          <p>{{ girderUrlFromApiRoot(store.girderRest.apiRoot) }}</p>
        </div>
        <v-btn color="error" dark @click="logout"> Logout </v-btn>
      </v-container>
    </v-card-text>
  </v-card>
</template>

<script lang="ts">
import { Vue, Component } from "vue-property-decorator";
import store, { girderUrlFromApiRoot } from "@/store";

@Component
export default class UserProfileSettings extends Vue {
  readonly store = store;
  readonly girderUrlFromApiRoot = girderUrlFromApiRoot;

  async logout() {
    await this.store.logout();
    this.$router.push({ name: "root" });
  }
}
</script>
