import { describe, it, expect } from "vitest";
import {
  AnnotationShape,
  IAnnotation,
  IAnnotationConnection,
  IAnnotationStub,
  TAnnotationOrStub,
} from "@/store/model";
import {
  buildConnectionRows,
  buildTrackRows,
  chainAnnotationsByTime,
  findConnectedComponents,
  findTimeTies,
  shortAnnotationId,
} from "@/utils/connections";

function makeConnection(
  id: string,
  parentId: string,
  childId: string,
  tags: string[] = [],
): IAnnotationConnection {
  return { id, parentId, childId, tags, label: "", datasetId: "ds" };
}

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
    location: { XY: 0, Z: 0, Time: time },
    coordinates: [{ x: 0, y: 0 }],
    datasetId: "ds",
    color: null,
  };
}

function makeStub(id: string, time: number): IAnnotationStub {
  return {
    id,
    centroid: { x: 0, y: 0 },
    location: { XY: 0, Z: 0, Time: time },
    shape: AnnotationShape.Point,
    channel: 0,
    tags: ["stubtag"],
    color: null,
  };
}

function resolverFor(annotations: TAnnotationOrStub[]) {
  const byId = new Map(annotations.map((a) => [a.id, a]));
  return (id: string) => byId.get(id);
}

describe("findConnectedComponents", () => {
  it("returns nothing for no connections", () => {
    expect(findConnectedComponents([])).toEqual([]);
  });

  it("groups a simple chain into one component", () => {
    const components = findConnectedComponents([
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "b", "c"),
    ]);
    expect(components).toHaveLength(1);
    expect([...components[0].annotations].sort()).toEqual(["a", "b", "c"]);
    expect(components[0].connections).toHaveLength(2);
  });

  it("keeps disjoint chains as separate components", () => {
    const components = findConnectedComponents([
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "x", "y"),
    ]);
    expect(components).toHaveLength(2);
    expect(components.map((c) => c.annotations.size).sort()).toEqual([2, 2]);
  });

  it("keeps a branching track (one parent, two children) as one component", () => {
    const components = findConnectedComponents([
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "a", "c"),
    ]);
    expect(components).toHaveLength(1);
    expect([...components[0].annotations].sort()).toEqual(["a", "b", "c"]);
    expect(components[0].connections).toHaveLength(2);
  });

  it("handles a cycle without infinite looping or duplicate members", () => {
    const components = findConnectedComponents([
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "b", "c"),
      makeConnection("c3", "c", "a"),
    ]);
    expect(components).toHaveLength(1);
    expect(components[0].annotations.size).toBe(3);
    expect(components[0].connections).toHaveLength(3);
  });

  it("treats a self-connection as a single-member component", () => {
    const components = findConnectedComponents([
      makeConnection("c1", "a", "a"),
    ]);
    expect(components).toHaveLength(1);
    expect([...components[0].annotations]).toEqual(["a"]);
  });

  it("assigns every connection to exactly one component", () => {
    const connections = [
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "b", "c"),
      makeConnection("c3", "x", "y"),
    ];
    const total = findConnectedComponents(connections).reduce(
      (sum, component) => sum + component.connections.length,
      0,
    );
    expect(total).toBe(connections.length);
  });
});

describe("buildConnectionRows", () => {
  it("labels a hydrated endpoint by name when it has one", () => {
    const rows = buildConnectionRows(
      [makeConnection("c1", "aaaaaaaa111111", "bbbbbbbb222222")],
      resolverFor([
        makeAnnotation("aaaaaaaa111111", 0, "Cell A"),
        makeAnnotation("bbbbbbbb222222", 1),
      ]),
    );
    expect(rows[0].parent.label).toBe("Cell A");
    // No name → short id fallback.
    expect(rows[0].child.label).toBe(shortAnnotationId("bbbbbbbb222222"));
    expect(rows[0].parent.missing).toBe(false);
  });

  it("renders a stub endpoint from its location and tags without hydration", () => {
    const rows = buildConnectionRows(
      [makeConnection("c1", "stub1", "stub2")],
      resolverFor([makeStub("stub1", 3), makeStub("stub2", 4)]),
    );
    expect(rows[0].parent.location).toEqual({ XY: 0, Z: 0, Time: 3 });
    expect(rows[0].parent.tags).toEqual(["stubtag"]);
    expect(rows[0].parent.missing).toBe(false);
  });

  it("marks an unresolvable endpoint as missing rather than throwing", () => {
    const rows = buildConnectionRows(
      [makeConnection("c1", "gone", "here")],
      resolverFor([makeAnnotation("here", 1)]),
    );
    expect(rows[0].parent.missing).toBe(true);
    expect(rows[0].parent.location).toBeNull();
    expect(rows[0].child.missing).toBe(false);
  });
});

