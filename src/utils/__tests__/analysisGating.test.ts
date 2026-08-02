/**
 * The Analysis panel's coordinate and gating maths.
 *
 * This is the half of the feature with no visible symptom when it breaks: a
 * gate that resolves wrongly selects the wrong objects rather than erroring,
 * and every count around it still looks plausible. It is also the pair of
 * symmetric paths most at risk of drift — drawing a point and hit-testing it
 * must use identical coordinates — which is why both go through
 * buildPlotSeries here.
 */
import { describe, it, expect } from "vitest";
import {
  analysisCategoricalKeys,
  analysisPropertyPaths,
  categoricalContentSignature,
  buildPlotSeries,
  chainPlotInputs,
  encodeAnalysisCategoryKey,
  jitterFromId,
  populationSignature,
  resolveGateIds,
  selectionEventToGate,
  shapeToGate,
} from "@/utils/analysisGating";
import {
  AnnotationShape,
  IAnalysisPlot,
  TAnnotationOrStub,
} from "@/store/model";

const channelName = (channel: number) => `Ch${channel}`;

function annotation(
  id: string,
  overrides: Partial<TAnnotationOrStub> = {},
): TAnnotationOrStub {
  return {
    id,
    centroid: { x: 0, y: 0 },
    location: { XY: 0, Z: 0, Time: 0 },
    shape: AnnotationShape.Point,
    channel: 0,
    tags: [],
    color: null,
    ...overrides,
  } as TAnnotationOrStub;
}

const AREA = { type: "property" as const, path: ["prop", "Area"] };
const INTENSITY = { type: "property" as const, path: ["prop", "Mean"] };
const TAGS = { type: "categorical" as const, key: "tags" as const };
const CHANNEL = { type: "categorical" as const, key: "channel" as const };

// A unit square gate covering x in [0,10], y in [0,10].
const SQUARE = {
  categoryKeyVersion: 1 as const,
  vertices: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ],
  xCategories: null,
  yCategories: null,
};

