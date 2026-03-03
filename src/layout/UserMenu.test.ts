import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { routeProvider, routerProvider } from "@/test/helpers";

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

async function mountComponent(routeName = "root") {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  const mockRouter = { isReady: vi.fn(() => Promise.resolve()) };

  const wrapper = mount(UserMenu, {
    global: {
      stubs: {
        UserProfileSettings: true,
        UserMenuLoginForm: true,
      },
      provide: {
        ...routeProvider({ name: routeName }),
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
