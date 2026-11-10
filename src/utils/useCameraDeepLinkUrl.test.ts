import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineComponent, nextTick, reactive } from "vue";
import { enableAutoUnmount, shallowMount } from "@vue/test-utils";
import { routeLocationKey } from "vue-router";

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      appliedCameraDeepLink: null,
      datasetView: { id: "a", datasetId: "ds" },
    }),
  };
});

import store from "@/store";
import { routerProvider } from "@/test/helpers";
import { useCameraDeepLinkUrlCleanup } from "./useCameraDeepLinkUrl";
import { removeQueryKeys } from "./useRouteMapper";

function makeRoute(path: string, query: Record<string, string>) {
  return reactive({
    name: "datasetview",
    params: { datasetViewId: path.split("/")[2] } as Record<string, string>,
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
    (store as any).appliedCameraDeepLink = null;
    (store as any).datasetView = { id: "a", datasetId: "ds" };
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

  function applyLink(x: number, y: number) {
    (store as any).appliedCameraDeepLink = {
      x,
      y,
      zoom: null,
      datasetId: "ds",
      datasetViewId: "a",
    };
  }

  async function settle() {
    for (let i = 0; i < 5; i++) await nextTick();
  }

  it("drops the applied link's keys from the URL, keeping the rest", async () => {
    mount();
    applyLink(5, 6);
    await settle();

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(route.query).toEqual({ z: "2" });
  });

  it("leaves another link alone even on the same view", async () => {
    // The applied link was (5, 6); the URL now carries a newer one.
    route.query = { z: "2", x: "7", y: "8" };
    mount();
    applyLink(5, 6);
    await settle();

    expect(router.replace).not.toHaveBeenCalled();
  });

  it("leaves another view's link with the same numbers alone", async () => {
    // The removal waited; the URL is now view b's link to the same point.
    mount();
    applyLink(5, 6);
    route.path = "/datasetView/b/view";
    route.params = { datasetViewId: "b" };
    await settle();

    expect(router.replace).not.toHaveBeenCalled();
  });

  it("leaves another share's link with the same numbers alone", async () => {
    // A share route has no view param: the store still holds the old view
    // while the next share's link loads, so only the path tells them apart.
    route.path = "/shared/T1";
    route.params = {};
    mount();
    // A URL write in flight holds the lock, so the removal waits.
    let release: () => void = () => {};
    router.replace.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const inFlight = removeQueryKeys(["z"], router as any, route as any);
    await nextTick();
    applyLink(5, 6);
    await nextTick();
    // Meanwhile another share opens, with the same numbers.
    route.path = "/shared/T2";
    release();
    await inFlight;
    await settle();

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(route.query).toMatchObject({ x: "5", y: "6" });
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

    applyLink(5, 6);
    await nextTick();
    // Meanwhile the user opens view B's link.
    route.path = "/datasetView/b/view";
    route.params = { datasetViewId: "b" };
    route.query = { x: "50", y: "60", z: "2" };
    release();
    await inFlight;
    await settle();

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(route.query).toMatchObject({ x: "50", y: "60" });
  });
});
