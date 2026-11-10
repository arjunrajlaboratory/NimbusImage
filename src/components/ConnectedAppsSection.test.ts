import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { AxiosError, AxiosHeaders } from "axios";
import ConnectedAppsSection from "./ConnectedAppsSection.vue";

const api = vi.hoisted(() => ({
  listGrants: vi.fn(),
  deleteGrant: vi.fn(),
}));

// Reactive, so the component's watch on the current user fires.
const mockStore = vi.hoisted(() => ({
  default: null as unknown as {
    mcpOAuthAPI: typeof api;
    girderUser: { _id: string; shareLink?: object } | null;
  },
}));

vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  mockStore.default = reactive({ mcpOAuthAPI: api, girderUser: null });
  return mockStore;
});
vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

// Every wrapper watches the shared reactive user; one left mounted would
// load on a later test's user switch and use up that test's mock responses.
enableAutoUnmount(afterEach);

function httpError(status: number) {
  return new AxiosError("failed", "ERR", undefined, undefined, {
    status,
    statusText: "",
    data: {},
    headers: {},
    config: { headers: new AxiosHeaders() },
  });
}

function grant(id: string, clientName = "Claude") {
  return {
    id,
    clientName,
    clientId: "nimbusimage-claude",
    redirectHost: "127.0.0.1:4321",
    created: "2026-10-31T23:00:00+00:00",
    lastUsed: "2026-10-31T23:30:00+00:00",
  };
}

async function mountSection(visible = true) {
  const wrapper = mount(ConnectedAppsSection, { props: { visible } });
  await flushPromises();
  return wrapper;
}

