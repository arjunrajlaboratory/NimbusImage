import { describe, it, expect, vi, beforeEach } from "vitest";
import { defineComponent, nextTick, reactive, ref } from "vue";
import { shallowMount } from "@vue/test-utils";
import { routeLocationKey } from "vue-router";

// Mock dependencies before any imports
vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: {},
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {},
}));

import { routeProvider, routerProvider } from "@/test/helpers";
import { useRouteMapper } from "./useRouteMapper";

describe("useRouteMapper", () => {
  let mockRouter: any;

  beforeEach(() => {
    vi.resetModules();
    mockRouter = {
      replace: vi.fn().mockResolvedValue(undefined),
    };
  });

  async function setup(
    paramsMapper: Record<string, any>,
    queryMapper: Record<string, any> = {},
    routeParams: Record<string, string> = {},
    routeQuery: Record<string, string> = {},
  ) {
    const TestComponent = defineComponent({
      template: "<div />",
      setup() {
        useRouteMapper(paramsMapper, queryMapper);
      },
    });

    const wrapper = shallowMount(TestComponent, {
      global: {
        provide: {
          ...routeProvider({ params: routeParams, query: routeQuery }),
          ...routerProvider(mockRouter),
        },
      },
    });

    // Wait for onMounted sync to complete
    await nextTick();
    await nextTick();

    return { wrapper };
  }

  it("syncs URL params to store on mount", async () => {
    const setter = vi.fn().mockResolvedValue(undefined);
    const mapper = {
      parse: String,
      get: () => null,
      set: setter,
    };

    await setup({ projectId: mapper }, {}, { projectId: "p1" });
    expect(setter).toHaveBeenCalledWith("p1");
  });

  it("syncs URL query to store on mount", async () => {
    const setter = vi.fn().mockResolvedValue(undefined);
    const mapper = {
      parse: String,
      get: () => null,
      set: setter,
    };

    await setup({}, { datasetId: mapper }, {}, { datasetId: "d1" });
    expect(setter).toHaveBeenCalledWith("d1");
  });

  it("does not call setter when URL value is undefined", async () => {
    const setter = vi.fn().mockResolvedValue(undefined);
    const mapper = {
      parse: String,
      get: () => null,
      set: setter,
    };

    await setup({ projectId: mapper }, {}, {});
    expect(setter).not.toHaveBeenCalled();
  });

  it("does not call setter when parsed value matches current value", async () => {
    const setter = vi.fn().mockResolvedValue(undefined);
    const mapper = {
      parse: String,
      get: () => "p1",
      set: setter,
    };

    await setup({ projectId: mapper }, {}, { projectId: "p1" });
    expect(setter).not.toHaveBeenCalled();
  });

  it("uses parse function correctly for parseInt", async () => {
    const setter = vi.fn().mockResolvedValue(undefined);
    const mapper = {
      parse: (v: string) => parseInt(v, 10),
      get: () => null,
      set: setter,
    };

    await setup({}, { z: mapper }, {}, { z: "5" });
    expect(setter).toHaveBeenCalledWith(5);
  });

  it("uses parse function correctly for boolean", async () => {
    const setter = vi.fn().mockResolvedValue(undefined);
    const mapper = {
      parse: (v: string) => v === "true",
      get: () => null,
      set: setter,
    };

    await setup({}, { unrollZ: mapper }, {}, { unrollZ: "true" });
    expect(setter).toHaveBeenCalledWith(true);
  });

  it("handles multiple params and queries", async () => {
    const paramSetter = vi.fn().mockResolvedValue(undefined);
    const querySetter = vi.fn().mockResolvedValue(undefined);

    const paramMapper = {
      parse: String,
      get: () => null,
      set: paramSetter,
    };
    const queryMapper = {
      parse: String,
      get: () => null,
      set: querySetter,
    };

    await setup(
      { configurationId: paramMapper },
      { datasetId: queryMapper },
      { configurationId: "c1" },
      { datasetId: "d1" },
    );
    expect(paramSetter).toHaveBeenCalledWith("c1");
    expect(querySetter).toHaveBeenCalledWith("d1");
  });

  it("replays a syncFromRoute that was skipped while store→URL writes were draining", async () => {
    // Regression: when a router.replace from a store→URL write is in flight,
    // syncFromRoute returns early to avoid clobbering the store with the
    // stale (mid-transition) URL value. Without a follow-up replay, a real
    // external URL change (browser back, manual edit) that fires its
    // fullPath watcher during that drain window is silently dropped — the
    // store stays out of sync with the URL until some unrelated future
    // route change happens.
    const setter = vi.fn().mockResolvedValue(undefined);
    const storeValue = ref<string | null>("v1");
    const mapper = {
      parse: String,
      get: () => storeValue.value,
      set: setter,
    };

    // Make router.replace controllable so we can hold the drain open.
    let resolveReplace: () => void = () => {};
    mockRouter.replace = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveReplace = r;
        }),
    );

    const route = reactive({
      name: "root",
      params: {},
      query: { q: "v1" } as Record<string, string>,
      path: "/",
      hash: "",
      fullPath: "/?q=v1",
      matched: [],
      meta: {},
      redirectedFrom: undefined,
    });

    const TestComponent = defineComponent({
      template: "<div />",
      setup() {
        useRouteMapper({}, { q: mapper });
      },
    });

    shallowMount(TestComponent, {
      global: {
        provide: {
          [routeLocationKey as symbol]: route,
          ...routerProvider(mockRouter),
        },
      },
    });

    await nextTick();
    await nextTick();

    // 1. Store → URL: store changes from v1 to v2. Watcher fires
    //    setUrlParamsOrQuery → router.replace (held pending).
    storeValue.value = "v2";
    await nextTick();
    await nextTick();
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);

    // Clear setter mock so we only count post-mount calls.
    setter.mockClear();

    // 2. While the replace is pending: simulate an external URL change
    //    (e.g., browser back) to v3. The fullPath watcher fires
    //    syncFromRoute, which is blocked by pendingUrlWrites > 0.
    route.query.q = "v3";
    route.fullPath = "/?q=v3";
    await nextTick();
    await nextTick();

    // Confirm the skip happened: setter has not yet been called with v3.
    expect(setter).not.toHaveBeenCalled();

    // 3. Drain: resolve the in-flight replace so pendingUrlWrites returns
    //    to 0. The fix should re-run syncFromRoute with the current route.
    resolveReplace();
    // Let the promise chain settle (await router.replace + finally + drain
    // callback).
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
    await nextTick();

    // The skipped sync should have been replayed and the store updated to
    // match the current URL value.
    expect(setter).toHaveBeenCalledWith("v3");
  });
});
