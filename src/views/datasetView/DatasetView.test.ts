import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      datasetView: null as { id: string } | null,
      requestCameraDeepLink: vi.fn(),
    }),
  };
});
vi.mock("@/utils/useRouteMapper", () => ({ useRouteMapper: vi.fn() }));
vi.mock("@/utils/useCameraDeepLinkUrl", () => ({
  useCameraDeepLinkUrlCleanup: vi.fn(),
}));

import store from "@/store";
import { routeProvider, routerProvider } from "@/test/helpers";
import DatasetView from "./DatasetView.vue";

function mount(query: Record<string, string>) {
  return shallowMount(DatasetView, {
    global: {
      provide: {
        ...routeProvider({ params: { datasetViewId: "v" }, query }),
        ...routerProvider(),
      },
      stubs: { "router-view": true },
    },
  });
}

describe("DatasetView camera deep link", () => {
  beforeEach(() => {
    (store.requestCameraDeepLink as any).mockClear();
  });

  it("applies a link on opening the view the store still holds", async () => {
    (store as any).datasetView = { id: "v" };
    mount({ x: "10", y: "20" });
    await nextTick();

    expect(store.requestCameraDeepLink).toHaveBeenCalledWith(
      expect.objectContaining({ x: "10", y: "20" }),
    );
  });

  it("leaves a link for another view to setDatasetViewId", async () => {
    (store as any).datasetView = { id: "other" };
    mount({ x: "10", y: "20" });
    await nextTick();

    expect(store.requestCameraDeepLink).not.toHaveBeenCalled();
  });
});
