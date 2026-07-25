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

vi.mock("@/store/annotation", () => ({
  default: {
    setSelected: h.setSelected,
    selectedAnnotationIds: new Set<string>(),
  },
}));

vi.mock("@/utils/annotationNavigation", () => ({
  goToConnection: h.goToConnection,
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
import { buildConnectionRows } from "@/utils/connections";

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
}

function mountComponent() {
  return shallowMount(ConnectionList, {});
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.scope = "all";
  h.state.grouping = "flat";
  h.state.selectedConnectionIds = new Set();
  h.state.canConnectSelected = false;
  h.state.connectSelectedTimeTies = [];
  h.state.selectedInScopeConnectionIds = [];
  h.state.lastConnectSkippedAsDuplicate = false;
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

  it("expands the containing track when revealing in track mode", async () => {
    setRows(
      [makeConnection("c1", "a", "b")],
      [makeAnnotation("a", 0), makeAnnotation("b", 1)],
    );
    h.state.grouping = "track";
    h.state.trackRows = [
      { id: "a", annotationCount: 2, timeRange: null, rows: [] },
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
      annotationCount: 3,
      timeRange: { start: 0, end: 2 },
      rows: wrapper.vm.rows,
    });
    expect(h.deleteConnectionsById).toHaveBeenCalledTimes(1);
    expect(h.deleteConnectionsById).toHaveBeenCalledWith(["c1", "c2"]);
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
