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
  goToAnnotationLocation: vi.fn(),
  deleteConnectionsById: vi.fn(),
  deleteSelectedConnections: vi.fn(),
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
    isConnectionSelected: () => false,
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
  goToAnnotationLocation: h.goToAnnotationLocation,
}));

vi.mock("@/store/connectionList", () => {
  h.state.setSelectedConnectionIds = h.setSelectedConnectionIds;
  h.state.deleteConnectionsById = h.deleteConnectionsById;
  h.state.deleteSelectedConnections = h.deleteSelectedConnections;
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

  it("navigates to the child endpoint and selects both endpoints", () => {
    setRows(
      [makeConnection("c1", "a", "b")],
      [makeAnnotation("a", 0), makeAnnotation("b", 1)],
    );
    const wrapper = mountComponent();
    wrapper.vm.navigateToConnection(wrapper.vm.rows[0]);

    expect(h.setSelectedConnectionIds).toHaveBeenCalledWith(["c1"]);
    expect(h.setSelected).toHaveBeenCalledWith(["a", "b"]);
    // The child is the later endpoint — that's where the viewer lands.
    expect(h.goToAnnotationLocation).toHaveBeenCalledWith("b");
  });

  it("falls back to the parent when the child endpoint is missing", () => {
    setRows([makeConnection("c1", "a", "gone")], [makeAnnotation("a", 0)]);
    const wrapper = mountComponent();
    wrapper.vm.navigateToConnection(wrapper.vm.rows[0]);

    expect(h.setSelected).toHaveBeenCalledWith(["a"]);
    expect(h.goToAnnotationLocation).toHaveBeenCalledWith("a");
  });

  it("does not navigate when both endpoints are missing", () => {
    setRows([makeConnection("c1", "gone1", "gone2")], []);
    const wrapper = mountComponent();
    wrapper.vm.navigateToConnection(wrapper.vm.rows[0]);

    expect(h.goToAnnotationLocation).not.toHaveBeenCalled();
    // The connection itself is still selectable so it can be deleted.
    expect(h.setSelectedConnectionIds).toHaveBeenCalledWith(["c1"]);
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
    h.connectSelectedAnnotations.mockResolvedValue([]);
    const wrapper = mountComponent();
    await wrapper.vm.connectSelected();
    expect(wrapper.vm.connectError).toContain("already connected");
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
