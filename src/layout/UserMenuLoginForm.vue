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

<script lang="ts">
import { Vue, Component, Prop } from "vue-property-decorator";
import store from "@/store";

@Component
export default class UserMenuLoginForm extends Vue {
  readonly store = store;

  @Prop({ required: true })
  domain!: string;

  // Controls the display of UserMenu
  @Prop({ required: true })
  value!: boolean;

  username = import.meta.env.VITE_DEFAULT_USER || "";
  password = import.meta.env.VITE_DEFAULT_PASSWORD || "";

  errorMessage = "";
  successMessage = "";

  signUpMode: boolean = false;
  signupUsername: string = "";
  signupEmail: string = "";
  signupFirstName: string = "";
  signupLastName: string = "";
  signupPassword: string = "";
  signupPasswordVerification: string = "";

  async signUp() {
    this.errorMessage = "";
    this.successMessage = "";

    try {
      await store.signUp({
        domain: this.domain,
        login: this.signupUsername,
        email: this.signupEmail,
        firstName: this.signupFirstName,
        lastName: this.signupLastName,
        password: this.signupPassword,
        admin: false,
      });
      // Handle successful signup
      this.signUpMode = false;
      this.clearSignupFields();
      this.successMessage =
        "Sign-up successful! Please verify your email before logging in.";
    } catch (error) {
      this.errorMessage = (error as Error).message;
    }
  }

  switchToSignUp() {
    this.signUpMode = true;
    this.errorMessage = "";
    this.successMessage = "";
  }

  switchToLogin() {
    this.signUpMode = false;
    this.errorMessage = "";
    this.successMessage = "";
  }

  clearSignupFields() {
    this.signupUsername = "";
    this.signupEmail = "";
    this.signupFirstName = "";
    this.signupLastName = "";
    this.signupPassword = "";
  }

  async login() {
    this.errorMessage = "";
    this.successMessage = "";
    try {
      const result = await store.login({
        domain: this.domain,
        username: this.username,
        password: this.password,
      });
      if (result) {
        this.errorMessage = result;
      }
    } finally {
      this.password = "";
    }
  }
}
</script>
