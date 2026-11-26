import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
import { nextTick } from "vue";

enableAutoUnmount(afterEach);

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  leaveApp: vi.fn(),
  route: {
    name: "oauthConsent",
    query: { request: "req1" } as Record<string, string>,
    fullPath: "/oauth/consent?request=req1",
  },
}));

vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      authRestored: false,
      isLoggedIn: false,
      girderUser: null as any,
      mcpOAuthAPI: {
        getRequest: vi.fn(),
        approve: vi.fn(),
        deny: vi.fn(),
      },
    }),
  };
});
vi.mock("vue-router", () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("@/utils/navigation", () => ({ leaveApp: mocks.leaveApp }));
vi.mock("@/utils/log", () => ({ logError: vi.fn() }));
vi.mock("@/utils/errors", () => ({
  extractErrorMessage: (error: any) => error?.message ?? String(error),
}));

import store from "@/store";
import { takeReturnTo } from "@/utils/returnAfterLogin";
import OAuthConsent from "./OAuthConsent.vue";

const s = store as any;
const REQUEST = {
  clientName: "Claude",
  clientId: "nimbusimage-claude",
  redirectHost: "claude.ai",
  localRedirect: false,
  resource: "https://app.example/mcp",
  scope: "nimbusimage",
};

async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mountPage() {
  return mount(OAuthConsent, {
    global: {
      stubs: {
        VContainer: { template: "<div><slot /></div>" },
        VRow: { template: "<div><slot /></div>" },
        VCol: { template: "<div><slot /></div>" },
        VCard: { template: "<div><slot /></div>" },
        VCardTitle: { template: "<div><slot /></div>" },
        VCardText: { template: "<div><slot /></div>" },
        VCardActions: { template: "<div><slot /></div>" },
        VAlert: {
          props: ["type"],
          template: "<div class='alert' :data-type='type'><slot /></div>",
        },
        VIcon: true,
        VProgressCircular: { template: "<div class='spinner' />" },
        VBtn: {
          template: "<button @click=\"$emit('click')\"><slot /></button>",
        },
      },
    },
  });
}

function loggedIn() {
  s.authRestored = true;
  s.isLoggedIn = true;
  s.girderUser = { _id: "u1", login: "alice" };
}

describe("OAuthConsent", () => {
  beforeEach(() => {
    sessionStorage.clear();
    s.authRestored = false;
    s.isLoggedIn = false;
    s.girderUser = null;
    s.mcpOAuthAPI.getRequest.mockReset().mockResolvedValue({ ...REQUEST });
    s.mcpOAuthAPI.approve
      .mockReset()
      .mockResolvedValue("https://claude.ai/cb?code=c&state=s");
    s.mcpOAuthAPI.deny
      .mockReset()
      .mockResolvedValue("https://claude.ai/cb?error=access_denied");
    mocks.replace.mockReset();
    mocks.leaveApp.mockReset();
    mocks.route.query = { request: "req1" };
    mocks.route.fullPath = "/oauth/consent?request=req1";
  });

  it("waits for the stored login before treating the user as logged out", async () => {
    const wrapper = mountPage();
    await flush();
    // Startup has not finished restoring the login: no bounce to login.
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(wrapper.find(".spinner").exists()).toBe(true);
    loggedIn();
    await flush();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(s.mcpOAuthAPI.getRequest).toHaveBeenCalledWith("req1");
  });

  it("goes ahead for a logged-in user even before authRestored", async () => {
    // e.g. logged in from the menu in a tab that started on a share link,
    // where initialize() never ran.
    s.isLoggedIn = true;
    s.girderUser = { _id: "u1", login: "alice" };
    mountPage();
    await flush();
    expect(s.mcpOAuthAPI.getRequest).toHaveBeenCalledWith("req1");
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("waits while a share link's user is still the session", async () => {
    // Leaving a share link restores the real login asynchronously.
    s.isLoggedIn = true;
    s.girderUser = {
      _id: "link",
      login: "link",
      shareLink: { datasetId: "d" },
    };
    mountPage();
    await flush();
    expect(s.mcpOAuthAPI.getRequest).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    s.girderUser = { _id: "u1", login: "alice" };
    s.authRestored = true;
    await flush();
    expect(s.mcpOAuthAPI.getRequest).toHaveBeenCalledTimes(1);
  });

  it("waits for a share session to end even after authRestored", async () => {
    s.authRestored = true;
    s.isLoggedIn = true;
    s.girderUser = {
      _id: "link",
      login: "link",
      shareLink: { datasetId: "d" },
    };
    mountPage();
    await flush();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(s.mcpOAuthAPI.getRequest).not.toHaveBeenCalled();
    // The leave found no real login: now go to login.
    s.girderUser = null;
    s.isLoggedIn = false;
    await flush();
    expect(mocks.replace).toHaveBeenCalledWith({ name: "root" });
  });

  it("reloads the request when the login changes", async () => {
    loggedIn();
    s.girderUser = { _id: "u1", login: "alice" };
    mountPage();
    await flush();
    s.girderUser = { _id: "u2", login: "bob" };
    await flush();
    expect(s.mcpOAuthAPI.getRequest).toHaveBeenCalledTimes(2);
  });

  it("sends a logged-out user to login and saves the way back", async () => {
    mountPage();
    s.authRestored = true;
    await flush();
    expect(mocks.replace).toHaveBeenCalledWith({ name: "root" });
    expect(takeReturnTo()).toBe("/oauth/consent?request=req1");
    expect(s.mcpOAuthAPI.getRequest).not.toHaveBeenCalled();
  });

  it("shows the client, the account and where it goes back to", async () => {
    loggedIn();
    const wrapper = mountPage();
    await flush();
    const text = wrapper.text();
    expect(text).toContain("Connect Claude to NimbusImage?");
    expect(text).toContain("alice");
    expect(text).toContain("full access");
    expect(text).toContain("claude.ai");
    expect(wrapper.find(".alert").exists()).toBe(false);
  });

  it("warns a site administrator", async () => {
    loggedIn();
    const wrapper = mountPage();
    await flush();
    expect(wrapper.find(".admin-warning").exists()).toBe(false);
    s.girderUser = { _id: "u1", login: "alice", admin: true };
    await flush();
    expect(wrapper.find(".admin-warning").text()).toContain(
      "site administrator",
    );
  });

  it("warns when the code goes to a program on this computer", async () => {
    loggedIn();
    s.mcpOAuthAPI.getRequest.mockResolvedValue({
      ...REQUEST,
      redirectHost: "localhost:3118",
      localRedirect: true,
    });
    const wrapper = mountPage();
    await flush();
    expect(wrapper.find(".alert").text()).toContain("this computer");
  });

  it("allow approves once and leaves for the client's callback", async () => {
    loggedIn();
    const wrapper = mountPage();
    await flush();
    const allow = wrapper
      .findAll("button")
      .find((b) => b.text().includes("Allow"))!;
    await allow.trigger("click");
    await allow.trigger("click");
    await flush();
    expect(s.mcpOAuthAPI.approve).toHaveBeenCalledTimes(1);
    expect(s.mcpOAuthAPI.approve).toHaveBeenCalledWith("req1");
    expect(mocks.leaveApp).toHaveBeenCalledWith(
      "https://claude.ai/cb?code=c&state=s",
    );
  });

  it("cancel denies and leaves with the client's error", async () => {
    loggedIn();
    const wrapper = mountPage();
    await flush();
    await (wrapper.vm as any).decide(false);
    expect(s.mcpOAuthAPI.deny).toHaveBeenCalledWith("req1");
    expect(mocks.leaveApp).toHaveBeenCalledWith(
      "https://claude.ai/cb?error=access_denied",
    );
  });

  it("never leaves for a non-web address", async () => {
    loggedIn();
    s.mcpOAuthAPI.approve.mockResolvedValue("javascript:alert(1)");
    const wrapper = mountPage();
    await flush();
    await (wrapper.vm as any).decide(true);
    expect(mocks.leaveApp).not.toHaveBeenCalled();
    expect((wrapper.vm as any).error).toContain("unexpected address");
  });

  it("explains an expired or used request", async () => {
    loggedIn();
    s.mcpOAuthAPI.getRequest.mockRejectedValue(
      new Error("This sign-in request has expired or was already used."),
    );
    const wrapper = mountPage();
    await flush();
    expect(wrapper.text()).toContain("expired or was already used");
  });

  it("needs a request id", async () => {
    loggedIn();
    mocks.route.query = {};
    const wrapper = mountPage();
    await flush();
    expect(wrapper.text()).toContain("missing its request");
    expect(s.mcpOAuthAPI.getRequest).not.toHaveBeenCalled();
  });

  it("refuses to run inside another site's frame", async () => {
    loggedIn();
    const top = Object.getOwnPropertyDescriptor(window, "top")!;
    Object.defineProperty(window, "top", { value: {}, configurable: true });
    try {
      const wrapper = mountPage();
      await flush();
      expect(wrapper.text()).toContain("its own tab");
      expect(wrapper.findAll("button")).toHaveLength(0);
      expect(s.mcpOAuthAPI.getRequest).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "top", top);
    }
  });
});
