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
  trackColor,
  trackKey,
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

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Hue in degrees, recovered from a hex colour. */
function hueOf(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) {
    return 0;
  }
  const raw =
    max === r
      ? ((g - b) / delta) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return (((raw * 60) % 360) + 360) % 360;
}

describe("trackKey", () => {
  it("returns the smallest member id", () => {
    expect(trackKey(["c", "a", "b"])).toBe("a");
  });

  // The viewer builds its components from connections filtered to the displayed
  // time window and the list from scoped ones, so the two iterate a track's
  // members in different orders. Keying on iteration order — which the previous
  // `Array.from(set)[0]` did — gave one track two different colours.
  it("is independent of iteration order", () => {
    expect(trackKey(new Set(["z", "m", "a"]))).toBe(
      trackKey(new Set(["a", "z", "m"])),
    );
  });

  it("returns an empty string for an empty component", () => {
    expect(trackKey([])).toBe("");
  });
});

describe("trackColor", () => {
  it("is deterministic for the same id and seed", () => {
    expect(trackColor("65f4eb85aaba948c2d7b9da5")).toBe(
      trackColor("65f4eb85aaba948c2d7b9da5"),
    );
  });

  it("returns a 6-digit hex colour", () => {
    expect(trackColor("abc")).toMatch(/^#[0-9a-f]{6}$/);
  });

  /**
   * The regression this function exists for. The previous implementation sliced
   * the hash's own hex digits into `#rrggbb`, which put luminance under the
   * hash's control — ids hashing low produced near-black tracks that read as
   * unhighlighted against the image. Fixed S/L pins every channel into a mid
   * band whatever the hue.
   */
  it("keeps every channel in a readable mid band for any id", () => {
    const ids = Array.from(
      { length: 500 },
      (_, i) => `65f4eb85aaba948c2d7b${i.toString(16).padStart(4, "0")}`,
    );
    for (const id of ids) {
      for (const channel of channels(trackColor(id))) {
        expect(channel).toBeGreaterThanOrEqual(0x4f);
        expect(channel).toBeLessThanOrEqual(0xe3);
      }
    }
  });

  it("spans the hue circle rather than clustering", () => {
    const sectors = new Set(
      Array.from({ length: 200 }, (_, i) =>
        Math.floor(hueOf(trackColor(`track-${i}`)) / 30),
      ),
    );
    expect(sectors.size).toBe(12);
  });

  /**
   * The failure this function's golden-angle step exists for, and the one the
   * "spans the hue circle" test above could not see. Track ids are ObjectIds
   * allocated in one batch, so neighbouring tracks differ in the LAST character
   * only. Under a plain `hash % 360` their hues came out one degree apart: a
   * real dataset's first five tracks rendered as five indistinguishable greens,
   * rgb(80,226,{162,218,215,213,211}).
   */
  it("separates ids that differ by a single trailing character", () => {
    const ids = [
      "69fa8984a3094194968568c5",
      "69fa8984a3094194968568c6",
      "69fa8984a3094194968568c7",
      "69fa8984a3094194968568cb",
      "69fa8984a3094194968568cc",
    ];
    const hues = ids.map((id) => hueOf(trackColor(id)));
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const gap = Math.abs(hues[i] - hues[j]);
        // Shortest way round the circle.
        expect(Math.min(gap, 360 - gap)).toBeGreaterThan(20);
      }
    }
  });

  it("changes the colour when the seed is bumped", () => {
    expect(trackColor("abc", 1)).not.toBe(trackColor("abc", 0));
  });

  // A seed bump must re-PERMUTE, not rotate the whole wheel: rotating leaves
  // any confusable pair exactly as confusable as it was.
  it("re-permutes rather than rotating when the seed changes", () => {
    const ids = Array.from(
      { length: 40 },
      (_, i) => `69fa8984a30941949685${i.toString(16).padStart(4, "0")}`,
    );
    const shifts = new Set(
      ids.map((id) => {
        const gap = hueOf(trackColor(id, 1)) - hueOf(trackColor(id, 0));
        return Math.round((((gap % 360) + 360) % 360) / 10);
      }),
    );
    expect(shifts.size).toBeGreaterThan(1);
  });
});

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

  // The list's swatch and the viewer's line must resolve to one colour, and the
  // only thing that guarantees that is both keying off `trackKey`.
  it("keys the track id the same way trackKey does", () => {
    const annotations = [
      makeAnnotation("ccc", 0),
      makeAnnotation("aaa", 1),
      makeAnnotation("bbb", 2),
    ];
    const resolve = resolverFor(annotations);
    const rows = buildConnectionRows(
      [makeConnection("c1", "ccc", "aaa"), makeConnection("c2", "aaa", "bbb")],
      resolve,
    );
    const [track] = buildTrackRows(rows, resolve);
    expect(track.id).toBe(trackKey(track.annotationIds));
  });

  it("exposes sorted member ids, agreeing with annotationCount", () => {
    const annotations = [
      makeAnnotation("ccc", 0),
      makeAnnotation("aaa", 1),
      makeAnnotation("bbb", 2),
    ];
    const resolve = resolverFor(annotations);
    const rows = buildConnectionRows(
      [makeConnection("c1", "ccc", "aaa"), makeConnection("c2", "aaa", "bbb")],
      resolve,
    );
    const [track] = buildTrackRows(rows, resolve);
    expect(track.annotationIds).toEqual(["aaa", "bbb", "ccc"]);
    expect(track.annotationIds).toHaveLength(track.annotationCount);
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
