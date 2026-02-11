import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import UserProfileSettings from "./UserProfileSettings.vue";

vi.mock("@/store", () => ({
  default: {
    userName: "testuser",
    girderRest: { apiRoot: "http://localhost:8080/api/v1" },
    logout: vi.fn().mockResolvedValue(undefined),
  },
  girderUrlFromApiRoot: (apiRoot: string) => apiRoot.replace("/api/v1", ""),
}));

import store from "@/store";

Vue.use(Vuetify);

function mountComponent() {
  return mount(UserProfileSettings, {
    vuetify: new Vuetify(),
    mocks: {
      $router: { push: vi.fn() },
    },
  });
}

describe("UserProfileSettings", () => {
  it("displays username", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("testuser");
  });

  it("displays Girder domain", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("http://localhost:8080");
  });

  it("calls logout and navigates on logout button click", async () => {
    const wrapper = mountComponent();
    await wrapper.find(".v-btn").trigger("click");
    await Vue.nextTick();
    expect(store.logout).toHaveBeenCalled();
    expect(wrapper.vm.$router.push).toHaveBeenCalledWith({ name: "root" });
  });
});
