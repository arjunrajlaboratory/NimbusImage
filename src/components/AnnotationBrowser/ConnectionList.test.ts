import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import {
  AnnotationShape,
  IAnnotation,
  IAnnotationConnection,
} from "@/store/model";

// vi.mock factories are hoisted above every const, so the shared state has to
// be created inside vi.hoisted. The state is a plain object (not reactive) —
// each test sets it up and mounts fresh rather than driving updates post-mount.
const h = vi.hoisted(() => ({
  setSelected: vi.fn(),
  goToConnection: vi.fn(),
  goToTrack: vi.fn(),
  deleteConnectionsById: vi.fn(),
  deleteSelectedConnections: vi.fn(),
  deleteSelectedInScopeConnections: vi.fn(),
  connectSelectedAnnotations: vi.fn(),
  setSelectedConnectionIds: vi.fn(),
  state: {
    scope: "all",
    grouping: "flat",
    page: 1,
    itemsPerPage: 50,
    hoveredConnectionId: null as string | null,
    selectedConnectionIds: new Set<string>(),
    selectedExistingConnectionIds: [] as string[],
    scopedConnections: [] as any[],
    connectionRows: [] as any[],
    trackRows: [] as any[],
    canConnectSelected: false,
    connectSelectedTimeTies: [] as number[],
    // Must read the real selection: selectAllValue counts the selected rows
    // that are actually visible, so a stub returning false would make the
    // header checkbox look permanently unchecked.
    isConnectionSelected(id: string) {
      return this.selectedConnectionIds.has(id);
    },
    isTrackExpanded: () => false,
    // Replaced by setRows() with a resolver over the annotations it was given.
    // A stub resolving everything would hide the dangling-endpoint filter.
    resolveAnnotation: () => undefined as any,
    setScope: vi.fn(),
    setGrouping: vi.fn(),
    setPage: vi.fn(),
    setItemsPerPage: vi.fn(),
    setHoveredConnectionId: vi.fn(),
    toggleConnectionSelection: vi.fn(),
    toggleTrackExpanded: vi.fn(),
  } as any,
}));

vi.mock("@/store", () => ({ default: { isLoggedIn: true } }));

// Mutable (and reset in beforeEach) because the swatch gate depends on the
// timelapse mode as well as the colouring option, and both need to be driven.
const timelapseStore = vi.hoisted(() => ({
  showMode: true,
  trackColoring: "track" as string,
  colorSeed: 0,
}));

vi.mock("@/store/timelapse", () => ({ default: timelapseStore }));

vi.mock("@/store/annotation", () => ({
  default: {
    setSelected: h.setSelected,
    selectedAnnotationIds: new Set<string>(),
  },
}));

vi.mock("@/utils/annotationNavigation", () => ({
  goToConnection: h.goToConnection,
  goToTrack: h.goToTrack,
}));

vi.mock("@/store/connectionList", () => {
  h.state.setSelectedConnectionIds = h.setSelectedConnectionIds;
  h.state.deleteConnectionsById = h.deleteConnectionsById;
  h.state.deleteSelectedConnections = h.deleteSelectedConnections;
  h.state.deleteSelectedInScopeConnections = h.deleteSelectedInScopeConnections;
  h.state.connectSelectedAnnotations = h.connectSelectedAnnotations;
  return {
    default: h.state,
    CONNECTION_SCOPE_LABELS: {
      all: "All connections",
      location: "Current location",
      selected: "Selected objects",
      filtered: "Objects passing filters",
    },
  };
});

import ConnectionList from "./ConnectionList.vue";
import { buildConnectionRows, trackColor } from "@/utils/connections";

function makeConnection(
  id: string,
  parentId: string,
  childId: string,
): IAnnotationConnection {
  return { id, parentId, childId, tags: [], label: "", datasetId: "ds" };
}

function makeAnnotation(id: string, time: number): IAnnotation {
  return {
    id,
    name: null,
    tags: [],
    shape: AnnotationShape.Point,
    channel: 0,
    location: { XY: 0, Z: 0, Time: time },
    coordinates: [{ x: 0, y: 0 }],
    datasetId: "ds",
    color: null,
  };
}

