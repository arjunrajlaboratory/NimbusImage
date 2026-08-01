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
  jitterFromId,
  populationSignature,
  resolveGateIds,
  selectionEventToGate,
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

// A unit square gate covering x in [0,10], y in [0,10].
const SQUARE = {
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
    expect(first.xCategories).toEqual(["(untagged)", "alpha", "beta"]);
    // Each point sits within half a slot of its category index.
    first.ids.forEach((id, i) => {
      const category = first.xCategories!.indexOf(
        id === "a" ? "beta" : id === "b" ? "alpha" : "(untagged)",
      );
      expect(Math.abs(first.x[i] - category)).toBeLessThan(0.3);
      expect(first.x[i]).not.toBe(category); // jittered, not stacked
    });
    // Stable across rebuilds — a gate drawn over a jittered column has to
    // contain the same points when it is re-resolved in a later session.
    expect(build().x).toEqual(first.x);
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
      xCategoryOrder: ["alpha", "beta"],
    });
    expect(series.xCategories).toEqual(["alpha", "beta"]);
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
      xCategoryOrder: ["alpha", "beta"],
    });
    expect(series.xCategories).toEqual(["alpha", "beta", "gamma"]);
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
      }).xCategories![0];
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
      skipped: 0,
    };
    expect(resolveGateIds(points, vShape)).toEqual(["leftArm", "rightArm"]);
  });
});

describe("selectionEventToGate", () => {
  const series = {
    ids: [],
    x: [],
    y: [],
    xCategories: ["a", "b"],
    yCategories: null,
    skipped: 0,
  };

  it("converts a lasso path, carrying the category ordering along", () => {
    const gate = selectionEventToGate(
      { lassoPoints: { x: [0, 1, 1], y: [0, 0, 1] } },
      series,
    );
    expect(gate).toEqual({
      vertices: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      xCategories: ["a", "b"],
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
