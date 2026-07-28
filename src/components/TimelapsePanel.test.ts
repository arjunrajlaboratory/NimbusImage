import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

// vi.mock factories hoist above every const, so shared state lives in
// vi.hoisted. Mirrors ConnectionList.test.ts's harness.
const h = vi.hoisted(() => ({
  setGrouping: vi.fn(),
  openAnnotationBrowserTab: vi.fn(),
  deleteAllTimelapseConnections: vi.fn(),
  main: {
    showTimelapseMode: true,
    timelapseModeWindow: 10,
    timelapseTags: [] as string[],
    showTimelapseLabels: true,
    timelapseTrackColoring: "track",
    timelapseColorSeed: 0,
    setTimelapseModeWindow: vi.fn(),
    setTimelapseTags: vi.fn(),
    setShowTimelapseLabels: vi.fn(),
    setTimelapseTrackColoring: vi.fn(),
    shuffleTimelapseColors: vi.fn(),
    openAnnotationBrowserTab: vi.fn(),
  } as any,
  connectionList: {
    trackCount: 0,
    setGrouping: vi.fn(),
  } as any,
}));

vi.mock("@/store", () => ({ default: h.main }));
vi.mock("@/store/annotation", () => ({
  default: {
    annotationConnections: [] as unknown[],
    annotationTags: [] as string[],
    deleteAllTimelapseConnections: h.deleteAllTimelapseConnections,
  },
}));
vi.mock("@/store/connectionList", () => ({ default: h.connectionList }));

import TimelapsePanel from "./TimelapsePanel.vue";
import annotationStore from "@/store/annotation";

function mountComponent() {
  return shallowMount(TimelapsePanel, {});
}

describe("TimelapsePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.main.showTimelapseMode = true;
    h.main.timelapseTrackColoring = "track";
    h.main.openAnnotationBrowserTab = vi.fn();
    h.connectionList.setGrouping = vi.fn();
    h.connectionList.trackCount = 0;
    (annotationStore as any).annotationConnections = [];
  });

  /**
   * The panel lives inside a `v-show` FloatingPalette, so it is mounted from
   * dataset load onward whether or not timelapse is ever switched on. Reading
   * `trackCount` ungated therefore ran a union-find over every connection at
   * load for every dataset, and again on every connection create/delete —
   * doubling work the draw path already does. Same rule as ConnectionList's
   * "does not read the scope getters while the tab is hidden".
   */
  it("does not read trackCount while timelapse mode is off", () => {
    let reads = 0;
    Object.defineProperty(h.connectionList, "trackCount", {
      configurable: true,
      get() {
        reads++;
        return 7;
      },
    });

    h.main.showTimelapseMode = false;
    const off = mountComponent();
    expect(reads).toBe(0);
    expect(off.vm.trackCount).toBe(0);
    off.unmount();

    h.main.showTimelapseMode = true;
    const on = mountComponent();
    expect(on.vm.trackCount).toBe(7);
    expect(reads).toBeGreaterThan(0);
    on.unmount();

    delete (h.connectionList as any).trackCount;
    h.connectionList.trackCount = 0;
  });

  // Two steps, and dropping either leaves the user somewhere they didn't ask
  // for: the tab without the grouping lands on the flat connection list, the
  // grouping without the tab changes nothing they can see.
  it("Show tracks sets track grouping AND opens the connections tab", () => {
    mountComponent().vm.showTracks();
    expect(h.connectionList.setGrouping).toHaveBeenCalledWith("track");
    expect(h.main.openAnnotationBrowserTab).toHaveBeenCalledWith("connections");
  });

  it("reports track and connection counts from the stores", () => {
    h.connectionList.trackCount = 12;
    (annotationStore as any).annotationConnections = new Array(48);
    const wrapper = mountComponent();
    expect(wrapper.vm.trackCount).toBe(12);
    expect(wrapper.vm.connectionCount).toBe(48);
  });

  it("delegates delete-all to the batched store action", async () => {
    await mountComponent().vm.deleteAll();
    expect(h.deleteAllTimelapseConnections).toHaveBeenCalledTimes(1);
  });
});
