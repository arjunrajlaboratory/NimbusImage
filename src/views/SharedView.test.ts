import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { nextTick } from "vue";

const mocks = vi.hoisted(() => ({
  openShareLink: vi.fn(),
  leaveShareLink: vi.fn(),
  setDatasetViewId: vi.fn(),
  replace: vi.fn(),
  route: {
    params: { token: "tok" } as Record<string, string>,
    name: "shared" as string,
    query: {},
  },
}));

vi.mock("@/store", () => ({
  default: {
    openShareLink: mocks.openShareLink,
    leaveShareLink: mocks.leaveShareLink,
    setDatasetViewId: mocks.setDatasetViewId,
  },
}));
vi.mock("./datasetView/Viewer.vue", () => ({
  default: { template: "<div>Shared canvas</div>" },
}));
vi.mock("vue-router", () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("@/utils/log", () => ({ logError: vi.fn() }));
vi.mock("@/utils/errors", () => ({
  extractErrorMessage: (error: any) => error?.message ?? String(error),
}));

import SharedView from "./SharedView.vue";

async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SharedView", () => {
  beforeEach(() => {
    mocks.openShareLink.mockReset();
    mocks.leaveShareLink.mockReset().mockResolvedValue(undefined);
    mocks.replace.mockReset();
    mocks.setDatasetViewId.mockReset().mockResolvedValue(undefined);
    mocks.route.name = "shared";
    mocks.route.params = { token: "tok" };
  });

  it("acts as the link's bearer and opens its dataset view", async () => {
    mocks.openShareLink.mockResolvedValue({ datasetViewId: "v1" });
    const wrapper = shallowMount(SharedView);
    await flush();
    expect(mocks.openShareLink).toHaveBeenCalledWith({
      token: "tok",
      signal: expect.any(AbortSignal),
    });
    expect(mocks.setDatasetViewId).toHaveBeenCalledWith({
      id: "v1",
      routeQuery: {},
    });
    expect(mocks.replace).not.toHaveBeenCalled();
    expect((wrapper.vm as any).ready).toBe(true);
    wrapper.unmount();
    // Reload/remount bootstraps from the unchanged token-bearing route.
    const reloaded = shallowMount(SharedView);
    await flush();
    expect(mocks.openShareLink).toHaveBeenCalledTimes(2);
    expect((reloaded.vm as any).ready).toBe(true);
    reloaded.unmount();
  });

  it("marks the embed route so the chrome is dropped", async () => {
    mocks.route.name = "embed";
    mocks.openShareLink.mockResolvedValue({ datasetViewId: "v1" });
    shallowMount(SharedView);
    await flush();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.setDatasetViewId).toHaveBeenCalledWith({
      id: "v1",
      routeQuery: {},
    });
  });

  it("explains a dead link instead of navigating", async () => {
    mocks.openShareLink.mockRejectedValue(new Error("no longer valid"));
    const wrapper = shallowMount(SharedView);
    await flush();
    expect((wrapper.vm as any).error).toBe("no longer valid");
    expect(mocks.replace).not.toHaveBeenCalled();
    mocks.route.params = {};
    const empty = shallowMount(SharedView);
    await flush();
    expect((empty.vm as any).error).toContain("no token");
  });

  it("cancels pending authentication when leaving the shared route", async () => {
    let finish!: (link: any) => void;
    mocks.openShareLink.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const wrapper = shallowMount(SharedView);
    await flush();
    const request = mocks.openShareLink.mock.calls[0][0];
    wrapper.unmount();
    finish({ datasetViewId: "v1" });
    await flush();
    expect(request.signal?.aborted).toBe(true);
    expect(mocks.setDatasetViewId).not.toHaveBeenCalled();
  });

  it("gives back the viewer's own session when the route is left", async () => {
    mocks.openShareLink.mockResolvedValue({ datasetViewId: "v1" });
    const wrapper = shallowMount(SharedView);
    await flush();
    expect(mocks.leaveShareLink).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(mocks.leaveShareLink).toHaveBeenCalledTimes(1);
  });
});