function setRows(connections: IAnnotationConnection[], known: IAnnotation[]) {
  const byId = new Map(known.map((a) => [a.id, a]));
  h.state.scopedConnections = connections;
  h.state.connectionRows = buildConnectionRows(connections, (id) =>
    byId.get(id),
  );
  // Same source of truth the rows were built from, so an endpoint absent from
  // `known` is dangling for both.
  h.state.resolveAnnotation = (id: string) => byId.get(id);
}

// Default to the visible tab: rows are gated on isActive, so a default-false
// mount would leave every list assertion looking at an empty table.
function mountComponent(isActive = true) {
  return shallowMount(ConnectionList, { props: { isActive } });
}

beforeEach(() => {
  vi.clearAllMocks();
  timelapseStore.showMode = true;
  timelapseStore.trackColoring = "track";
  timelapseStore.colorSeed = 0;
  h.state.scope = "all";
  h.state.grouping = "flat";
  h.state.selectedConnectionIds = new Set();
  h.state.canConnectSelected = false;
  h.state.connectSelectedTimeTies = [];
  h.state.selectedInScopeConnectionIds = [];
  h.state.selectedExistingConnectionIds = [];
  h.state.lastConnectSkippedAsDuplicate = false;
  h.state.hoveredConnectionId = null;
  h.state.itemsPerPage = 50;
  h.state.trackRows = [];
  h.state.isTrackExpanded = () => false;
  h.connectSelectedAnnotations.mockResolvedValue([]);
  setRows([], []);
});

