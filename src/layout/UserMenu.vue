<template>
  <div>
    <v-dialog v-model="userMenu" v-if="!store.isLoggedIn" max-width="400px">
      <template #activator="{ props: activatorProps }">
        <v-btn v-if="!store.isLoggedIn" v-bind="activatorProps" color="primary"
          >Login</v-btn
        >
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
      :close-on-content-click="false"
    >
      <template #activator="{ props: activatorProps }">
        <v-btn icon v-bind="activatorProps">
          <v-icon>mdi-account-circle</v-icon>
        </v-btn>
      </template>
      <v-card>
        <user-profile-settings />
      </v-card>
    </v-menu>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import store, { girderUrlFromApiRoot } from "@/store";
import UserProfileSettings from "@/layout/UserProfileSettings.vue";
import UserMenuLoginForm from "@/layout/UserMenuLoginForm.vue";

useRouter()
  .isReady()
  .then(() => {
    userMenu.value = route.name === "root";
  });

const route = useRoute();

const userMenu = ref(false);

const isDomainLocked = !!import.meta.env.VITE_GIRDER_URL;

const domain = ref(
  import.meta.env.VITE_GIRDER_URL ||
    girderUrlFromApiRoot(store.girderRest.apiRoot),
);

function loggedInOrOut() {
  if (store.isLoggedIn || store.hasUserLoggedOut) {
    userMenu.value = false;
  }
}

watch(() => store.isLoggedIn, loggedInOrOut);
watch(() => store.hasUserLoggedOut, loggedInOrOut);

defineExpose({ userMenu, isDomainLocked, domain, loggedInOrOut });
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
