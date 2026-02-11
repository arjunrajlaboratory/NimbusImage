import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store/sync", () => ({
  default: {
    lastError: null as Error | null,
    loading: false,
    saving: false,
  },
}));

import ServerStatus from "./ServerStatus.vue";
import sync from "@/store/sync";

Vue.use(Vuetify);

function mountComponent() {
  return mount(ServerStatus, {
    vuetify: new Vuetify(),
  });
}

describe("ServerStatus", () => {
  beforeEach(() => {
    sync.lastError = null;
    sync.loading = false;
    sync.saving = false;
  });

  it("returns empty string for lastError when store has no error", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.lastError).toBe("");
  });

  it("returns error message when store has an error", () => {
    sync.lastError = new Error("Connection failed");
    const wrapper = mountComponent();
    expect(wrapper.vm.lastError).toBe("Connection failed");
  });

  it("reflects loading state from store", () => {
    sync.loading = true;
    const wrapper = mountComponent();
    expect(wrapper.vm.loading).toBe(true);
  });

  it("reflects saving state from store", () => {
    sync.saving = true;
    const wrapper = mountComponent();
    expect(wrapper.vm.saving).toBe(true);
  });

  it("shows sync icon when no error and not loading/saving", () => {
    const wrapper = mountComponent();
    expect(wrapper.find(".sync").exists()).toBe(true);
  });

  it("shows save icon when saving", () => {
    sync.saving = true;
    const wrapper = mountComponent();
    expect(wrapper.find(".save").exists()).toBe(true);
  });

  it("shows loading icon when loading", () => {
    sync.loading = true;
    const wrapper = mountComponent();
    expect(wrapper.find(".loading").exists()).toBe(true);
  });
});
