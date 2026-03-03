/**
 * Test helpers for vue-router mocking.
 *
 * Usage in test files:
 *   import { routeProvider, routerProvider } from "@/test/helpers";
 *
 *   shallowMount(MyComponent, {
 *     global: {
 *       provide: {
 *         ...routeProvider({ name: "datasetview", params: { id: "1" } }),
 *         ...routerProvider(mockRouter),
 *       },
 *     },
 *   });
 */
import { reactive } from "vue";
import { routeLocationKey, routerKey } from "vue-router";
import { vi } from "vitest";

/**
 * Creates a provide object for injecting a mock route into components
 * that use useRoute(). Merges with sensible defaults.
 */
export function routeProvider(
  overrides: Record<string, any> = {},
): Record<symbol, any> {
  return {
    [routeLocationKey as symbol]: reactive({
      name: "root",
      params: {},
      query: {},
      path: "/",
      hash: "",
      fullPath: "/",
      matched: [],
      meta: {},
      redirectedFrom: undefined,
      ...overrides,
    }),
  };
}

/**
 * Creates a provide object for injecting a mock router into components
 * that use useRouter().
 */
export function routerProvider(
  router?: Record<string, any>,
): Record<symbol, any> {
  return {
    [routerKey as symbol]: router ?? {
      push: vi.fn(),
      replace: vi.fn(),
      go: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      beforeEach: vi.fn(),
      afterEach: vi.fn(),
      addRoute: vi.fn(),
      removeRoute: vi.fn(),
      hasRoute: vi.fn(),
      getRoutes: vi.fn(() => []),
      resolve: vi.fn(),
      isReady: vi.fn(() => Promise.resolve()),
      options: { history: {} },
      install: vi.fn(),
    },
  };
}
