import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    isLoggedIn: false,
    hasUserLoggedOut: false,
    girderRest: { apiRoot: "http://localhost:8080/api/v1" },
    login: vi.fn(),
    signUp: vi.fn(),
  },
  girderUrlFromApiRoot: (apiRoot: string) => apiRoot.replace("/api/v1", ""),
}));

import store from "@/store";
import UserMenu from "./UserMenu.vue";

Vue.use(Vuetify);

let savedRoute: any;

function mountComponent(routeName = "root") {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  // Set $route on prototype before mounting so class field initializers can access it
  savedRoute = (Vue.prototype as any).$route;
  (Vue.prototype as any).$route = { name: routeName };

  return mount(UserMenu, {
    vuetify: new Vuetify(),
    stubs: {
      UserProfileSettings: true,
      UserMenuLoginForm: true,
    },
    attachTo: app,
  });
}

describe("UserMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (store as any).isLoggedIn = false;
    (store as any).hasUserLoggedOut = false;
    // Restore $route after each test
    if (savedRoute !== undefined) {
      (Vue.prototype as any).$route = savedRoute;
    } else {
      delete (Vue.prototype as any).$route;
    }
  });

  it("userMenu initializes to true on root route", () => {
    const wrapper = mountComponent("root");
    expect(wrapper.vm.userMenu).toBe(true);
    wrapper.destroy();
  });

  it("userMenu initializes to false on non-root route", () => {
    const wrapper = mountComponent("dataset");
    expect(wrapper.vm.userMenu).toBe(false);
    wrapper.destroy();
  });

  it("loggedInOrOut closes dialog when logged in", () => {
    const wrapper = mountComponent("root");
    expect(wrapper.vm.userMenu).toBe(true);
    (store as any).isLoggedIn = true;
    wrapper.vm.loggedInOrOut();
    expect(wrapper.vm.userMenu).toBe(false);
    wrapper.destroy();
  });

  it("loggedInOrOut closes dialog on logout", () => {
    const wrapper = mountComponent("root");
    (store as any).hasUserLoggedOut = true;
    wrapper.vm.loggedInOrOut();
    expect(wrapper.vm.userMenu).toBe(false);
    wrapper.destroy();
  });

  it("domain is set from girder API root", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.domain).toBe("http://localhost:8080");
    wrapper.destroy();
  });
});
