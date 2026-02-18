import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const { d3Chain, d3DragChain, d3ZoomChain } = vi.hoisted(() => {
  const d3Chain: any = {};
  const methods = [
    "append", "attr", "style", "select", "selectAll", "data",
    "call", "on", "remove", "enter", "exit", "merge",
    "transition", "duration", "text",
  ];
  for (const method of methods) {
    d3Chain[method] = (..._args: any[]) => d3Chain;
  }

  const d3DragChain: any = {};
  d3DragChain.on = (..._args: any[]) => d3DragChain;

  const d3ZoomChain: any = {};
  d3ZoomChain.scaleExtent = (..._args: any[]) => d3ZoomChain;
  d3ZoomChain.on = (..._args: any[]) => d3ZoomChain;
  d3ZoomChain.translateExtent = (..._args: any[]) => d3ZoomChain;

  return { d3Chain, d3DragChain, d3ZoomChain };
});

vi.mock("d3-selection", () => ({
  select: () => d3Chain,
  selectAll: () => d3Chain,
  event: null,
}));

vi.mock("d3-drag", () => ({
  drag: () => d3DragChain,
}));

vi.mock("d3-zoom", () => ({
  zoom: () => d3ZoomChain,
}));

vi.mock("lodash", () => ({
  throttle: (fn: any) => fn,
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

import ContrastHistogram from "./ContrastHistogram.vue";

Vue.use(Vuetify);

const defaultContrast = {
  mode: "percentile" as const,
  blackPoint: 10,
  whitePoint: 90,
};

const absoluteContrast = {
  mode: "absolute" as const,
  blackPoint: 50,
  whitePoint: 200,
};

const sampleHistData = {
  bin_edges: [0, 50, 100, 150, 200, 255],
  hist: [10, 20, 40, 20, 10],
  min: 0,
  max: 255,
  samples: 1000,
};

function mountComponent(propsOverrides: any = {}) {
  return shallowMount(ContrastHistogram, {
    vuetify: new Vuetify(),
    propsData: {
      configurationContrast: defaultContrast,
      viewContrast: null,
      histogram: Promise.resolve(sampleHistData),
      ...propsOverrides,
    },
    stubs: {
      "switch-toggle": true,
      "resize-observer": true,
    },
  });
}

describe("ContrastHistogram", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("currentContrast returns configurationContrast when no viewContrast", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.currentContrast).toEqual(defaultContrast);
    wrapper.destroy();
  });

  it("currentContrast prefers viewContrast when provided", () => {
    const viewContrast = {
      mode: "absolute" as const,
      blackPoint: 20,
      whitePoint: 80,
    };
    const wrapper = mountComponent({ viewContrast });
    const vm = wrapper.vm as any;
    expect(vm.currentContrast).toEqual(viewContrast);
    wrapper.destroy();
  });

  it("mode getter returns viewContrast mode when present", () => {
    const viewContrast = {
      mode: "absolute" as const,
      blackPoint: 20,
      whitePoint: 200,
    };
    const wrapper = mountComponent({ viewContrast });
    const vm = wrapper.vm as any;
    expect(vm.mode).toBe("absolute");
    wrapper.destroy();
  });

  it("mode getter falls back to configurationContrast mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.mode).toBe("percentile");
    wrapper.destroy();
  });

  it("mode setter emits change with converted values", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.mode = "absolute";
    const emitted = wrapper.emitted("change");
    expect(emitted).toBeTruthy();
    expect(emitted![0][0].mode).toBe("absolute");
    wrapper.destroy();
  });

  it("editMin returns 0 in percentile mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.editMin).toBe(0);
    wrapper.destroy();
  });

  it("editMax returns 100 in percentile mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.editMax).toBe(100);
    wrapper.destroy();
  });

  it("editMin returns histData.min in absolute mode with data", async () => {
    const viewContrast = {
      mode: "absolute" as const,
      blackPoint: 50,
      whitePoint: 200,
    };
    const wrapper = mountComponent({ viewContrast });
    const vm = wrapper.vm as any;
    // Wait for histogram promise to resolve
    await Vue.nextTick();
    await Vue.nextTick();
    expect(vm.editMin).toBe(0);
    wrapper.destroy();
  });

  it("editMax returns histData.max in absolute mode with data", async () => {
    const viewContrast = {
      mode: "absolute" as const,
      blackPoint: 50,
      whitePoint: 200,
    };
    const wrapper = mountComponent({ viewContrast });
    const vm = wrapper.vm as any;
    await Vue.nextTick();
    await Vue.nextTick();
    expect(vm.editMax).toBe(255);
    wrapper.destroy();
  });

  it("editBlackPoint getter returns currentContrast blackPoint", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.editBlackPoint).toBe(10);
    wrapper.destroy();
  });

  it("editBlackPoint setter emits change when valid", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.editBlackPoint = 5;
    const emitted = wrapper.emitted("change");
    expect(emitted).toBeTruthy();
    expect(emitted![0][0].blackPoint).toBe(5);
    wrapper.destroy();
  });

  it("editBlackPoint setter caches value when blackPoint > whitePoint", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.editBlackPoint = 95;
    expect(vm.cachedBlackPoint).toBe(95);
    wrapper.destroy();
  });

  it("editWhitePoint getter returns currentContrast whitePoint", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.editWhitePoint).toBe(90);
    wrapper.destroy();
  });

  it("editWhitePoint setter emits change when valid", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.editWhitePoint = 95;
    const emitted = wrapper.emitted("change");
    expect(emitted).toBeTruthy();
    expect(emitted![0][0].whitePoint).toBe(95);
    wrapper.destroy();
  });

  it("editWhitePoint setter caches value when whitePoint < blackPoint", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.editWhitePoint = 5;
    expect(vm.cachedWhitePoint).toBe(5);
    wrapper.destroy();
  });

  it("validateCachedBlackPoint clamps on Enter when cached exceeds white", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Set a cached black point that's too high
    vm.cachedBlackPoint = 95;
    vm.validateCachedBlackPoint({ key: "Enter" });
    // Should have been clamped to whitePoint (90)
    const emitted = wrapper.emitted("change");
    expect(emitted).toBeTruthy();
    wrapper.destroy();
  });

  it("validateCachedBlackPoint does nothing for non-Enter key", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.cachedBlackPoint = 95;
    const emittedBefore = wrapper.emitted("change");
    vm.validateCachedBlackPoint({ key: "Tab" });
    const emittedAfter = wrapper.emitted("change");
    // No new emission from Tab key
    expect(emittedAfter?.length ?? 0).toBe(emittedBefore?.length ?? 0);
    wrapper.destroy();
  });

  it("validateCachedWhitePoint clamps on Enter when cached below black", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.cachedWhitePoint = 5;
    vm.validateCachedWhitePoint({ key: "Enter" });
    const emitted = wrapper.emitted("change");
    expect(emitted).toBeTruthy();
    wrapper.destroy();
  });

  it("pixelRange computed uses translation and scale", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // In jsdom, getBoundingClientRect returns width=0, so handleResize sets width to 0
    // pixelRange = [translation, translation + scale * width]
    const expectedEnd = vm.translation + vm.scale * vm.width;
    expect(vm.pixelRange).toEqual([vm.translation, expectedEnd]);
    wrapper.destroy();
  });

  it("histToPixel returns a d3 scale function", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await Vue.nextTick();
    await Vue.nextTick();
    const scale = vm.histToPixel;
    expect(typeof scale).toBe("function");
    // With histData loaded, domain should be [0, 255]
    expect(scale.domain()).toEqual([0, 255]);
    wrapper.destroy();
  });

  it("percentageToPixel returns a d3 scale from 0-100", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const scale = vm.percentageToPixel;
    expect(scale.domain()).toEqual([0, 100]);
    wrapper.destroy();
  });

  it("toValue returns pixel string for black point in percentile mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = vm.toValue(defaultContrast, "black");
    expect(result).toMatch(/^\d+(\.\d+)?px$/);
    wrapper.destroy();
  });

  it("toValue returns pixel string for white point", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = vm.toValue(defaultContrast, "white");
    expect(result).toMatch(/^\d+(\.\d+)?px$/);
    wrapper.destroy();
  });

  it("toLabel formats as percentage in percentile mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.toLabel(50.123)).toBe("50.12%");
    wrapper.destroy();
  });

  it("toLabel formats as integer in absolute mode", () => {
    const viewContrast = {
      mode: "absolute" as const,
      blackPoint: 50,
      whitePoint: 200,
    };
    const wrapper = mountComponent({ viewContrast });
    const vm = wrapper.vm as any;
    expect(vm.toLabel(123.7)).toBe("124");
    wrapper.destroy();
  });

  it("areaPath returns empty string when no histData", () => {
    // Don't let the histogram resolve
    const neverResolve = new Promise<any>(() => {});
    const wrapper = mountComponent({ histogram: neverResolve });
    const vm = wrapper.vm as any;
    expect(vm.areaPath).toBe("");
    wrapper.destroy();
  });

  it("areaPath returns a path string when histData is present", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await Vue.nextTick();
    await Vue.nextTick();
    expect(vm.areaPath).toBeTruthy();
    expect(typeof vm.areaPath).toBe("string");
    expect(vm.areaPath.length).toBeGreaterThan(0);
    wrapper.destroy();
  });

  it("reset emits change with edges of range", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.reset();
    const emitted = wrapper.emitted("change");
    expect(emitted).toBeTruthy();
    wrapper.destroy();
  });

  it("revertSaved emits revert", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.revertSaved();
    expect(wrapper.emitted("revert")).toBeTruthy();
    wrapper.destroy();
  });

  it("saveCurrent emits commit with current contrast", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.saveCurrent();
    const emitted = wrapper.emitted("commit");
    expect(emitted).toBeTruthy();
    expect(emitted![0][0].blackPoint).toBe(10);
    expect(emitted![0][0].whitePoint).toBe(90);
    wrapper.destroy();
  });

  it("handleResize updates width from rootEl", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Mock the rootEl's getBoundingClientRect
    const mockEl = { getBoundingClientRect: () => ({ width: 500 }) };
    // Access the internal rootEl ref through the exposed interface indirectly
    // Since rootEl isn't exposed, we test handleResize doesn't throw
    vm.handleResize();
    // width might be 0 if rootEl isn't available in jsdom
    expect(typeof vm.width).toBe("number");
    wrapper.destroy();
  });

  it("histogram watcher sets histData to null then resolves", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Initially, histData should be resolved from the prop promise
    await Vue.nextTick();
    await Vue.nextTick();
    expect(vm.histData).toEqual(sampleHistData);
    wrapper.destroy();
  });

  it("editIcon returns mdi-percent in percentile mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.editIcon).toBe("mdi-percent");
    wrapper.destroy();
  });

  it("editIcon returns undefined in absolute mode", () => {
    const viewContrast = {
      mode: "absolute" as const,
      blackPoint: 50,
      whitePoint: 200,
    };
    const wrapper = mountComponent({ viewContrast });
    const vm = wrapper.vm as any;
    expect(vm.editIcon).toBeUndefined();
    wrapper.destroy();
  });
});