describe("buildPlotSeries", () => {
  it("drops annotations missing a value on either axis, and counts them", () => {
    const series = buildPlotSeries({
      annotations: [annotation("a"), annotation("b"), annotation("c")],
      values: {
        a: { prop: { Area: 1, Mean: 2 } },
        b: { prop: { Area: 3 } }, // no Mean
        // c has no values at all
      },
      xAxis: AREA,
      yAxis: INTENSITY,
      channelName,
    });
    expect(series.ids).toEqual(["a"]);
    expect(series.x).toEqual([1]);
    expect(series.y).toEqual([2]);
    expect(series.skipped).toBe(2);
  });

  it("treats a non-finite property value as missing", () => {
    // A NaN would otherwise plot at an undefined position and, worse, make the
    // point-in-polygon test return an arbitrary answer.
    const series = buildPlotSeries({
      annotations: [annotation("a"), annotation("b")],
      values: {
        a: { prop: { Area: NaN, Mean: 1 } },
        b: { prop: { Area: Infinity, Mean: 1 } },
      },
      xAxis: AREA,
      yAxis: INTENSITY,
      channelName,
    });
    expect(series.ids).toEqual([]);
    expect(series.skipped).toBe(2);
  });

  it("maps categories to sorted indices with deterministic jitter", () => {
    const annotations = [
      annotation("a", { tags: ["beta"] }),
      annotation("b", { tags: ["alpha"] }),
      annotation("c", { tags: [] }),
    ];
    const values = {
      a: { prop: { Mean: 1 } },
      b: { prop: { Mean: 1 } },
      c: { prop: { Mean: 1 } },
    };
    const build = () =>
      buildPlotSeries({
        annotations,
        values,
        xAxis: TAGS,
        yAxis: INTENSITY,
        channelName,
      });
    const first = build();
    // Ordered by ENCODED KEY, not by display label: only key order is
    // reproducible on the server (labels for `channel` need the dataset
    // config, and localeCompare is locale-dependent), and an axis that
    // reorders when a dataset crosses the plot cap is a picture that changes
    // for no reason the user can see. `v1:["alpha"]` sorts before `v1:[]`
    // because '"' (0x22) precedes ']' (0x5D).
    expect(first.xCategories).toEqual([
      encodeAnalysisCategoryKey(["alpha"]),
      encodeAnalysisCategoryKey(["beta"]),
      encodeAnalysisCategoryKey([]),
    ]);
    expect(first.xCategoryLabels).toEqual(["alpha", "beta", "(untagged)"]);
    // Each point sits within half a slot of its category index.
    first.ids.forEach((id, i) => {
      const category = first.xCategoryLabels!.indexOf(
        id === "a" ? "beta" : id === "b" ? "alpha" : "(untagged)",
      );
      expect(Math.abs(first.x[i] - category)).toBeLessThan(0.3);
      expect(first.x[i]).not.toBe(category); // jittered, not stacked
    });
    // Stable across rebuilds — a gate drawn over a jittered column has to
    // contain the same points when it is re-resolved in a later session.
    expect(build().x).toEqual(first.x);
  });

  it("keeps tag identities separate when their display labels collide", () => {
    const annotations = [
      annotation("untagged", { tags: [] }),
      annotation("literal", { tags: ["(untagged)"] }),
      annotation("pair", { tags: ["A", "B"] }),
      annotation("joined", { tags: ["A, B"] }),
    ];
    const values = Object.fromEntries(
      annotations.map(({ id }) => [id, { prop: { Mean: 1 } }]),
    );

    const series = buildPlotSeries({
      annotations,
      values,
      xAxis: TAGS,
      yAxis: INTENSITY,
      channelName,
    });

    expect(new Set(series.x.map(Math.round))).toHaveLength(4);
    expect(series.xCategories).toHaveLength(4);
    expect(
      series.xCategoryLabels?.filter((label) => label === "(untagged)"),
    ).toHaveLength(2);
    expect(
      series.xCategoryLabels?.filter((label) => label === "A, B"),
    ).toHaveLength(2);

    const untaggedColumn = Math.round(series.x[series.ids.indexOf("untagged")]);
    expect(
      resolveGateIds(series, {
        categoryKeyVersion: 1,
        vertices: [
          { x: untaggedColumn - 0.4, y: 0.5 },
          { x: untaggedColumn + 0.4, y: 0.5 },
          { x: untaggedColumn + 0.4, y: 1.5 },
          { x: untaggedColumn - 0.4, y: 1.5 },
        ],
        xCategories: series.xCategories,
        yCategories: null,
      }),
    ).toEqual(["untagged"]);
  });

  it("keeps channels separate when their display names collide", () => {
    const annotations = [
      annotation("channel-0", { channel: 0 }),
      annotation("channel-1", { channel: 1 }),
    ];
    const series = buildPlotSeries({
      annotations,
      values: {
        "channel-0": { prop: { Mean: 1 } },
        "channel-1": { prop: { Mean: 1 } },
      },
      xAxis: CHANNEL,
      yAxis: INTENSITY,
      channelName: () => "DAPI",
    });

    expect(new Set(series.x.map(Math.round))).toHaveLength(2);
    expect(series.xCategories).toHaveLength(2);
    expect(series.xCategoryLabels).toEqual(["DAPI", "DAPI"]);

    const firstChannelColumn = Math.round(
      series.x[series.ids.indexOf("channel-0")],
    );
    expect(
      resolveGateIds(series, {
        categoryKeyVersion: 1,
        vertices: [
          { x: firstChannelColumn - 0.4, y: 0.5 },
          { x: firstChannelColumn + 0.4, y: 0.5 },
          { x: firstChannelColumn + 0.4, y: 1.5 },
          { x: firstChannelColumn - 0.4, y: 1.5 },
        ],
        xCategories: series.xCategories,
        yCategories: null,
      }),
    ).toEqual(["channel-0"]);
  });

  it("pins category indices to a gate's stored ordering", () => {
    // The gate's coordinates mean "category index", so re-deriving the order
    // from whatever categories are present would move the gate onto different
    // categories — a real risk since a configuration is shared across datasets.
    const series = buildPlotSeries({
      annotations: [annotation("a", { tags: ["beta"] })],
      values: { a: { prop: { Mean: 1 } } },
      xAxis: TAGS,
      yAxis: INTENSITY,
      channelName,
      xCategoryOrder: [
        encodeAnalysisCategoryKey(["alpha"]),
        encodeAnalysisCategoryKey(["beta"]),
      ],
    });
    expect(series.xCategoryLabels).toEqual(["alpha", "beta"]);
    expect(Math.round(series.x[0])).toBe(1); // beta keeps index 1
  });

  it("appends a category the stored ordering has never seen", () => {
    // Applying a saved gate to another dataset that has an extra tag must still
    // plot that tag rather than dropping those objects.
    const series = buildPlotSeries({
      annotations: [annotation("a", { tags: ["gamma"] })],
      values: { a: { prop: { Mean: 1 } } },
      xAxis: TAGS,
      yAxis: INTENSITY,
      channelName,
      xCategoryOrder: [
        encodeAnalysisCategoryKey(["alpha"]),
        encodeAnalysisCategoryKey(["beta"]),
      ],
    });
    expect(series.xCategoryLabels).toEqual(["alpha", "beta", "gamma"]);
    expect(series.ids).toEqual(["a"]);
  });

  it("labels each categorical axis kind from stub-available fields", () => {
    const a = annotation("a", {
      tags: ["z", "a"],
      channel: 2,
      location: { XY: 1, Z: 3, Time: 4 },
    });
    const label = (key: any) =>
      buildPlotSeries({
        annotations: [a],
        values: { a: { prop: { Mean: 1 } } },
        xAxis: { type: "categorical", key },
        yAxis: INTENSITY,
        channelName,
      }).xCategoryLabels![0];
    expect(label("tags")).toBe("a, z"); // sorted, so tag order can't split a group
    expect(label("channel")).toBe("Ch2");
    expect(label("xy")).toBe("XY 2"); // 1-based for display
    expect(label("z")).toBe("Z 4");
    expect(label("time")).toBe("T 5");
  });
});

