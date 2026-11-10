import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
import { routeProvider, routerProvider } from "@/test/helpers";

enableAutoUnmount(afterEach);
afterEach(() =>
  document.querySelectorAll('[data-app="true"]').forEach((app) => app.remove()),
);

vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      isLoggedIn: false,
      hasUserLoggedOut: false,
      girderRest: { apiRoot: "http://localhost:8080/api/v1" },
      login: vi.fn(),
      signUp: vi.fn(),
    }),
    girderUrlFromApiRoot: (apiRoot: string) => apiRoot.replace("/api/v1", ""),
  };
});

import store from "@/store";
import { nextTick } from "vue";
import { saveReturnTo } from "@/utils/returnAfterLogin";
import UserMenu from "./UserMenu.vue";

const replace = vi.fn();

async function mountComponent(
  routeName = "root",
  provided?: Record<symbol, any>,
) {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  const mockRouter = { isReady: vi.fn(() => Promise.resolve()), replace };

  const wrapper = mount(UserMenu, {
    global: {
      stubs: {
        UserProfileSettings: true,
        UserMenuLoginForm: true,
      },
      provide: {
        ...(provided ?? routeProvider({ name: routeName })),
        ...routerProvider(mockRouter),
      },
    },
    attachTo: app,
  });

  return mockRouter.isReady().then(() => wrapper);
}

describe("UserMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (store as any).isLoggedIn = false;
    (store as any).hasUserLoggedOut = false;
  });

  describe("return after login", () => {
    // The provided route is reactive; changing it is a navigation.
    function liveRoute(name: string) {
      const provided = routeProvider({ name });
      const key = Object.getOwnPropertySymbols(provided)[0];
      return { provided, route: provided[key] };
    }

    beforeEach(() => {
      sessionStorage.clear();
      replace.mockReset();
    });

    it("opens the login when a page sends the user to root", async () => {
      const { provided, route } = liveRoute("oauthConsent");
      const wrapper = await mountComponent("oauthConsent", provided);
      expect(wrapper.vm.userMenu).toBe(false);
      saveReturnTo("/oauth/consent?request=abc");
      route.name = "root";
      await nextTick();
      expect(wrapper.vm.userMenu).toBe(true);
    });

    it("does not open it on an ordinary visit to root", async () => {
      const { provided, route } = liveRoute("dataset");
      const wrapper = await mountComponent("dataset", provided);
      route.name = "root";
      await nextTick();
      expect(wrapper.vm.userMenu).toBe(false);
    });

    it("does not spend the way back on a share link's session", async () => {
      await mountComponent("shared");
      saveReturnTo("/oauth/consent?request=abc");
      (store as any).girderUser = { shareLink: { datasetId: "d" } };
      (store as any).isLoggedIn = true;
      await nextTick();
      expect(replace).not.toHaveBeenCalled();
      (store as any).girderUser = null;
    });

    it("goes back to the saved page once after login", async () => {
      await mountComponent("root");
      saveReturnTo("/oauth/consent?request=abc");
      (store as any).isLoggedIn = true;
      await nextTick();
      expect(replace).toHaveBeenCalledExactlyOnceWith(
        "/oauth/consent?request=abc",
      );
      (store as any).isLoggedIn = false;
      await nextTick();
      (store as any).isLoggedIn = true;
      await nextTick();
      expect(replace).toHaveBeenCalledTimes(1);
    });
  });

  it("userMenu initializes to true on root route", async () => {
    const wrapper = await mountComponent("root");
    expect(wrapper.vm.userMenu).toBe(true);
  });

  it("userMenu initializes to false on non-root route", async () => {
    const wrapper = await mountComponent("dataset");
    expect(wrapper.vm.userMenu).toBe(false);
  });

  it("loggedInOrOut closes dialog when logged in", async () => {
    const wrapper = await mountComponent("root");
    expect(wrapper.vm.userMenu).toBe(true);
    (store as any).isLoggedIn = true;
    wrapper.vm.loggedInOrOut();
    expect(wrapper.vm.userMenu).toBe(false);
  });

  it("loggedInOrOut closes dialog on logout", async () => {
    const wrapper = await mountComponent("root");
    (store as any).hasUserLoggedOut = true;
    wrapper.vm.loggedInOrOut();
    expect(wrapper.vm.userMenu).toBe(false);
  });

  it("domain is set from girder API root", async () => {
    const wrapper = await mountComponent();
    expect(wrapper.vm.domain).toBe("http://localhost:8080");
  });
});
