<template>
  <div>
    <v-form @submit.prevent="login" class="my-8" v-if="!signUpMode">
      <v-text-field
        v-model="username"
        name="username"
        label="Username or e-mail"
        required
        prepend-icon="mdi-account"
        autocomplete="username"
      />
      <v-text-field
        v-model="password"
        name="password"
        type="password"
        label="Password"
        prepend-icon="mdi-lock"
        autocomplete="current-password"
      />
      <div class="d-flex flex-column">
        <v-btn type="submit" color="primary">Login</v-btn>
        <v-btn text class="align-self-end my-2" @click="switchToSignUp">
          Sign up
        </v-btn>
      </div>
    </v-form>
    <template v-else>
      <div class="text-center mb-8">
        <h2 class="text-h5 font-weight-bold mb-2">Sign up for NimbusImage!</h2>
        <p class="text-subtitle-1">Create a new account to get started.</p>
      </div>
      <v-form @submit.prevent="signUp" class="my-8">
        <v-text-field
          v-model="signupUsername"
          name="username"
          label="Username"
          required
          prepend-icon="mdi-account"
          autocomplete="username"
        />
        <v-text-field
          v-model="signupEmail"
          name="email"
          label="Email"
          required
          prepend-icon="mdi-email"
          autocomplete="email"
        />
        <v-text-field
          v-model="signupFirstName"
          name="firstName"
          label="First Name"
          required
          prepend-icon="mdi-account"
          autocomplete="given-name"
        />
        <v-text-field
          v-model="signupLastName"
          name="lastName"
          label="Last Name"
          required
          prepend-icon="mdi-account"
          autocomplete="family-name"
        />
        <v-text-field
          v-model="signupPassword"
          name="password"
          type="password"
          label="Password"
          required
          prepend-icon="mdi-lock"
          autocomplete="new-password"
        />
        <v-text-field
          v-model="signupPasswordVerification"
          name="passwordVerification"
          type="password"
          label="Password verification"
          required
          prepend-icon="mdi-lock"
          autocomplete="new-password"
        />
        <div class="d-flex flex-column">
          <v-btn
            type="submit"
            color="primary"
            :disabled="signupPassword !== signupPasswordVerification"
          >
            Sign up
          </v-btn>
          <v-btn text class="align-self-end my-2" @click="switchToLogin">
            Back to login
          </v-btn>
        </div>
      </v-form>
    </template>
    <v-alert :value="!!errorMessage" type="error">
      {{ errorMessage }}
    </v-alert>
    <v-alert :value="!!successMessage" type="success">
      {{ successMessage }}
    </v-alert>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import store from "@/store";

const props = defineProps<{
  domain: string;
  value: boolean;
}>();

const emit = defineEmits<{
  (e: "input", value: boolean): void;
}>();

const username = ref(import.meta.env.VITE_DEFAULT_USER || "");
const password = ref(import.meta.env.VITE_DEFAULT_PASSWORD || "");

const errorMessage = ref("");
const successMessage = ref("");

const signUpMode = ref(false);
const signupUsername = ref("");
const signupEmail = ref("");
const signupFirstName = ref("");
const signupLastName = ref("");
const signupPassword = ref("");
const signupPasswordVerification = ref("");

async function signUp() {
  errorMessage.value = "";
  successMessage.value = "";

  try {
    await store.signUp({
      domain: props.domain,
      login: signupUsername.value,
      email: signupEmail.value,
      firstName: signupFirstName.value,
      lastName: signupLastName.value,
      password: signupPassword.value,
      admin: false,
    });
    signUpMode.value = false;
    clearSignupFields();
    successMessage.value =
      "Sign-up successful! Please verify your email before logging in.";
  } catch (error) {
    errorMessage.value = (error as Error).message;
  }
}

function switchToSignUp() {
  signUpMode.value = true;
  errorMessage.value = "";
  successMessage.value = "";
}

function switchToLogin() {
  signUpMode.value = false;
  errorMessage.value = "";
  successMessage.value = "";
}

function clearSignupFields() {
  signupUsername.value = "";
  signupEmail.value = "";
  signupFirstName.value = "";
  signupLastName.value = "";
  signupPassword.value = "";
}

async function login() {
  errorMessage.value = "";
  successMessage.value = "";
  try {
    const result = await store.login({
      domain: props.domain,
      username: username.value,
      password: password.value,
    });
    if (result) {
      errorMessage.value = result;
    }
  } finally {
    password.value = "";
  }
}

defineExpose({
  username,
  password,
  errorMessage,
  successMessage,
  signUpMode,
  signupUsername,
  signupEmail,
  signupFirstName,
  signupLastName,
  signupPassword,
  signupPasswordVerification,
  login,
  signUp,
  switchToSignUp,
  switchToLogin,
  clearSignupFields,
});
</script>