describe("resolveGateIds", () => {
  const series = {
    ids: ["in", "out", "edge"],
    x: [5, 50, 5],
    y: [5, 50, 20],
    xCategories: null,
    yCategories: null,
    xCategoryLabels: null,
    yCategoryLabels: null,
    skipped: 0,
  };

  it("keeps only the points inside the polygon", () => {
    expect(resolveGateIds(series, SQUARE)).toEqual(["in"]);
  });

  it("selects nothing for a degenerate polygon", () => {
    // Fewer than 3 vertices bounds no area; the ray cast would otherwise return
    // an arbitrary answer rather than "empty".
    expect(
      resolveGateIds(series, {
        ...SQUARE,
        vertices: SQUARE.vertices.slice(0, 2),
      }),
    ).toEqual([]);
  });

  it("resolves a concave polygon by containment, not by bounding box", () => {
    // A lasso is routinely concave; a bounding-box shortcut would wrongly
    // include points in the notch.
    const vShape = {
      categoryKeyVersion: 1 as const,
      vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 5, y: 2 },
        { x: 0, y: 10 },
      ],
      xCategories: null,
      yCategories: null,
    };
    const points = {
      ids: ["leftArm", "notch", "rightArm"],
      x: [1, 5, 9],
      y: [8, 8, 8],
      xCategories: null,
      yCategories: null,
      xCategoryLabels: null,
      yCategoryLabels: null,
      skipped: 0,
    };
    expect(resolveGateIds(points, vShape)).toEqual(["leftArm", "rightArm"]);
  });

  it("excludes categories the gate's pinned order does not know", () => {
    // SERVER_GATING.md "unknown categories are outside the gate": a category
    // that did not exist when the gate was drawn plots (appended after the
    // pinned ones) but never resolves into the gate, no matter how far the
    // polygon reaches. Population-dependent appended indices are what made
    // the old inclusion arbitrary — and inexpressible server-side.
    const gate = {
      categoryKeyVersion: 1 as const,
      vertices: [
        { x: -0.5, y: -1 },
        { x: 5, y: -1 },
        { x: 5, y: 2 },
        { x: -0.5, y: 2 },
      ],
      xCategories: [encodeAnalysisCategoryKey(["known"])],
      yCategories: null,
    };
    const series = buildPlotSeries({
      annotations: [
        annotation("a", { tags: ["known"] }),
        annotation("b", { tags: ["appeared-later"] }),
      ],
      values: {
        a: { prop: { Mean: 1 } },
        b: { prop: { Mean: 1 } },
      },
      xAxis: TAGS,
      yAxis: INTENSITY,
      channelName,
      xCategoryOrder: gate.xCategories,
    });
    // Both plot (the unknown category is appended at index 1, inside the
    // polygon's x-range) but only the pinned category resolves.
    expect(series.ids).toEqual(["a", "b"]);
    expect(Math.round(series.x[1])).toBe(1);
    expect(resolveGateIds(series, gate)).toEqual(["a"]);
  });

  it("applies the unknown-category rule per axis", () => {
    const gate = {
      categoryKeyVersion: 1 as const,
      vertices: [
        { x: -1, y: -1 },
        { x: 9, y: -1 },
        { x: 9, y: 9 },
        { x: -1, y: 9 },
      ],
      xCategories: [encodeAnalysisCategoryKey(["known"])],
      yCategories: [encodeAnalysisCategoryKey(0)],
    };
    const series = buildPlotSeries({
      annotations: [
        annotation("both-known", { tags: ["known"], channel: 0 }),
        annotation("y-unknown", { tags: ["known"], channel: 3 }),
      ],
      values: {},
      xAxis: TAGS,
      yAxis: CHANNEL,
      channelName,
      xCategoryOrder: gate.xCategories,
      yCategoryOrder: gate.yCategories,
    });
    expect(resolveGateIds(series, gate)).toEqual(["both-known"]);
  });
});