describe("ConnectedAppsSection", () => {
  beforeEach(() => {
    api.listGrants.mockReset();
    api.deleteGrant.mockReset();
    mockStore.default.girderUser = { _id: "u1" };
  });

  it("lists the user's connected apps when the menu is open", async () => {
    api.listGrants.mockResolvedValue([grant("g1")]);
    const wrapper = await mountSection();
    expect(wrapper.text()).toContain("Connected apps");
    expect(wrapper.text()).toContain("Claude");
    expect(wrapper.text()).toContain("127.0.0.1:4321");
  });

  it("does not load while the menu is closed, and reloads on each open", async () => {
    api.listGrants.mockResolvedValue([]);
    const wrapper = await mountSection(false);
    expect(api.listGrants).not.toHaveBeenCalled();
    await wrapper.setProps({ visible: true });
    await flushPromises();
    await wrapper.setProps({ visible: false });
    await wrapper.setProps({ visible: true });
    await flushPromises();
    expect(api.listGrants).toHaveBeenCalledTimes(2);
  });

  it("says so when there are no connected apps", async () => {
    api.listGrants.mockResolvedValue([]);
    const wrapper = await mountSection();
    expect(wrapper.text()).toContain("No connected apps.");
  });

  it("hides the section when the OAuth plugin is switched off (404)", async () => {
    api.listGrants.mockRejectedValue(httpError(404));
    const wrapper = await mountSection();
    expect(api.listGrants).toHaveBeenCalled();
    expect(wrapper.text()).toBe("");
  });

  it("shows a failed load as an error, not as an empty list", async () => {
    api.listGrants.mockRejectedValue(httpError(500));
    const wrapper = await mountSection();
    expect(wrapper.text()).toContain("Could not load your connected apps.");
    expect(wrapper.text()).not.toContain("No connected apps.");
  });

  it("disconnects an app and removes it from the list", async () => {
    api.listGrants
      .mockResolvedValueOnce([grant("g1"), grant("g2", "Claude Code")])
      .mockResolvedValueOnce([grant("g2", "Claude Code")]);
    api.deleteGrant.mockResolvedValue(undefined);
    const wrapper = await mountSection();
    await wrapper.findAll(".v-btn")[0].trigger("click");
    await flushPromises();
    expect(api.deleteGrant).toHaveBeenCalledWith("g1");
    expect(wrapper.findAll(".connected-app")).toHaveLength(1);
    expect(wrapper.text()).toContain("Claude Code");
  });

  it("drops a grant already gone (404) instead of reporting a failure", async () => {
    api.listGrants
      .mockResolvedValueOnce([grant("g1")])
      .mockResolvedValueOnce([]);
    api.deleteGrant.mockRejectedValue(httpError(404));
    const wrapper = await mountSection();
    await wrapper.find(".v-btn").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("No connected apps.");
    expect(wrapper.text()).not.toContain("Could not disconnect");
  });

  it("keeps the app listed and reports a failed disconnect", async () => {
    api.listGrants.mockResolvedValue([grant("g1")]);
    api.deleteGrant.mockRejectedValue(httpError(500));
    const wrapper = await mountSection();
    await wrapper.find(".v-btn").trigger("click");
    await flushPromises();
    expect(wrapper.findAll(".connected-app")).toHaveLength(1);
    expect(wrapper.text()).toContain("Could not disconnect Claude.");
  });

  it("ignores a stale load that settles after a newer one", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    api.listGrants
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce([grant("g2", "Newer")]);
    const wrapper = await mountSection();
    await wrapper.setProps({ visible: false });
    await wrapper.setProps({ visible: true });
    await flushPromises();
    resolveFirst([grant("g1", "Stale")]);
    await flushPromises();
    expect(wrapper.text()).toContain("Newer");
    expect(wrapper.text()).not.toContain("Stale");
  });

  it("removes a disconnected app at once, before the reload settles", async () => {
    api.listGrants
      .mockResolvedValueOnce([grant("g1"), grant("g2", "Claude Code")])
      .mockReturnValueOnce(new Promise(() => {}));
    api.deleteGrant.mockResolvedValue(undefined);
    const wrapper = await mountSection();
    await wrapper.findAll(".v-btn")[0].trigger("click");
    await flushPromises();
    expect(wrapper.findAll(".connected-app")).toHaveLength(1);
  });

  it("keeps one failed disconnect's error when another succeeds", async () => {
    api.listGrants.mockResolvedValue([grant("g1"), grant("g2", "Other")]);
    let rejectFirst: (error: unknown) => void = () => {};
    let resolveSecond: (value: unknown) => void = () => {};
    api.deleteGrant
      .mockReturnValueOnce(new Promise((_, reject) => (rejectFirst = reject)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));
    const wrapper = await mountSection();
    const buttons = wrapper.findAll(".v-btn");
    await buttons[0].trigger("click");
    await buttons[1].trigger("click");
    rejectFirst(httpError(500));
    await flushPromises();
    resolveSecond(undefined);
    await flushPromises();
    expect(wrapper.text()).toContain("Could not disconnect Claude.");
  });

  it("shows nothing and loads nothing in a share-link session", async () => {
    mockStore.default.girderUser = { _id: "link", shareLink: {} };
    const wrapper = await mountSection();
    expect(api.listGrants).not.toHaveBeenCalled();
    expect(wrapper.text()).toBe("");
  });

  it("drops the previous user's apps when the session switches to a share link", async () => {
    api.listGrants.mockResolvedValue([grant("g1")]);
    const wrapper = await mountSection();
    expect(wrapper.text()).toContain("Claude");
    mockStore.default.girderUser = { _id: "link", shareLink: {} };
    await flushPromises();
    await wrapper.setProps({ visible: false });
    await wrapper.setProps({ visible: true });
    await flushPromises();
    expect(wrapper.text()).toBe("");
    expect(api.listGrants).toHaveBeenCalledTimes(1);
  });

  it("reloads for the new user when the session switches with the menu open", async () => {
    api.listGrants
      .mockResolvedValueOnce([grant("g1", "First user's app")])
      .mockResolvedValueOnce([grant("g2", "Second user's app")]);
    const wrapper = await mountSection();
    mockStore.default.girderUser = { _id: "u2" };
    await flushPromises();
    expect(wrapper.text()).toContain("Second user's app");
    expect(wrapper.text()).not.toContain("First user's app");
  });
});
