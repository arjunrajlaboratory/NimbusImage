import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { AnnotationShape, IAnnotation } from "@/store/model";

const h = vi.hoisted(() => ({
  isConnectionSelected: vi.fn(() => false),
  isLoggedIn: true,
}));

vi.mock("@/store", () => ({
  default: {
    get isLoggedIn() {
      return h.isLoggedIn;
    },
  },
}));

vi.mock("@/store/connectionList", () => ({
  default: { isConnectionSelected: h.isConnectionSelected },
}));

import ConnectionListRow from "./ConnectionListRow.vue";
import { buildConnectionRows, IConnectionRow } from "@/utils/connections";

function makeAnnotation(
  id: string,
  time: number,
  name: string | null = null,
): IAnnotation {
  return {
    id,
    name,
    tags: [],
    shape: AnnotationShape.Point,
    channel: 0,
    location: { XY: 0, Z: 2, Time: time },
    coordinates: [{ x: 0, y: 0 }],
    datasetId: "ds",
    color: null,
  };
}

function makeRow(
  known: IAnnotation[],
  parentId = "p",
  childId = "c",
  tags: string[] = [],
): IConnectionRow {
  const byId = new Map(known.map((a) => [a.id, a]));
  return buildConnectionRows(
    [{ id: "conn1", parentId, childId, tags, label: "", datasetId: "ds" }],
    (id) => byId.get(id),
  )[0];
}

// The row renders a <tr>, which is only valid inside a table.
function mountRow(row: IConnectionRow, hoveredId: string | null = null) {
  return mount(ConnectionListRow, {
    props: { row, hoveredId },
    attachTo: document.createElement("tbody"),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isLoggedIn = true;
  h.isConnectionSelected.mockReturnValue(false);
});

describe("ConnectionListRow", () => {
  it("renders both endpoints with 1-based locations", () => {
    const row = makeRow(
      [makeAnnotation("p", 0, "Mother"), makeAnnotation("c", 3)],
      "p",
      "c",
    );
    const text = mountRow(row).text();
    expect(text).toContain("Mother");
    // Time 0 / Z 2 / XY 0 display as T1 Z3 XY1.
    expect(text).toContain("T1 Z3 XY1");
    expect(text).toContain("T4 Z3 XY1");
  });

  it("falls back to a short id when the annotation has no name", () => {
    const row = makeRow(
      [makeAnnotation("aaaaaaaaaaaa123456", 0), makeAnnotation("c", 1)],
      "aaaaaaaaaaaa123456",
      "c",
    );
    expect(mountRow(row).text()).toContain("#123456");
  });

  // Dangling endpoints are common in older datasets — the row must render them
  // rather than blowing up, and must stay deletable so they can be cleaned up.
  it("marks a dangling endpoint as missing without throwing", () => {
    const row = makeRow([makeAnnotation("c", 1)], "gone", "c");
    const wrapper = mountRow(row);
    expect(wrapper.text()).toContain("missing");
    expect(wrapper.find("button").attributes("disabled")).toBeUndefined();
  });

  it("emits the connection id when the delete button is clicked", async () => {
    const row = makeRow([makeAnnotation("p", 0), makeAnnotation("c", 1)]);
    const wrapper = mountRow(row);
    await wrapper.find("button").trigger("click");
    expect(wrapper.emitted("delete")).toEqual([["conn1"]]);
    // Deleting must not also fire row navigation.
    expect(wrapper.emitted("navigate")).toBeUndefined();
  });

  it("emits navigate with the row when the row itself is clicked", async () => {
    const row = makeRow([makeAnnotation("p", 0), makeAnnotation("c", 1)]);
    const wrapper = mountRow(row);
    await wrapper.find("tr").trigger("click");
    expect(wrapper.emitted("navigate")).toEqual([[row]]);
  });

  it("emits hover on enter and null on leave", async () => {
    const row = makeRow([makeAnnotation("p", 0), makeAnnotation("c", 1)]);
    const wrapper = mountRow(row);
    await wrapper.find("tr").trigger("mouseover");
    await wrapper.find("tr").trigger("mouseleave");
    expect(wrapper.emitted("hover")).toEqual([["conn1"], [null]]);
  });

  it("disables deletion when logged out", () => {
    h.isLoggedIn = false;
    const row = makeRow([makeAnnotation("p", 0), makeAnnotation("c", 1)]);
    expect(mountRow(row).find("button").attributes("disabled")).toBeDefined();
  });

  it("marks the row selected when the store says it is", () => {
    h.isConnectionSelected.mockReturnValue(true);
    const row = makeRow([makeAnnotation("p", 0), makeAnnotation("c", 1)]);
    expect(mountRow(row).find("tr").classes()).toContain("is-selected");
  });

  it("marks the row hovered from the hoveredId prop", () => {
    const row = makeRow([makeAnnotation("p", 0), makeAnnotation("c", 1)]);
    expect(mountRow(row, "conn1").find("tr").classes()).toContain("is-hovered");
  });

  it("emits clicked-tag without navigating when a tag is clicked", async () => {
    const row = makeRow(
      [makeAnnotation("p", 0), makeAnnotation("c", 1)],
      "p",
      "c",
      ["Time lapse connection"],
    );
    const wrapper = mountRow(row);
    await wrapper.find(".v-chip").trigger("click");
    expect(wrapper.emitted("clicked-tag")).toEqual([["Time lapse connection"]]);
    expect(wrapper.emitted("navigate")).toBeUndefined();
  });
});