describe("appended-category ordering", () => {
  it("appends categories unknown to a pinned order in encoded-key order, not encounter order", () => {
    // Deterministic display: the same population must plot appended
    // categories at the same indices regardless of iteration order, AND in
    // the order the server's derive_axis_categories produces — it sorts
    // encoded keys by UTF-16 code unit and cannot do anything else (labels
    // for `channel` need the dataset config; localeCompare is locale-
    // dependent). "(untagged)" discriminates the two: by label it sorts
    // FIRST ('(' is 0x28), by key `v1:[]` sorts LAST (']' 0x5D beats '"').
    const build = (order: (string | null)[]) =>
      buildPlotSeries({
        annotations: order.map((tag, i) =>
          annotation(`n${i}`, { tags: tag === null ? [] : [tag] }),
        ),
        values: Object.fromEntries(
          order.map((_, i) => [`n${i}`, { prop: { Mean: 1 } }]),
        ),
        xAxis: TAGS,
        yAxis: INTENSITY,
        channelName,
        xCategoryOrder: [encodeAnalysisCategoryKey(["pinned"])],
      });
    const forward = build(["pinned", "delta", null, "carol"]);
    const reversed = build([null, "carol", "delta", "pinned"]);
    expect(forward.xCategories).toEqual([
      encodeAnalysisCategoryKey(["pinned"]),
      encodeAnalysisCategoryKey(["carol"]),
      encodeAnalysisCategoryKey(["delta"]),
      encodeAnalysisCategoryKey([]),
    ]);
    expect(reversed.xCategories).toEqual(forward.xCategories);
  });
});

describe("selectionEventToGate", () => {
  const series = {
    ids: [],
    x: [],
    y: [],
    xCategories: [
      encodeAnalysisCategoryKey(["a"]),
      encodeAnalysisCategoryKey(["b"]),
    ],
    yCategories: null,
    xCategoryLabels: ["a", "b"],
    yCategoryLabels: null,
    skipped: 0,
  };

  it("converts a lasso path, carrying the category ordering along", () => {
    const gate = selectionEventToGate(
      { lassoPoints: { x: [0, 1, 1], y: [0, 0, 1] } },
      series,
    );
    expect(gate).toEqual({
      categoryKeyVersion: 1,
      vertices: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      xCategories: [
        encodeAnalysisCategoryKey(["a"]),
        encodeAnalysisCategoryKey(["b"]),
      ],
      yCategories: null,
    });
  });

  it("converts a box-select range into a four-corner polygon", () => {
    const gate = selectionEventToGate(
      { range: { x: [0, 10], y: [0, 5] } },
      series,
    );
    expect(gate!.vertices).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ]);
  });

  it("returns null for a payload with neither lasso nor range", () => {
    // Plotly emits bare events during some internal clears; the caller must
    // leave the existing gate alone rather than wiping it.
    expect(selectionEventToGate(null, series)).toBeNull();
    expect(selectionEventToGate({}, series)).toBeNull();
    expect(
      selectionEventToGate({ lassoPoints: { x: [0, 1], y: [0, 1] } }, series),
    ).toBeNull(); // 2 points bound no area
  });
});

