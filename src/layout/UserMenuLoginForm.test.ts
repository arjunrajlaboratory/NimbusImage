import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    login: vi.fn().mockResolvedValue(null),
    signUp: vi.fn().mockResolvedValue(undefined),
  },
}));

import store from "@/store";
import UserMenuLoginForm from "./UserMenuLoginForm.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(UserMenuLoginForm, {
    vuetify: new Vuetify(),
    propsData: {
      domain: "http://localhost:8080",
      value: true,
      ...props,
    },
  });
}

describe("UserMenuLoginForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders login form by default", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.signUpMode).toBe(false);
  });

  it("switchToSignUp toggles to signup mode", () => {
    const wrapper = mountComponent();
    wrapper.vm.switchToSignUp();
    expect(wrapper.vm.signUpMode).toBe(true);
  });

  it("switchToLogin toggles back to login mode", () => {
    const wrapper = mountComponent();
    wrapper.vm.switchToSignUp();
    wrapper.vm.switchToLogin();
    expect(wrapper.vm.signUpMode).toBe(false);
  });

  it("login calls store.login with domain/username/password", async () => {
    const wrapper = mountComponent();
    wrapper.vm.username = "admin";
    wrapper.vm.password = "secret";
    await wrapper.vm.login();
    expect(store.login).toHaveBeenCalledWith({
      domain: "http://localhost:8080",
      username: "admin",
      password: "secret",
    });
  });

  it("login sets errorMessage on error result", async () => {
    (store.login as any).mockResolvedValue("Invalid credentials");
    const wrapper = mountComponent();
    await wrapper.vm.login();
    expect(wrapper.vm.errorMessage).toBe("Invalid credentials");
  });

  it("login clears password after attempt", async () => {
    const wrapper = mountComponent();
    wrapper.vm.password = "secret";
    await wrapper.vm.login();
    expect(wrapper.vm.password).toBe("");
  });

  it("signUp calls store.signUp", async () => {
    const wrapper = mountComponent();
    wrapper.vm.signupUsername = "newuser";
    wrapper.vm.signupEmail = "new@test.com";
    wrapper.vm.signupFirstName = "New";
    wrapper.vm.signupLastName = "User";
    wrapper.vm.signupPassword = "password123";
    wrapper.vm.signupPasswordVerification = "password123";
    await wrapper.vm.signUp();
    expect(store.signUp).toHaveBeenCalledWith({
      domain: "http://localhost:8080",
      login: "newuser",
      email: "new@test.com",
      firstName: "New",
      lastName: "User",
      password: "password123",
      admin: false,
    });
  });

  it("signUp shows success message on success", async () => {
    const wrapper = mountComponent();
    wrapper.vm.signupUsername = "newuser";
    wrapper.vm.signupPassword = "pass";
    await wrapper.vm.signUp();
    expect(wrapper.vm.successMessage).toContain("Sign-up successful");
    expect(wrapper.vm.signUpMode).toBe(false);
  });

  it("signUp sets errorMessage on failure", async () => {
    (store.signUp as any).mockRejectedValue(new Error("User exists"));
    const wrapper = mountComponent();
    await wrapper.vm.signUp();
    expect(wrapper.vm.errorMessage).toBe("User exists");
  });

  it("clearSignupFields resets all signup fields", () => {
    const wrapper = mountComponent();
    wrapper.vm.signupUsername = "test";
    wrapper.vm.signupEmail = "test@test.com";
    wrapper.vm.signupFirstName = "Test";
    wrapper.vm.signupLastName = "User";
    wrapper.vm.signupPassword = "password";
    wrapper.vm.clearSignupFields();
    expect(wrapper.vm.signupUsername).toBe("");
    expect(wrapper.vm.signupEmail).toBe("");
    expect(wrapper.vm.signupFirstName).toBe("");
    expect(wrapper.vm.signupLastName).toBe("");
    expect(wrapper.vm.signupPassword).toBe("");
  });
});