describe("ConnectionList", () => {
  it("reports the scoped connection count", () => {
    setRows(
      [makeConnection("c1", "a", "b")],
      [makeAnnotation("a", 0), makeAnnotation("b", 1)],
    );
    expect(mountComponent().vm.scopedCount).toBe(1);
  });

  it("colors a scoped track from its dataset-wide color key", () => {
    const wrapper = mountComponent();
    expect(
      wrapper.vm.swatchColor({
        id: "b",
        colorKey: "a",
        annotationIds: ["b", "c"],
        annotationCount: 2,
        timeRange: { start: 1, end: 2 },
        rows: [],
      }),
    ).toBe(trackColor("a", 0));
  });

  /**
   * The swatch promises "this is the colour that track is drawn in", and
   * `trackColor` is only reached from the timelapse draw path — so with the mode
   * off it names a colour nothing on the canvas is using. Measured on a real
   * dataset: 248 swatches in 248 hues against zero drawn connection features.
   * Gating on the colouring option alone also made them unturnoffable, since
   * that toggle lives in the Timelapse palette, which *is* the mode.
   */
  it("hides the track swatches while timelapse mode is off", () => {
    timelapseStore.showMode = true;
    expect(mountComponent().vm.showTrackSwatches).toBe(true);

    timelapseStore.showMode = false;
    expect(mountComponent().vm.showTrackSwatches).toBe(false);
  });

  it("still hides them in the mode when colouring is uniform", () => {
    timelapseStore.trackColoring = "uniform";
    expect(mountComponent().vm.showTrackSwatches).toBe(false);
  });

  // Regression: building rows depends on hydration, so it is invalidated by
  // every pan. Reading the getter while the tab is hidden made a user who
  // opened the tab once pay to rebuild every row on every pan for the rest of
  // the session, with none of them rendered.
  it("does not read the row getters while the tab is hidden", () => {
    const conns = [makeConnection("c1", "a", "b")];
    const anns = [makeAnnotation("a", 0), makeAnnotation("b", 1)];
    setRows(conns, anns);

    let rowReads = 0;
    let trackReads = 0;
    Object.defineProperty(h.state, "connectionRows", {
      configurable: true,
      get() {
        rowReads++;
        return buildConnectionRows(conns, (id) =>
          anns.find((a) => a.id === id),
        );
      },
    });
    Object.defineProperty(h.state, "trackRows", {
      configurable: true,
      get() {
        trackReads++;
        return [];
      },
    });

    const hidden = mountComponent(false);
    expect(rowReads).toBe(0);
    expect(trackReads).toBe(0);
    expect((hidden.vm as any).rows).toEqual([]);
    hidden.unmount();

    mountComponent(true);
    expect(rowReads).toBeGreaterThan(0);

    delete (h.state as any).connectionRows;
    delete (h.state as any).trackRows;
    h.state.connectionRows = [];
    h.state.trackRows = [];
  });

  // Regression: gating only the row getters left scopedCount consuming
  // scopedConnections, whose scopeAnnotationIds scans annotationsForIteration
  // for the dynamic scopes. On a 700K-object dataset that is a full scan on
  // every XY/Z/Time scrub, from a tab the user is not even looking at.
  it("does not read the scope getters while the tab is hidden", () => {
    let scopeReads = 0;
    Object.defineProperty(h.state, "scopedConnections", {
      configurable: true,
      get() {
        scopeReads++;
        return [];
      },
    });
    Object.defineProperty(h.state, "selectedInScopeConnectionIds", {
      configurable: true,
      get() {
        scopeReads++;
        return [];
      },
    });

    mountComponent(false);
    expect(scopeReads).toBe(0);

    mountComponent(true);
    expect(scopeReads).toBeGreaterThan(0);

    delete (h.state as any).scopedConnections;
    delete (h.state as any).selectedInScopeConnectionIds;
    h.state.scopedConnections = [];
    h.state.selectedInScopeConnectionIds = [];
  });

  it("explains an empty list differently for each scope", () => {
    expect(mountComponent().vm.emptyMessage).toContain("no connections");

    h.state.scope = "selected";
    expect(mountComponent().vm.emptyMessage).toContain("selected objects");

    h.state.scope = "location";
    expect(mountComponent().vm.emptyMessage).toContain("current location");

    h.state.scope = "filtered";
    expect(mountComponent().vm.emptyMessage).toContain("filters");
  });

  // A row click navigates and highlights; the checkbox is what selects. Mirrors
  // the Objects tab, and avoids silently arming the bulk delete.
  it("navigates and highlights without selecting", () => {
    setRows(
      [makeConnection("c1", "a", "b")],
      [makeAnnotation("a", 0), makeAnnotation("b", 1)],
    );
    const wrapper = mountComponent();
    wrapper.vm.navigateToConnection(wrapper.vm.rows[0]);

    expect(h.state.setHoveredConnectionId).toHaveBeenCalledWith("c1");
    expect(h.setSelectedConnectionIds).not.toHaveBeenCalled();
    expect(h.setSelected).not.toHaveBeenCalled();
    // Both endpoints are handed to the navigator: a connection is only drawn
    // when both are displayed, so it must frame the pair, not one endpoint.
    expect(h.goToConnection).toHaveBeenCalledWith("a", "b");
  });

  it("still navigates when one endpoint is dangling", () => {
    setRows([makeConnection("c1", "a", "gone")], [makeAnnotation("a", 0)]);
    const wrapper = mountComponent();
    wrapper.vm.navigateToConnection(wrapper.vm.rows[0]);

    // Delegated with both ids — goToConnection resolves what it can and
    // degrades to a single-endpoint navigate (covered in its own tests).
    expect(h.goToConnection).toHaveBeenCalledWith("a", "gone");
  });

  it("does not navigate when both endpoints are missing", () => {
    setRows([makeConnection("c1", "gone1", "gone2")], []);
    const wrapper = mountComponent();
    wrapper.vm.navigateToConnection(wrapper.vm.rows[0]);

    expect(h.goToConnection).not.toHaveBeenCalled();
    // Still highlighted, so the dangling row is findable and deletable.
    expect(h.state.setHoveredConnectionId).toHaveBeenCalledWith("c1");
  });

  // A viewer click only sets the selected id; without this the highlighted link
  // could sit on any page with nothing indicating where.
  it("pages to the selected connection so a viewer click is findable", async () => {
    const conns = Array.from({ length: 120 }, (_, i) =>
      makeConnection(`c${i}`, `a${i}`, `b${i}`),
    );
    const anns = conns.flatMap((c, i) => [
      makeAnnotation(c.parentId, i),
      makeAnnotation(c.childId, i),
    ]);
    setRows(conns, anns);
    h.state.itemsPerPage = 50;
    const wrapper = mountComponent();

    // Index 60 → page 2 at 50 rows per page.
    await wrapper.vm.revealConnection("c60");
    expect(h.state.setPage).toHaveBeenLastCalledWith(2);

    await wrapper.vm.revealConnection("c119");
    expect(h.state.setPage).toHaveBeenLastCalledWith(3);

    // Already on the right page → no redundant page write.
    h.state.page = 1;
    h.state.setPage.mockClear();
    await wrapper.vm.revealConnection("c0");
    expect(h.state.setPage).not.toHaveBeenCalled();
  });

  // The tab mounts lazily and is only hidden (not unmounted) afterwards, so a
  // selection made while it was closed never reaches the selection watcher and
  // one made while hidden cannot scroll. Becoming active has to retry.
  it("reveals the current selection when the tab becomes active", async () => {
    const conns = Array.from({ length: 120 }, (_, i) =>
      makeConnection(`c${i}`, `a${i}`, `b${i}`),
    );
    setRows(
      conns,
      conns.flatMap((c, i) => [
        makeAnnotation(c.parentId, i),
        makeAnnotation(c.childId, i),
      ]),
    );
    h.state.selectedConnectionIds = new Set(["c60"]);
    h.state.selectedExistingConnectionIds = ["c60"];
    h.state.page = 1;

    // Mounted inactive: nothing revealed yet.
    const wrapper = shallowMount(ConnectionList, {
      props: { isActive: false },
    });
    await wrapper.vm.$nextTick();
    expect(h.state.setPage).not.toHaveBeenCalled();

    // Tab becomes visible → the pending selection is paged to.
    await wrapper.setProps({ isActive: true });
    expect(h.state.setPage).toHaveBeenCalledWith(2);
  });

  // A plain viewer click only HIGHLIGHTS, so reveal has to react to hover as
  // well as selection — otherwise clicking a line highlights a row on another
  // page with nothing indicating where it went.
  it("reveals on hover, not only on selection", async () => {
    const conns = Array.from({ length: 120 }, (_, i) =>
      makeConnection(`c${i}`, `a${i}`, `b${i}`),
    );
    setRows(
      conns,
      conns.flatMap((c, i) => [
        makeAnnotation(c.parentId, i),
        makeAnnotation(c.childId, i),
      ]),
    );
    h.state.selectedConnectionIds = new Set();
    h.state.hoveredConnectionId = null;
    h.state.page = 1;

    const wrapper = shallowMount(ConnectionList, { props: { isActive: true } });
    await wrapper.vm.$nextTick();
    h.state.setPage.mockClear();

    // Hover a row on page 2 with nothing selected. The shared mock state is
    // intentionally non-reactive in this file, so drive the reveal directly —
    // this pins the hover BRANCH; the watcher's source list is covered by the
    // isActive test below.
    h.state.hoveredConnectionId = "c60";
    await (wrapper.vm as any).revealCurrentSelection();
    expect(h.state.setPage).toHaveBeenCalledWith(2);
  });

  // Regression: selection deliberately keeps ids for connections deleted
  // through other paths (existence is derived, not pruned). If the reveal
  // priority looked at the RAW selection, one externally deleted selected
  // connection blocked hover-based reveal permanently — every later click
  // highlighted a row the list would never page to.
  it("ignores a deleted selection when revealing on hover", async () => {
    const conns = Array.from({ length: 120 }, (_, i) =>
      makeConnection(`c${i}`, `a${i}`, `b${i}`),
    );
    setRows(
      conns,
      conns.flatMap((c, i) => [
        makeAnnotation(c.parentId, i),
        makeAnnotation(c.childId, i),
      ]),
    );
    // Selected, but the connection itself is gone.
    h.state.selectedConnectionIds = new Set(["deleted-elsewhere"]);
    h.state.selectedExistingConnectionIds = [];
    h.state.hoveredConnectionId = "c60"; // page 2
    const wrapper = mountComponent();
    h.state.setPage.mockClear();

    await (wrapper.vm as any).revealCurrentSelection();
    expect(h.state.setPage).toHaveBeenCalledWith(2);
  });

  it("prefers the selection over the hover when both are set", async () => {
    const conns = Array.from({ length: 120 }, (_, i) =>
      makeConnection(`c${i}`, `a${i}`, `b${i}`),
    );
    setRows(
      conns,
      conns.flatMap((c, i) => [
        makeAnnotation(c.parentId, i),
        makeAnnotation(c.childId, i),
      ]),
    );
    h.state.selectedConnectionIds = new Set(["c110"]); // page 3
    h.state.selectedExistingConnectionIds = ["c110"];
    h.state.hoveredConnectionId = "c10"; // page 1
    const wrapper = shallowMount(ConnectionList, { props: { isActive: true } });
    h.state.setPage.mockClear();

    await (wrapper.vm as any).revealCurrentSelection();
    expect(h.state.setPage).toHaveBeenCalledWith(3);
  });

  it("expands the containing track when revealing in track mode", async () => {
    setRows(
      [makeConnection("c1", "a", "b")],
      [makeAnnotation("a", 0), makeAnnotation("b", 1)],
    );
    h.state.grouping = "track";
    h.state.trackRows = [
      {
        id: "a",
        colorKey: "a",
        annotationCount: 2,
        timeRange: null,
        rows: [],
      },
    ];
    // The track holding c1 is collapsed; revealing must expand it.
    h.state.trackRows[0].rows = [h.state.connectionRows[0]];
    h.state.isTrackExpanded = () => false;
    const wrapper = mountComponent();

    await wrapper.vm.revealConnection("c1");
    expect(h.state.toggleTrackExpanded).toHaveBeenCalledWith("a");
  });

  it("does nothing when the selected connection is not in the list", async () => {
    setRows(
      [makeConnection("c1", "a", "b")],
      [makeAnnotation("a", 0), makeAnnotation("b", 1)],
    );
    const wrapper = mountComponent();
    await wrapper.vm.revealConnection("not-in-list");
    expect(h.state.setPage).not.toHaveBeenCalled();
  });

  it("deletes a single connection through the batched store action", async () => {
    const wrapper = mountComponent();
    await wrapper.vm.deleteOne("c1");
    expect(h.deleteConnectionsById).toHaveBeenCalledWith(["c1"]);
  });

  it("deletes a whole track in one batched call", async () => {
    setRows(
      [makeConnection("c1", "a", "b"), makeConnection("c2", "b", "c")],
      [makeAnnotation("a", 0), makeAnnotation("b", 1), makeAnnotation("c", 2)],
    );
    const wrapper = mountComponent();
    await wrapper.vm.deleteTrack({
      id: "a",
      colorKey: "a",
      annotationIds: ["a", "b", "c"],
      annotationCount: 3,
      timeRange: { start: 0, end: 2 },
      rows: wrapper.vm.rows,
    });
    expect(h.deleteConnectionsById).toHaveBeenCalledTimes(1);
    expect(h.deleteConnectionsById).toHaveBeenCalledWith(["c1", "c2"]);
  });

  /**
   * Expanding a track is an unambiguous "show me this one", so it frames the
   * track in the viewer. Collapsing is not — framing on both would yank the
   * camera back every time the user tidied the list, including after they had
   * panned away on purpose.
   */
  describe("track disclosure framing", () => {
    function trackRow() {
      return {
        id: "a",
        colorKey: "a",
        annotationIds: ["a", "b"],
        annotationCount: 2,
        timeRange: { start: 0, end: 1 },
        rows: [],
      };
    }

    it("expanding a track frames it, collapsing leaves the camera alone", () => {
      const wrapper = mountComponent();

      // Collapsed -> expanding.
      h.state.isTrackExpanded = () => false;
      wrapper.vm.toggleTrack(trackRow());
      expect(h.state.toggleTrackExpanded).toHaveBeenCalledWith("a");
      expect(h.goToTrack).toHaveBeenCalledWith(["a", "b"]);

      vi.clearAllMocks();

      // Expanded -> collapsing.
      h.state.isTrackExpanded = () => true;
      wrapper.vm.toggleTrack(trackRow());
      expect(h.state.toggleTrackExpanded).toHaveBeenCalledWith("a");
      expect(h.goToTrack).not.toHaveBeenCalled();
    });
  });

  // --- Per-track Select menu ---
  //
  // Objects and links are SEPARATE selections feeding separate actions
  // ("Connect selected" reads the object selection, "Delete selected" the
  // connection one), so each menu item must touch only its own and leave the
  // other alone.
  describe("per-track Select menu", () => {
    function trackFor(wrapper: any, annotationIds: string[]) {
      return {
        id: annotationIds[0],
        colorKey: annotationIds[0],
        annotationIds,
        annotationCount: annotationIds.length,
        timeRange: null,
        rows: wrapper.vm.rows,
      };
    }

    function setupTrack() {
      setRows(
        [makeConnection("c1", "a", "b"), makeConnection("c2", "b", "c")],
        [
          makeAnnotation("a", 0),
          makeAnnotation("b", 1),
          makeAnnotation("c", 2),
        ],
      );
      return mountComponent();
    }

    it("Objects selects the track's objects and no connections", () => {
      const wrapper = setupTrack();
      wrapper.vm.selectTrackObjects(trackFor(wrapper, ["a", "b", "c"]));
      expect(h.setSelected).toHaveBeenCalledWith(["a", "b", "c"]);
      expect(h.setSelectedConnectionIds).not.toHaveBeenCalled();
    });

    it("Links selects the track's connections and no objects", () => {
      const wrapper = setupTrack();
      wrapper.vm.selectTrackConnections(trackFor(wrapper, ["a", "b", "c"]));
      expect(h.setSelectedConnectionIds).toHaveBeenCalledWith(["c1", "c2"]);
      expect(h.setSelected).not.toHaveBeenCalled();
    });

    it("Both selects each side exactly once", () => {
      const wrapper = setupTrack();
      wrapper.vm.selectTrackBoth(trackFor(wrapper, ["a", "b", "c"]));
      expect(h.setSelected).toHaveBeenCalledTimes(1);
      expect(h.setSelected).toHaveBeenCalledWith(["a", "b", "c"]);
      expect(h.setSelectedConnectionIds).toHaveBeenCalledTimes(1);
      expect(h.setSelectedConnectionIds).toHaveBeenCalledWith(["c1", "c2"]);
    });

    /**
     * Connection endpoints outlive the annotation they point at — the list
     * deliberately keeps dangling links visible so they can be deleted. Putting
     * those ids in the selection inflates every "(N)" counter with entries
     * nothing can ever clear, because no row or feature exists to click.
     */
    it("excludes endpoints that no longer resolve", () => {
      setRows(
        [makeConnection("c1", "a", "gone"), makeConnection("c2", "a", "b")],
        // "gone" is deliberately absent.
        [makeAnnotation("a", 0), makeAnnotation("b", 1)],
      );
      const wrapper = mountComponent();
      const track = trackFor(wrapper, ["a", "b", "gone"]);

      expect(wrapper.vm.resolvableTrackObjectIds(track)).toEqual(["a", "b"]);
      expect(wrapper.vm.selectableObjectCount(track)).toBe(2);

      wrapper.vm.selectTrackObjects(track);
      expect(h.setSelected).toHaveBeenCalledWith(["a", "b"]);
    });

    it("counts nothing selectable when every endpoint is dangling", () => {
      setRows([makeConnection("c1", "x", "y")], []);
      const wrapper = mountComponent();
      expect(
        wrapper.vm.selectableObjectCount(trackFor(wrapper, ["x", "y"])),
      ).toBe(0);
    });
  });

  it("selects every row with the header checkbox", () => {
    setRows(
      [makeConnection("c1", "a", "b"), makeConnection("c2", "b", "c")],
      [makeAnnotation("a", 0), makeAnnotation("b", 1), makeAnnotation("c", 2)],
    );
    mountComponent().vm.toggleSelectAll();
    expect(h.setSelectedConnectionIds).toHaveBeenCalledWith(["c1", "c2"]);
  });

  // A viewer click can select a connection that is outside the current scope,
  // so the header checkbox must count the selected rows it can actually see —
  // not compare the total selection size against the row count.
  it("ignores selected connections that are not in the list", () => {
    setRows(
      [makeConnection("c1", "a", "b")],
      [makeAnnotation("a", 0), makeAnnotation("b", 1)],
    );
    h.state.selectedConnectionIds = new Set(["out-of-scope"]);
    const wrapper = mountComponent();
    expect(wrapper.vm.selectedVisibleCount).toBe(0);
    expect(wrapper.vm.selectAllValue).toBe(false);

    wrapper.vm.toggleSelectAll();
    expect(h.setSelectedConnectionIds).toHaveBeenCalledWith(["c1"]);
  });

  it("clears the selection when every row is already selected", () => {
    setRows(
      [makeConnection("c1", "a", "b")],
      [makeAnnotation("a", 0), makeAnnotation("b", 1)],
    );
    h.state.selectedConnectionIds = new Set(["c1"]);
    mountComponent().vm.toggleSelectAll();
    expect(h.setSelectedConnectionIds).toHaveBeenCalledWith([]);
  });

  it("warns that same-frame pairs will be chained in selection order", () => {
    h.state.canConnectSelected = true;
    h.state.connectSelectedTimeTies = [3];
    const wrapper = mountComponent();
    expect(wrapper.vm.timeTies).toEqual([3]);
    // Times are displayed 1-based, like everywhere else in the UI.
    expect(wrapper.vm.tieMessage).toContain("T4");
    expect(wrapper.vm.tieMessage).toContain("order you selected them");
  });

  it("reports when connecting produced nothing because links already existed", async () => {
    h.state.canConnectSelected = true;
    // The store flags dedupe explicitly — an empty result alone cannot mean
    // "already connected", because the API layer turns HTTP failures into [].
    h.state.lastConnectSkippedAsDuplicate = true;
    h.connectSelectedAnnotations.mockResolvedValue([]);
    const wrapper = mountComponent();
    await wrapper.vm.connectSelected();
    expect(wrapper.vm.connectError).toContain("already connected");
  });

  // Regression: a failed batch POST returns [] via the API layer's catch, and
  // used to be reported to the user as successful deduplication.
  it("reports an empty result as a failure when it was not dedupe", async () => {
    h.state.canConnectSelected = true;
    h.state.lastConnectSkippedAsDuplicate = false;
    h.state.hoveredConnectionId = null;
    h.connectSelectedAnnotations.mockResolvedValue([]);
    const wrapper = mountComponent();
    await wrapper.vm.connectSelected();
    expect(wrapper.vm.connectError).toContain("Failed to create connections");
    expect(wrapper.vm.connectError).not.toContain("already connected");
  });

  it("clears the error when connecting succeeds", async () => {
    h.state.canConnectSelected = true;
    h.connectSelectedAnnotations.mockResolvedValue([
      makeConnection("new1", "a", "b"),
    ]);
    const wrapper = mountComponent();
    await wrapper.vm.connectSelected();
    expect(wrapper.vm.connectError).toBeNull();
  });

  it("surfaces a failure to create connections instead of throwing", async () => {
    h.state.canConnectSelected = true;
    h.connectSelectedAnnotations.mockRejectedValue(new Error("boom"));
    const wrapper = mountComponent();
    await wrapper.vm.connectSelected();
    expect(wrapper.vm.connectError).toContain("Failed to create connections");
  });
});
