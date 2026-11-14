import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import UserProfileSettings from "./UserProfileSettings.vue";

vi.mock("@/store", () => ({
  default: {
    userName: "testuser",
    girderRest: { apiRoot: "http://localhost:8080/api/v1" },
    logout: vi.fn().mockResolvedValue(undefined),
    userStorageInfo: { used: 10 * 1024 ** 3, quota: null },
    storageUsagePercentage: null,
    storageSeverity: "ok",
    mcpOAuthAPI: { listGrants: vi.fn().mockResolvedValue([]) },
  },
  girderUrlFromApiRoot: (apiRoot: string) => apiRoot.replace("/api/v1", ""),
}));

const mocks = vi.hoisted(() => ({
  steps: [] as string[],
  clearConversationAndStorage: vi.fn(),
  restartAfterLogout: vi.fn(),
}));

vi.mock("@/store/aiPanel", () => ({
  default: {
    clearConversationAndStorage: () => mocks.clearConversationAndStorage(),
  },
}));

vi.mock("@/utils/logoutRestart", () => ({
  restartAfterLogout: () => mocks.restartAfterLogout(),
}));

vi.mock("@/utils/log", () => ({ logError: vi.fn(), logWarning: vi.fn() }));

import { flushPromises } from "@vue/test-utils";
import { routerProvider } from "@/test/helpers";
import store from "@/store";

const mockRouter = { push: vi.fn() };

// Each step of a logout records itself after a tick, so the order asserted
// is the order the steps finished in, not the order they were started in.
function step(name: string) {
  return async () => {
    await Promise.resolve();
    mocks.steps.push(name);
  };
}

function mountComponent() {
  return mount(UserProfileSettings, {
    props: { visible: false },
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

  it("renders the storage usage section", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("10.00 GB");
    expect(wrapper.text()).toContain("used (no storage limit)");
  });

  describe("logout", () => {
    beforeEach(() => {
      mocks.steps = [];
      vi.mocked(store.logout).mockReset().mockImplementation(step("logout"));
      mocks.clearConversationAndStorage
        .mockReset()
        .mockImplementation(step("clear conversation"));
      mockRouter.push.mockReset().mockImplementation(step("go to root"));
      mocks.restartAfterLogout
        .mockReset()
        .mockImplementation(() => mocks.steps.push("reload"));
    });

    async function clickLogout() {
      await mountComponent().find(".v-btn").trigger("click");
      await nextTick();
      await flushPromises();
    }

    it("logs out, wipes the AI conversation, goes to root, then reloads", async () => {
      await clickLogout();

      expect(mocks.steps).toEqual([
        "logout",
        "clear conversation",
        "go to root",
        "reload",
      ]);
      expect(mockRouter.push).toHaveBeenCalledWith({ name: "root" });
    });

    it("still reloads when the AI conversation cannot be wiped", async () => {
      mocks.clearConversationAndStorage.mockRejectedValue(
        new Error("IndexedDB unavailable"),
      );

      await clickLogout();

      expect(mocks.steps).toEqual(["logout", "go to root", "reload"]);
    });

    it("still reloads when the navigation to root fails", async () => {
      mockRouter.push.mockRejectedValue(new Error("navigation failed"));

      await clickLogout();

      expect(mocks.steps).toEqual(["logout", "clear conversation", "reload"]);
    });
  });
});
