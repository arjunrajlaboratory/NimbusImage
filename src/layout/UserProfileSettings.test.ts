import { describe, it, expect, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import UserProfileSettings from "./UserProfileSettings.vue";

vi.mock("@/store", () => ({
  default: {
    userName: "testuser",
    girderRest: { apiRoot: "http://localhost:8080/api/v1" },
    logout: vi.fn().mockResolvedValue(undefined),
  },
  girderUrlFromApiRoot: (apiRoot: string) => apiRoot.replace("/api/v1", ""),
}));

import { routerProvider } from "@/test/helpers";
import store from "@/store";

const mockRouter = { push: vi.fn() };

function mountComponent() {
  return mount(UserProfileSettings, {
    global: {
      provide: {
        ...routerProvider(mockRouter),
      },
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
    await nextTick();
    expect(store.logout).toHaveBeenCalled();
    expect(mockRouter.push).toHaveBeenCalledWith({ name: "root" });
  });
});
