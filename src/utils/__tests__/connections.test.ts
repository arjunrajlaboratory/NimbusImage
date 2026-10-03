import { describe, it, expect } from "vitest";
import {
  AnnotationShape,
  IAnnotation,
  IAnnotationConnection,
  IAnnotationStub,
  TAnnotationOrStub,
} from "@/store/model";
import {
  TRACK_PALETTE_COUNT,
  analyzeTracks,
  buildConnectionRows,
  buildTrackRows,
  chainAnnotationsByTime,
  computeTrackMetrics,
  findConnectedComponents,
  TTrackLabelResolution,
  findDuplicateTrackLabelValues,
  findTimeTies,
  formatTrackLabelValue,
  resolveTrackLabelValue,
  shortAnnotationId,
  trackColor,
  trackKey,
  trackKeyFromIndex,
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
    // Every palette, not just the default: a shuffle that fixes one collision
    // by making these five indistinguishable is a worse outcome than the
    // collision. Optimising the neighbour-gap metric alone once picked a step
    // that scored 44 deg there and 19.4 deg here.
    for (let seed = 0; seed < TRACK_PALETTE_COUNT; seed++) {
      const hues = ids.map((id) => hueOf(trackColor(id, seed)));
      for (let i = 0; i < hues.length; i++) {
        for (let j = i + 1; j < hues.length; j++) {
          const gap = Math.abs(hues[i] - hues[j]);
          // Shortest way round the circle.
          expect(Math.min(gap, 360 - gap)).toBeGreaterThan(20);
        }
      }
    }
  });

  it("changes the colour when the seed is bumped", () => {
    expect(trackColor("abc", 1)).not.toBe(trackColor("abc", 0));
  });

  /**
   * A batch of consecutive ObjectIds, the shape real track keys take. 248 of
   * them, matching the test dataset, because the property degrades with count:
   * the previous 40-id fixture started at offset 0x0000 and never crossed the
   * hex carry that produced the bad case, so it measured 77.3° for a step that
   * measures 4.2° here.
   */
  const consecutiveIds = (count: number, start = 0x68c3) =>
    Array.from(
      { length: count },
      (_, i) =>
        `69fa8984a30941949685${(start + i).toString(16).padStart(4, "0")}`,
    );

  /** Smallest hue gap between ids that are NEIGHBOURS in allocation order. */
  const minAdjacentGap = (ids: string[], seed = 0) => {
    let min = 360;
    for (let i = 1; i < ids.length; i++) {
      const gap = Math.abs(
        hueOf(trackColor(ids[i], seed)) - hueOf(trackColor(ids[i - 1], seed)),
      );
      min = Math.min(min, gap, 360 - gap);
    }
    return min;
  };

  /**
   * The sorted multiset of gaps around the circle. Invariant under a rotation of
   * every hue by the same amount; changed by a genuine re-assignment. This is the
   * discriminator the previous version of this test lacked.
   */
  const gapSignature = (ids: string[], seed = 0) => {
    const hues = ids
      .map((id) => hueOf(trackColor(id, seed)))
      .sort((a, b) => a - b);
    return hues
      .map(
        (hue, i) =>
          +((hues[(i + 1) % hues.length] - hue + 360) % 360).toFixed(3),
      )
      .sort((a, b) => a - b)
      .join("|");
  };

  const closestPair = (ids: string[], seed = 0) => {
    const hues = ids.map((id) => hueOf(trackColor(id, seed)));
    let best = { pair: "", gap: 360 };
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const gap = Math.abs(hues[i] - hues[j]);
        const shortest = Math.min(gap, 360 - gap);
        if (shortest < best.gap) {
          best = { pair: `${i}/${j}`, gap: shortest };
        }
      }
    }
    return best;
  };

  /**
   * Regression for a claim the code made and did not honour. The seed used to be
   * folded into the hash accumulator, which for equal-length ids adds the same
   * `31^n · seed` to every hash — a constant offset. Every hue moved, so the
   * colours looked different and both a unit test and a live browser check
   * accepted it, but every pairwise gap survived: identical gap multiset at every
   * seed, with the closest pair pinned at 2.927°. The one thing Shuffle exists
   * for — separating a pair that collides — was the one thing it could not do.
   */
  it("re-permutes rather than rotating when the seed changes", () => {
    const ids = consecutiveIds(248);
    const base = gapSignature(ids, 0);
    // At least one other palette must have a genuinely different gap structure.
    const signatures = [1, 2].map((seed) => gapSignature(ids, seed));
    expect(signatures).not.toContain(base);
    // ...and the closest pair must actually be broken up, not carried along.
    const before = closestPair(ids, 0);
    const after = closestPair(ids, 1);
    expect(after.pair).not.toBe(before.pair);
  });

  /**
   * The primary property, at the scale it actually degrades. Every palette the
   * seed can select must hold it — a shuffle that fixes one collision by making
   * neighbouring tracks indistinguishable is a worse outcome than the collision.
   * 1/φ, the previous step, measures 4.2° here and would fail this.
   */
  it("keeps neighbouring ids far apart in every palette", () => {
    const ids = consecutiveIds(248);
    for (let seed = 0; seed < TRACK_PALETTE_COUNT; seed++) {
      expect(minAdjacentGap(ids, seed)).toBeGreaterThan(20);
    }
  });

  // Not overfit to one batch: the delta structure depends on where the hex
  // carries fall, so a step can look fine for one start offset and fail another.
  it("holds that separation across id batches and sizes", () => {
    for (const start of [0x0000, 0x009a, 0x68c3, 0x0fff, 0xabcd]) {
      for (const count of [40, 120, 248]) {
        const ids = consecutiveIds(count, start);
        for (let seed = 0; seed < TRACK_PALETTE_COUNT; seed++) {
          expect(minAdjacentGap(ids, seed)).toBeGreaterThan(20);
        }
      }
    }
  });

  // Only ever incremented in practice, but indexing past the array would yield
  // an undefined step and a NaN hue — a silently colourless track.
  it("survives a seed outside the palette range", () => {
    for (const seed of [-1, -7, TRACK_PALETTE_COUNT, TRACK_PALETTE_COUNT * 3]) {
      expect(trackColor("69fa8984a3094194968568c5", seed)).toMatch(
        /^#[0-9a-f]{6}$/,
      );
    }
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

describe("analyzeTracks", () => {
  it("indexes every member by the dataset-wide component key", () => {
    const analysis = analyzeTracks([
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "b", "c"),
      makeConnection("c3", "x", "y"),
    ]);

    expect(analysis.components).toHaveLength(2);
    expect(analysis.trackKeyByAnnotationId.get("a")).toBe("a");
    expect(analysis.trackKeyByAnnotationId.get("b")).toBe("a");
    expect(analysis.trackKeyByAnnotationId.get("c")).toBe("a");
    expect(analysis.trackKeyByAnnotationId.get("x")).toBe("x");
    expect(analysis.trackKeyByAnnotationId.get("y")).toBe("x");
  });

  it("resolves a scoped fragment to its dataset-wide track key", () => {
    const { trackKeyByAnnotationId } = analyzeTracks([
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "b", "c"),
    ]);

    expect(trackKeyFromIndex(["b", "c"], trackKeyByAnnotationId)).toBe("a");
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

  // A scoped track row keeps its scoped id for expansion and labeling, but its
  // swatch must use the dataset-wide identity shared with the viewer.
  it("keeps scoped row identity separate from its global color key", () => {
    const annotations = [
      makeAnnotation("a", 0),
      makeAnnotation("b", 1),
      makeAnnotation("c", 2),
    ];
    const resolve = resolverFor(annotations);
    const allConnections = [
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "b", "c"),
    ];
    const rows = buildConnectionRows(
      // The active scope exposes only the tail of the full a-b-c track.
      [allConnections[1]],
      resolve,
    );
    const { trackKeyByAnnotationId } = analyzeTracks(allConnections);
    const [track] = buildTrackRows(rows, resolve, trackKeyByAnnotationId);

    expect(track.id).toBe("b");
    expect(track.id).toBe(trackKey(track.annotationIds));
    expect(track.colorKey).toBe("a");
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

describe("resolveTrackLabelValue", () => {
  const values = (map: Record<string, number | string | null>) => {
    return (id: string) => map[id] ?? null;
  };

  it("returns the shared value when every member agrees", () => {
    expect(
      resolveTrackLabelValue(["a", "b"], values({ a: 42, b: 42 })),
    ).toEqual({ status: "value", value: 42 });
  });

  it("keeps the shared value but flags partial coverage", () => {
    expect(
      resolveTrackLabelValue(["a", "b"], values({ a: 42, b: null })),
    ).toEqual({ status: "partial", value: 42 });
  });

  it("reports each differing value once", () => {
    expect(
      resolveTrackLabelValue(["a", "b", "c"], values({ a: 42, b: 43, c: 43 })),
    ).toEqual({ status: "mixed", values: [42, 43] });
  });

  it("reports missing when no member has a value", () => {
    expect(resolveTrackLabelValue(["a", "b"], () => null)).toEqual({
      status: "missing",
    });
  });

  // The picker offers per-annotation paths (e.g. the worker's annotationId),
  // where every member of a large track is unique, and resolution repeats on
  // every scoped-tracks rebuild (each pan). Collection must stay linear — a
  // quadratic distinct-scan freezes the tab; the test's implicit 5s timeout
  // is the cost regression guard (quadratic: minutes, linear: milliseconds).
  it("resolves a large all-distinct track in linear time", () => {
    const memberIds = Array.from({ length: 100_000 }, (_, i) => `m${i}`);
    const result = resolveTrackLabelValue(memberIds, (id) => id);
    expect(result.status).toBe("mixed");
    expect(result.status === "mixed" && result.values.length).toBe(100_000);
  });

  // 0 is a legitimate track id (the parent_child worker starts at 0), so the
  // resolution must never treat it as "no value".
  it("does not confuse a value of 0 with a missing value", () => {
    expect(resolveTrackLabelValue(["a", "b"], values({ a: 0, b: 0 }))).toEqual({
      status: "value",
      value: 0,
    });
  });
});

describe("findDuplicateTrackLabelValues", () => {
  const track = (
    resolution: TTrackLabelResolution,
    datasetTrackKey: string,
  ) => ({ resolution, datasetTrackKey });

  it("reports a value shared by two distinct dataset-wide tracks", () => {
    expect(
      findDuplicateTrackLabelValues([
        track({ status: "value", value: 42 }, "k1"),
        track({ status: "value", value: 42 }, "k2"),
        track({ status: "value", value: 43 }, "k3"),
      ]),
    ).toEqual(new Set([42]));
  });

  // A narrow scope (selected, filtered, current location) can expose one
  // intact dataset-wide track as two disconnected fragments; both carry the
  // same value and the same dataset track key — no split happened.
  it("does not report fragments of one dataset-wide track", () => {
    expect(
      findDuplicateTrackLabelValues([
        track({ status: "value", value: 42 }, "k1"),
        track({ status: "value", value: 42 }, "k1"),
      ]),
    ).toEqual(new Set());
  });

  // A split half that later gained an unvalued member resolves as partial;
  // its value still collides with its twin.
  it("counts partial resolutions' values too", () => {
    expect(
      findDuplicateTrackLabelValues([
        track({ status: "partial", value: 42 }, "k1"),
        track({ status: "value", value: 42 }, "k2"),
      ]),
    ).toEqual(new Set([42]));
  });

  it("ignores mixed and missing resolutions", () => {
    expect(
      findDuplicateTrackLabelValues([
        track({ status: "mixed", values: [1, 2] }, "k1"),
        track({ status: "mixed", values: [1, 2] }, "k2"),
        track({ status: "missing" }, "k3"),
        track({ status: "missing" }, "k4"),
      ]),
    ).toEqual(new Set());
  });

  it("treats 0 as a value", () => {
    expect(
      findDuplicateTrackLabelValues([
        track({ status: "value", value: 0 }, "k1"),
        track({ status: "value", value: 0 }, "k2"),
      ]),
    ).toEqual(new Set([0]));
  });

  it('distinguishes the number 42 from the string "42"', () => {
    expect(
      findDuplicateTrackLabelValues([
        track({ status: "value", value: 42 }, "k1"),
        track({ status: "value", value: "42" }, "k2"),
      ]),
    ).toEqual(new Set());
  });
});

describe("formatTrackLabelValue", () => {
  it("shows worker integer floats without decimals", () => {
    expect(formatTrackLabelValue(42.0)).toBe("42");
    expect(formatTrackLabelValue(0)).toBe("0");
  });

  it("keeps fractional values short", () => {
    expect(formatTrackLabelValue(1.23456789)).toBe("1.235");
  });

  it("passes strings through", () => {
    expect(formatTrackLabelValue("t-7")).toBe("t-7");
  });
});

describe("computeTrackMetrics", () => {
  it("computes connection count, member count and duration for a linear track", () => {
    const components = findConnectedComponents([
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "b", "c"),
    ]);
    const metrics = computeTrackMetrics(
      components,
      resolverFor([
        makeAnnotation("a", 0),
        makeAnnotation("b", 1),
        makeAnnotation("c", 2),
      ]),
    );
    expect(metrics.get("a")).toEqual({
      connectionCount: 2,
      memberCount: 3,
      duration: 3,
    });
  });

  it("keys each track by its dataset-wide track key", () => {
    const components = findConnectedComponents([
      makeConnection("c1", "m", "b"),
      makeConnection("c2", "x", "y"),
    ]);
    const metrics = computeTrackMetrics(
      components,
      resolverFor([
        makeAnnotation("m", 0),
        makeAnnotation("b", 1),
        makeAnnotation("x", 0),
        makeAnnotation("y", 1),
      ]),
    );
    expect([...metrics.keys()].sort()).toEqual(["b", "x"]);
  });

  it("counts a branching track's members and connections separately", () => {
    const components = findConnectedComponents([
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "a", "c"),
    ]);
    const metrics = computeTrackMetrics(
      components,
      resolverFor([
        makeAnnotation("a", 0),
        makeAnnotation("b", 1),
        makeAnnotation("c", 1),
      ]),
    );
    expect(metrics.get("a")).toEqual({
      connectionCount: 2,
      memberCount: 3,
      duration: 2,
    });
  });

  it("derives duration from the members that still resolve", () => {
    // "gone" is a dangling endpoint — common in real datasets and must not
    // poison the duration of the members that do resolve.
    const components = findConnectedComponents([
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "b", "gone"),
    ]);
    const metrics = computeTrackMetrics(
      components,
      resolverFor([makeAnnotation("a", 0), makeAnnotation("b", 5)]),
    );
    expect(metrics.get("a")).toEqual({
      connectionCount: 2,
      memberCount: 3,
      duration: 6,
    });
  });

  it("reports null duration when no member resolves", () => {
    const components = findConnectedComponents([
      makeConnection("c1", "gone1", "gone2"),
    ]);
    const metrics = computeTrackMetrics(components, resolverFor([]));
    expect(metrics.get("gone1")).toEqual({
      connectionCount: 1,
      memberCount: 2,
      duration: null,
    });
  });

  it("resolves durations from stubs, not only hydrated annotations", () => {
    const components = findConnectedComponents([
      makeConnection("c1", "s1", "s2"),
    ]);
    const metrics = computeTrackMetrics(
      components,
      resolverFor([makeStub("s1", 2), makeStub("s2", 9)]),
    );
    expect(metrics.get("s1")?.duration).toBe(8);
  });
});
