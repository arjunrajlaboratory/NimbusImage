<template>
  <div>
    <v-dialog v-model="userMenu" v-if="!store.isLoggedIn" max-width="400px">
      <template #activator="{ on }">
        <v-btn v-if="!store.isLoggedIn" v-on="on">Login</v-btn>
      </template>
      <v-container class="pa-0">
        <v-card class="pa-6">
          <v-img
            src="/img/icons/NimbusImageIcon.png"
            max-height="80"
            contain
            class="mb-2 text-center"
          />
          <div class="text-center mb-8">
            <h2 class="text-h5 font-weight-bold mb-2">
              Welcome to NimbusImage!
            </h2>
            <p class="text-subtitle-1">
              A cloud-based image analysis platform from the Raj Lab at the
              University of Pennsylvania and Kitware
            </p>
          </div>
          <v-text-field
            v-if="!isDomainLocked"
            v-model="domain"
            name="domain"
            label="Girder Domain"
            required
            prepend-icon="mdi-domain"
          />
          <user-menu-login-form v-model="userMenu" :domain="domain" />
          <div class="text-center mt-4">
            <a
              href="https://arjun-raj-lab.gitbook.io/nimbusimage"
              target="_blank"
              class="link"
            >
              More information
            </a>
          </div>
        </v-card>
      </v-container>
    </v-dialog>
    <v-menu
      v-else
      v-model="userMenu"
      close-on-click
      offset-y
      :close-on-content-click="false"
    >
      <template #activator="{ on }">
        <v-btn icon v-on="on">
          <v-icon>mdi-account-circle</v-icon>
        </v-btn>
      </template>
      <v-card>
        <user-profile-settings />
      </v-card>
    </v-menu>
  </div>
</template>

<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store, { girderUrlFromApiRoot } from "@/store";
import UserProfileSettings from "@/layout/UserProfileSettings.vue";
import UserMenuLoginForm from "@/layout/UserMenuLoginForm.vue";

@Component({
  components: {
    UserProfileSettings,
    UserMenuLoginForm,
  },
})
export default class UserMenu extends Vue {
  readonly store = store;

  @Watch("store.isLoggedIn")
  loggedInOrOut() {
    this.userMenu = !store.isLoggedIn;
  }

  userMenu: boolean = !store.isLoggedIn;

  isDomainLocked = !!import.meta.env.VITE_GIRDER_URL;

  domain =
    import.meta.env.VITE_GIRDER_URL ||
    girderUrlFromApiRoot(store.girderRest.apiRoot);
}
</script>

<style lang="scss" scoped>
.link {
  display: inline-block;
  margin: 5px 0;
  color: #64b5f6; // A lighter blue that works well with dark themes
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}
</style>
