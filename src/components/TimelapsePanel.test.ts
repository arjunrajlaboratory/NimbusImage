import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

// vi.mock factories hoist above every const, so shared state lives in
// vi.hoisted. Mirrors ConnectionList.test.ts's harness.
const h = vi.hoisted(() => ({
  setGrouping: vi.fn(),
  openAnnotationBrowserTab: vi.fn(),
  deleteAllTimelapseConnections: vi.fn(),
  main: {
    // Only the Object Browser routing lives in the main store now; the mode and
    // everything it configures moved to `@/store/timelapse`.
    isLoggedIn: true,
    openAnnotationBrowserTab: vi.fn(),
  } as any,
  timelapse: {
    showMode: true,
    modeWindow: 10,
    tags: [] as string[],
    showLabels: true,
    trackColoring: "track",
    colorSeed: 0,
    setModeWindow: vi.fn(),
    setTags: vi.fn(),
    setShowLabels: vi.fn(),
    setTrackColoring: vi.fn(),
    shuffleColors: vi.fn(),
  } as any,
  connectionList: {
    trackCount: 0,
    setGrouping: vi.fn(),
  } as any,
}));

vi.mock("@/store", () => ({ default: h.main }));
vi.mock("@/store/timelapse", () => ({ default: h.timelapse }));
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
import { TIMELAPSE_CONNECTION_TAG } from "@/store/constants";

function mountComponent() {
  return shallowMount(TimelapsePanel, {});
}

describe("TimelapsePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.timelapse.showMode = true;
    h.main.isLoggedIn = true;
    h.timelapse.trackColoring = "track";
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

    // The accessor MUST come back off in a finally. Without it, one failed
    // assertion here left a getter-only `trackCount` on the shared mock and the
    // next four tests all died on "Cannot set property trackCount" — four
    // failures reported for one cause.
    try {
      h.timelapse.showMode = false;
      const off = mountComponent();
      expect(reads).toBe(0);
      expect(off.vm.trackCount).toBe(0);
      off.unmount();

      h.timelapse.showMode = true;
      const on = mountComponent();
      expect(on.vm.trackCount).toBe(7);
      expect(reads).toBeGreaterThan(0);
      on.unmount();
    } finally {
      delete (h.connectionList as any).trackCount;
      h.connectionList.trackCount = 0;
    }
  });

  /**
   * The twin of the test above, and the reason that rule is worth stating twice:
   * `timelapseTaggedCount` shipped as an ungated O(N) filter over every
   * connection, right below the `trackCount` gate that exists for exactly this.
   * `v-show` keeps this component mounted from dataset load, so it ran once on
   * load and again on every connection create or delete.
   */
  it("does not scan connections for tagged links while the mode is off", () => {
    let reads = 0;
    const connections = [
      {
        id: "c1",
        parentId: "a",
        childId: "b",
        tags: [TIMELAPSE_CONNECTION_TAG],
      },
    ];
    Object.defineProperty(annotationStore, "annotationConnections", {
      configurable: true,
      get() {
        reads++;
        return connections;
      },
    });
    try {
      h.timelapse.showMode = false;
      const off = mountComponent();
      expect(off.vm.timelapseTaggedCount).toBe(0);
      const readsWhileOff = reads;

      h.timelapse.showMode = true;
      const on = mountComponent();
      expect(on.vm.timelapseTaggedCount).toBe(1);
      // The gate has to skip the scan, not just the arithmetic: reading the
      // array at all is the cost being avoided.
      expect(reads).toBeGreaterThan(readsWhileOff);
    } finally {
      delete (annotationStore as any).annotationConnections;
      (annotationStore as any).annotationConnections = [];
    }
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

  /**
   * The readout counts every connection (the timelapse view draws any connection
   * whose endpoints are both displayed, tag or no tag), but
   * `deleteAllTimelapseConnections` only deletes the tagged subset. Guarding the
   * button on the total left it enabled on a dataset whose connections are all
   * hand-made or from Connect-to-nearest, where the click deleted nothing and
   * said nothing. The two counts must stay separate.
   */
  it("enables delete-all only when tagged connections exist", () => {
    (annotationStore as any).annotationConnections = [
      { id: "c1", parentId: "a", childId: "b", tags: ["nucleus"] },
      { id: "c2", parentId: "b", childId: "c", tags: [] },
    ];
    const untagged = mountComponent();
    expect(untagged.vm.connectionCount).toBe(2);
    expect(untagged.vm.timelapseTaggedCount).toBe(0);
    // The v-btn stub serialises the prop, so compare the string: `toBeTruthy`
    // would pass on "false" and prove nothing.
    expect(untagged.find(".delete-btn").attributes("disabled")).toBe("true");

    (annotationStore as any).annotationConnections = [
      { id: "c1", parentId: "a", childId: "b", tags: ["nucleus"] },
      {
        id: "c2",
        parentId: "b",
        childId: "c",
        tags: [TIMELAPSE_CONNECTION_TAG],
      },
    ];
    const tagged = mountComponent();
    expect(tagged.vm.connectionCount).toBe(2);
    expect(tagged.vm.timelapseTaggedCount).toBe(1);
    expect(tagged.find(".delete-btn").attributes("disabled")).toBe("false");
  });

  /**
   * The other half of the same shape: `deleteAllTimelapseConnections` returns
   * immediately when not logged in (`src/store/annotation.ts:1141`), so on a
   * public dataset viewed while signed out the button was enabled and the click
   * silently did nothing. Not a security check — the backend owns that — just not
   * offering an action that provably no-ops, which the Connection List's delete
   * controls already did.
   */
  it("disables delete-all for a signed-out viewer with tagged connections", () => {
    (annotationStore as any).annotationConnections = [
      {
        id: "c1",
        parentId: "a",
        childId: "b",
        tags: [TIMELAPSE_CONNECTION_TAG],
      },
    ];
    h.main.isLoggedIn = false;
    const signedOut = mountComponent();
    // The tagged count is non-zero, so ONLY the login guard can be disabling it.
    expect(signedOut.vm.timelapseTaggedCount).toBe(1);
    expect(signedOut.find(".delete-btn").attributes("disabled")).toBe("true");

    h.main.isLoggedIn = true;
    expect(mountComponent().find(".delete-btn").attributes("disabled")).toBe(
      "false",
    );
  });
});