describe("buildTrackRows", () => {
  it("groups rows into tracks with member count and time range", () => {
    const annotations = [
      makeAnnotation("a", 0),
      makeAnnotation("b", 1),
      makeAnnotation("c", 2),
    ];
    const resolve = resolverFor(annotations);
    const rows = buildConnectionRows(
      [makeConnection("c1", "a", "b"), makeConnection("c2", "b", "c")],
      resolve,
    );
    const tracks = buildTrackRows(rows, resolve);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].annotationCount).toBe(3);
    expect(tracks[0].timeRange).toEqual({ start: 0, end: 2 });
    expect(tracks[0].rows).toHaveLength(2);
  });

  it("orders tracks by their earliest timepoint", () => {
    const annotations = [
      makeAnnotation("late1", 5),
      makeAnnotation("late2", 6),
      makeAnnotation("early1", 0),
      makeAnnotation("early2", 1),
    ];
    const resolve = resolverFor(annotations);
    const rows = buildConnectionRows(
      [
        makeConnection("c1", "late1", "late2"),
        makeConnection("c2", "early1", "early2"),
      ],
      resolve,
    );
    const tracks = buildTrackRows(rows, resolve);
    expect(tracks.map((t) => t.timeRange?.start)).toEqual([0, 5]);
  });

  it("uses the smallest member id as a stable track id", () => {
    const annotations = [makeAnnotation("zzz", 0), makeAnnotation("aaa", 1)];
    const resolve = resolverFor(annotations);
    const rows = buildConnectionRows(
      [makeConnection("c1", "zzz", "aaa")],
      resolve,
    );
    expect(buildTrackRows(rows, resolve)[0].id).toBe("aaa");
  });

  it("survives a track whose members cannot be resolved", () => {
    const resolve = resolverFor([]);
    const rows = buildConnectionRows(
      [makeConnection("c1", "gone1", "gone2")],
      resolve,
    );
    const tracks = buildTrackRows(rows, resolve);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].timeRange).toBeNull();
    expect(tracks[0].annotationCount).toBe(2);
  });
});

describe("chainAnnotationsByTime", () => {
  const options = {
    datasetId: "ds",
    label: "Connect selected",
    tags: ["Time lapse connection"],
    existingConnections: [] as IAnnotationConnection[],
  };

  it("chains in ascending time regardless of selection order", () => {
    const bases = chainAnnotationsByTime(
      [makeAnnotation("c", 2), makeAnnotation("a", 0), makeAnnotation("b", 1)],
      options,
    );
    expect(bases.map((base) => [base.parentId, base.childId])).toEqual([
      ["a", "b"],
      ["b", "c"],
    ]);
  });

  it("always puts the EARLIER annotation in parentId", () => {
    const [base] = chainAnnotationsByTime(
      [makeAnnotation("later", 7), makeAnnotation("earlier", 3)],
      options,
    );
    expect(base.parentId).toBe("earlier");
    expect(base.childId).toBe("later");
  });

  it("carries the label, tags and datasetId through", () => {
    const [base] = chainAnnotationsByTime(
      [makeAnnotation("a", 0), makeAnnotation("b", 1)],
      options,
    );
    expect(base).toMatchObject({
      label: "Connect selected",
      tags: ["Time lapse connection"],
      datasetId: "ds",
    });
  });

  it("breaks same-time ties by selection order (stable sort)", () => {
    const bases = chainAnnotationsByTime(
      [makeAnnotation("second", 4), makeAnnotation("first", 4)],
      options,
    );
    // Input order is the selection order, so "second" (clicked first) parents.
    expect([bases[0].parentId, bases[0].childId]).toEqual(["second", "first"]);

    const reversed = chainAnnotationsByTime(
      [makeAnnotation("first", 4), makeAnnotation("second", 4)],
      options,
    );
    expect([reversed[0].parentId, reversed[0].childId]).toEqual([
      "first",
      "second",
    ]);
  });

  it("skips pairs already connected in the same direction", () => {
    const bases = chainAnnotationsByTime(
      [makeAnnotation("a", 0), makeAnnotation("b", 1)],
      { ...options, existingConnections: [makeConnection("c1", "a", "b")] },
    );
    expect(bases).toEqual([]);
  });

  it("skips pairs already connected in the OPPOSITE direction", () => {
    const bases = chainAnnotationsByTime(
      [makeAnnotation("a", 0), makeAnnotation("b", 1)],
      { ...options, existingConnections: [makeConnection("c1", "b", "a")] },
    );
    expect(bases).toEqual([]);
  });

  it("does not emit the same pair twice within one chain", () => {
    const duplicate = makeAnnotation("a", 0);
    const bases = chainAnnotationsByTime(
      [duplicate, duplicate, makeAnnotation("b", 1)],
      options,
    );
    const pairs = bases.map((base) => `${base.parentId}->${base.childId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("returns nothing for fewer than two annotations", () => {
    expect(chainAnnotationsByTime([], options)).toEqual([]);
    expect(chainAnnotationsByTime([makeAnnotation("a", 0)], options)).toEqual(
      [],
    );
  });
});

describe("findTimeTies", () => {
  it("reports nothing when every annotation is at a distinct time", () => {
    expect(
      findTimeTies([makeAnnotation("a", 0), makeAnnotation("b", 1)]),
    ).toEqual([]);
  });

  it("reports each shared timepoint once, in ascending order", () => {
    expect(
      findTimeTies([
        makeAnnotation("a", 4),
        makeAnnotation("b", 4),
        makeAnnotation("c", 1),
        makeAnnotation("d", 1),
        makeAnnotation("e", 9),
      ]),
    ).toEqual([1, 4]);
  });
});
