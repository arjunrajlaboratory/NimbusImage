import { config } from "@vue/test-utils";
import { createVuetify } from "vuetify";
import { reactive } from "vue";
import { vi } from "vitest";

// jsdom's CSS parser cannot handle Vuetify 4's stylesheet (cascade layers,
// nested selectors), so EVERY component mount logs "Could not parse CSS
// stylesheet" followed by the entire sheet — about 5,500 lines, ~150KB, per
// mount. With ~2,000 mounts across the suite the reporter buffers hundreds of
// megabytes of it and the run dies with a heap OOM once the suite grows a
// little. The error tells us nothing (styles are irrelevant to these tests), so
// drop exactly this one message and let everything else through.
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const [first] = args;
  const text =
    first instanceof Error ? first.message : typeof first === "string" ? first : "";
  if (text.includes("Could not parse CSS stylesheet")) {
    return;
  }
  originalConsoleError(...args);
};

// Polyfill visualViewport for jsdom (required by Vuetify 3 overlay components)
if (typeof globalThis.visualViewport === "undefined") {
  (globalThis as any).visualViewport = {
    width: 1024,
    height: 768,
    offsetLeft: 0,
    offsetTop: 0,
    pageLeft: 0,
    pageTop: 0,
    scale: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

// Polyfill requestIdleCallback for jsdom (used by async spatial index build)
// Returns an ID but never fires the callback — spatial index stays null in tests
// and the fallback linear scan is used instead.
let nextIdleId = 1;
if (typeof globalThis.requestIdleCallback === "undefined") {
  (globalThis as any).requestIdleCallback = () => nextIdleId++;
  (globalThis as any).cancelIdleCallback = () => {};
}

// Polyfill ResizeObserver for jsdom (required by Vuetify 3 components)
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class ResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  };
}

const vuetify = createVuetify({
  defaults: {
    VBtn: { variant: "tonal" },
    VCard: { variant: "flat" },
    VAlert: { variant: "tonal" },
  },
});

config.global.plugins = [vuetify];
config.global.directives = {
  mousetrap: {},
  "tour-trigger": {},
  tooltip: {},
  description: {},
};

// Mock vue-router composables globally.
// Uses the real vue-router inject keys so useRoute()/useRouter() work via provide/inject.
// Tests override route/router via global.provide with routeLocationKey/routerKey.
vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-router")>();
  const { inject } = await vi.importActual<typeof import("vue")>("vue");
  return {
    ...actual,
    useRoute: () => inject(actual.routeLocationKey)!,
    useRouter: () => inject(actual.routerKey)!,
    createRouter: vi.fn(),
    createWebHistory: vi.fn(),
    createMemoryHistory: vi.fn(),
    onBeforeRouteLeave: vi.fn(),
    onBeforeRouteUpdate: vi.fn(),
    RouterLink: { template: "<a><slot /></a>" },
    RouterView: { template: "<div />" },
  };
});

// Import the injection keys for default provides (after the mock so they resolve)
import { routeLocationKey, routerKey } from "vue-router";

// Default route and router provided via inject keys.
// Tests can override by passing global.provide with routeLocationKey/routerKey.
const defaultRoute = reactive({
  name: "root" as string | symbol | null | undefined,
  params: {} as Record<string, any>,
  query: {} as Record<string, any>,
  path: "/",
  hash: "",
  fullPath: "/",
  matched: [] as any[],
  meta: {} as Record<string, any>,
  redirectedFrom: undefined as any,
});

const defaultRouter = {
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
  currentRoute: defaultRoute,
};

config.global.provide = {
  tourManager: {
    startTour: () => Promise.resolve(),
    loadAllTours: () => Promise.resolve({}),
    isTourActive: () => false,
    nextStep: () => Promise.resolve(),
  },
  [routeLocationKey as symbol]: defaultRoute,
  [routerKey as symbol]: defaultRouter,
};
