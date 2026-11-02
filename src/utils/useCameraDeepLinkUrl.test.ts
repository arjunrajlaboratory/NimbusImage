import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineComponent, nextTick, reactive } from "vue";
import { enableAutoUnmount, shallowMount } from "@vue/test-utils";
import { routeLocationKey } from "vue-router";

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  return { default: reactive({ appliedCameraDeepLinks: 0 }) };
});

import store from "@/store";
import { routerProvider } from "@/test/helpers";
import { useCameraDeepLinkUrlCleanup } from "./useCameraDeepLinkUrl";
import { removeQueryKeys } from "./useRouteMapper";

function makeRoute(path: string, query: Record<string, string>) {
  return reactive({
    name: "datasetview",
    params: {},
    query,
    path,
    hash: "",
    fullPath: path,
    matched: [],
    meta: {},
    redirectedFrom: undefined,
  });
}

enableAutoUnmount(afterEach);

describe("useCameraDeepLinkUrlCleanup", () => {
  let route: ReturnType<typeof makeRoute>;
  let router: { replace: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    (store as any).appliedCameraDeepLinks = 0;
    const current = makeRoute("/datasetView/a/view", {
      z: "2",
      x: "5",
      y: "6",
    });
    route = current;
    router = {
      replace: vi.fn(async (location: any) => {
        current.query = { ...location.query };
      }),
    };
  });

  function mount() {
    shallowMount(
      defineComponent({
        template: "<div />",
        setup() {
          useCameraDeepLinkUrlCleanup();
        },
      }),
      {
        global: {
          provide: {
            [routeLocationKey as symbol]: route,
            ...routerProvider(router),
          },
        },
      },
    );
  }

  async function settle() {
    for (let i = 0; i < 5; i++) await nextTick();
  }

  it("drops the applied link's keys from the URL, keeping the rest", async () => {
    mount();
    (store as any).appliedCameraDeepLinks++;
    await settle();

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(route.query).toEqual({ z: "2" });
  });

  it("leaves the URL alone until a link is applied", async () => {
    mount();
    await settle();

    expect(router.replace).not.toHaveBeenCalled();
  });

  it("does not strip another view's link that arrived while the removal waited", async () => {
    mount();
    // A URL write in flight holds the lock.
    let release: () => void = () => {};
    router.replace.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const inFlight = removeQueryKeys(["z"], router as any, route as any);
    await nextTick();

    (store as any).appliedCameraDeepLinks++;
    await nextTick();
    // Meanwhile the user opens view B's link.
    route.path = "/datasetView/b/view";
    route.query = { x: "50", y: "60", z: "2" };
    release();
    await inFlight;
    await settle();

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(route.query).toMatchObject({ x: "50", y: "60" });
  });
});
