import { describe, it, expect, vi, beforeEach } from "vitest";

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

describe("useRouteMapper", () => {
  let mockRouter: any;
  let mockRoute: any;

  beforeEach(() => {
    vi.resetModules();
    mockRouter = {
      replace: vi.fn().mockResolvedValue(undefined),
    };
    mockRoute = {
      params: {},
      query: {},
    };
  });

  async function setup(
    paramsMapper: Record<string, any>,
    queryMapper: Record<string, any> = {},
    routeParams: Record<string, string> = {},
    routeQuery: Record<string, string> = {},
  ) {
    mockRoute.params = routeParams;
    mockRoute.query = routeQuery;

    const Vue = (await import("vue")).default;
    const Vuetify = (await import("vuetify")).default;
    Vue.use(Vuetify);

    const { shallowMount } = await import("@vue/test-utils");
    const { useRouteMapper } = await import("./useRouteMapper");

    const TestComponent = Vue.extend({
      template: "<div />",
      setup() {
        useRouteMapper(paramsMapper, queryMapper);
      },
    });

    const wrapper = shallowMount(TestComponent, {
      vuetify: new Vuetify(),
      mocks: {
        $router: mockRouter,
        $route: mockRoute,
      },
    });

    // Wait for onMounted sync to complete
    await Vue.nextTick();
    await Vue.nextTick();

    return { wrapper, Vue };
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
});