describe("chainPlotInputs", () => {
  const base = [annotation("a"), annotation("b"), annotation("c")];
  const plot = (id: string, overrides: Partial<IAnalysisPlot> = {}) =>
    ({
      id,
      xAxis: AREA,
      yAxis: INTENSITY,
      gate: SQUARE,
      gateEnabled: true,
      ...overrides,
    }) as IAnalysisPlot;

  it("gives each plot the population passing the PRECEDING gates only", () => {
    const inputs = chainPlotInputs(
      [plot("p1"), plot("p2"), plot("p3")],
      { p1: ["a", "b"], p2: ["a"] },
      base,
    );
    expect(inputs[0].map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(inputs[1].map((a) => a.id)).toEqual(["a", "b"]);
    expect(inputs[2].map((a) => a.id)).toEqual(["a"]);
  });

  it("skips a disabled gate", () => {
    const inputs = chainPlotInputs(
      [plot("p1", { gateEnabled: false }), plot("p2")],
      { p1: ["a"] },
      base,
    );
    expect(inputs[1].map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  it("skips a gate whose ids are not resolved yet", () => {
    // Between drawing a gate and its values arriving, drawing must not go empty.
    const inputs = chainPlotInputs([plot("p1"), plot("p2")], {}, base);
    expect(inputs[1].map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  it("skips a plot with no gate even if stale ids linger", () => {
    const inputs = chainPlotInputs(
      [plot("p1", { gate: null }), plot("p2")],
      { p1: ["a"] },
      base,
    );
    expect(inputs[1].map((a) => a.id)).toEqual(["a", "b", "c"]);
  });
});

describe("analysisPropertyPaths", () => {
  const plot = (x: any, y: any) =>
    ({
      id: "p",
      xAxis: x,
      yAxis: y,
      gate: null,
      gateEnabled: true,
    }) as IAnalysisPlot;

  it("collects property paths and de-duplicates them", () => {
    expect(
      analysisPropertyPaths([plot(AREA, INTENSITY), plot(AREA, AREA)]),
    ).toEqual([AREA.path, INTENSITY.path]);
  });

  it("returns nothing for categorical-only axes", () => {
    // Categorical axes read annotation fields, so they must not trigger a fetch.
    expect(analysisPropertyPaths([plot(TAGS, TAGS)])).toEqual([]);
  });
});

describe("populationSignature", () => {
  const pop = (ids: string[]) => ids.map((id) => annotation(id));

  it("distinguishes same-length populations", () => {
    // A length-only signature let a frame scrub under "current frame only" swap
    // the population without triggering a refresh, which read as "every object
    // is missing values" rather than as an error.
    expect(populationSignature(pop(["a", "b", "c"]))).not.toBe(
      populationSignature(pop(["x", "y", "z"])),
    );
  });

  it("is stable for the same population and handles empty", () => {
    expect(populationSignature(pop(["a", "b"]))).toBe(
      populationSignature(pop(["a", "b"])),
    );
    expect(populationSignature([])).toBe(populationSignature([]));
    expect(populationSignature([])).not.toBe(populationSignature(pop(["a"])));
  });
});

describe("jitterFromId", () => {
  it("stays within half a category slot and varies by salt", () => {
    for (const id of ["a", "bbbb", "6a628ed5505f0ded1b025063"]) {
      expect(Math.abs(jitterFromId(id, 17))).toBeLessThan(0.3);
    }
    expect(jitterFromId("a", 17)).not.toBe(jitterFromId("a", 31));
  });
});

describe("categoricalContentSignature", () => {
  const pop = (...tagLists: string[][]) =>
    tagLists.map((tags, i) => annotation(`id-${i}`, { tags }));

  it("changes when a tag changes but membership does not", () => {
    // The bug: editing an annotation's tags leaves the population and its ids
    // identical while moving the point to a different column, so an id-only
    // signature never re-ran the gate — the plot redrew under the new category
    // while the gate kept filtering by the old one.
    const before = categoricalContentSignature(pop(["a"], ["b"]), ["tags"]);
    const after = categoricalContentSignature(pop(["a"], ["c"]), ["tags"]);
    expect(after).not.toBe(before);
  });

  it("preserves annotation boundaries when tag values are redistributed", () => {
    // Flattening the values makes these populations indistinguishable even
    // though the first annotation moves from one tag column into two and the
    // second moves into the empty-tag category. A gate refresh must observe
    // that structural change.
    expect(categoricalContentSignature(pop(["a"], ["b"]), ["tags"])).not.toBe(
      categoricalContentSignature(pop(["a", "b"], []), ["tags"]),
    );
  });

  it("changes when a shape, channel or frame field changes", () => {
    const base = annotation("x", {
      shape: AnnotationShape.Point,
      channel: 0,
      location: { XY: 0, Z: 0, Time: 0 },
    });
    const sig = (a: TAnnotationOrStub, keys: any[]) =>
      categoricalContentSignature([a], keys);
    expect(sig({ ...base, channel: 1 }, ["channel"])).not.toBe(
      sig(base, ["channel"]),
    );
    expect(
      sig({ ...base, location: { XY: 0, Z: 3, Time: 0 } }, ["z"]),
    ).not.toBe(sig(base, ["z"]));
    expect(
      sig({ ...base, shape: AnnotationShape.Polygon }, ["shape"]),
    ).not.toBe(sig(base, ["shape"]));
  });

  it("only hashes the keys actually in use", () => {
    // A tag edit must not disturb a plot whose axes are shape-only, or every
    // unrelated edit would refetch.
    const a = pop(["a"]);
    const b = pop(["b"]);
    expect(categoricalContentSignature(b, ["shape"])).toBe(
      categoricalContentSignature(a, ["shape"]),
    );
  });

  it("is stable for identical content and cheap when no key is used", () => {
    expect(categoricalContentSignature(pop(["a"]), ["tags"])).toBe(
      categoricalContentSignature(pop(["a"]), ["tags"]),
    );
    expect(categoricalContentSignature(pop(["a"]), [])).toBe("-");
  });
});

describe("analysisCategoricalKeys", () => {
  const plot = (x: any, y: any) =>
    ({
      id: "p",
      xAxis: x,
      yAxis: y,
      gate: null,
      gateEnabled: true,
    }) as IAnalysisPlot;

  it("collects the categorical keys in use and de-duplicates them", () => {
    expect(
      analysisCategoricalKeys([plot(TAGS, AREA), plot(TAGS, TAGS)]),
    ).toEqual(["tags"]);
  });

  it("returns nothing when every axis is a property", () => {
    expect(analysisCategoricalKeys([plot(AREA, INTENSITY)])).toEqual([]);
  });
});

describe("shapeToGate", () => {
  const CATS = {
    xCategories: [encodeAnalysisCategoryKey(["a"])],
    yCategories: null,
  };

  it("parses a closed plotly path into gate vertices", () => {
    const gate = shapeToGate({ type: "path", path: "M1,2L3,4L5,0Z" }, CATS);
    expect(gate).toEqual({
      categoryKeyVersion: 1,
      vertices: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 0 },
      ],
      xCategories: CATS.xCategories,
      yCategories: null,
    });
  });

  it("parses decimals and negative coordinates", () => {
    const gate = shapeToGate(
      { type: "path", path: "M-1.5,2.25L3e2,-4L5,0Z" },
      CATS,
    );
    expect(gate?.vertices).toEqual([
      { x: -1.5, y: 2.25 },
      { x: 300, y: -4 },
      { x: 5, y: 0 },
    ]);
  });

  it("converts a rect shape into four corners", () => {
    const gate = shapeToGate(
      { type: "rect", x0: 1, x1: 5, y0: 2, y1: 6 },
      CATS,
    );
    expect(gate?.vertices).toEqual([
      { x: 1, y: 2 },
      { x: 5, y: 2 },
      { x: 5, y: 6 },
      { x: 1, y: 6 },
    ]);
  });

  it("returns null for malformed or degenerate shapes", () => {
    expect(shapeToGate({ type: "path", path: "M1,2Z" }, CATS)).toBeNull();
    expect(shapeToGate({ type: "path", path: "garbage" }, CATS)).toBeNull();
    expect(shapeToGate({ type: "rect", x0: 1 }, CATS)).toBeNull();
    expect(shapeToGate({ type: "circle" } as any, CATS)).toBeNull();
    expect(shapeToGate(null, CATS)).toBeNull();
  });
});
