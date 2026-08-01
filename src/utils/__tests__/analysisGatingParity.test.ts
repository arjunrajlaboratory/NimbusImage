/**
 * Cross-language gating parity (SERVER_GATING.md, "Test strategy").
 *
 * Gate resolution has two implementations — this TypeScript module (below the
 * cap) and the Girder plugin's `server/helpers/analysis.py` (above it) — and
 * a dataset that grows past the cap must not change gate membership by
 * switching resolvers. This test pins the TS implementation to a committed
 * JSON fixture; the Python suite (`test_analysis_gating.py`) loads the same
 * file and must produce bit-identical jitter values and identical id sets.
 *
 * TS is the reference implementation. To change gating semantics, regenerate
 * the fixture with
 *
 *     UPDATE_PARITY_FIXTURE=1 pnpm vitest run src/utils/__tests__/analysisGatingParity.test.ts
 *
 * and expect the Python suite to fail until it is brought back into parity.
 * The fixture lives in the PLUGIN's test tree so tox finds it without
 * reaching outside its package.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildPlotSeries,
  encodeAnalysisCategoryKey,
  jitterFromId,
  resolveGateIds,
} from "@/utils/analysisGating";
import {
  AnnotationShape,
  IAnalysisGate,
  TAnalysisAxis,
  TAnnotationOrStub,
} from "@/store/model";

const FIXTURE_PATH = resolve(
  __dirname,
  "../../../devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/fixtures/analysis_gating_parity.json",
);

const X_SALT = 17;
const Y_SALT = 31;

interface IFixtureAnnotation {
  id: string;
  tags: string[];
  shape: string;
  channel: number;
  location: { XY: number; Z: number; Time: number };
}

interface IFixturePlot {
  xAxis: TAnalysisAxis;
  yAxis: TAnalysisAxis;
  gate: IAnalysisGate;
}

interface IFixtureGateCase {
  name: string;
  annotations: IFixtureAnnotation[];
  values: { [annotationId: string]: any };
  plots: IFixturePlot[];
  // One id list per plot: the PURE predicate over all case annotations —
  // deliberately unchained, matching what the server endpoint returns.
  expected: string[][];
}

interface IFixture {
  comment: string;
  jitterCases: { id: string; salt: number; expected: number }[];
  gateCases: IFixtureGateCase[];
}

function stub(a: IFixtureAnnotation): TAnnotationOrStub {
  return {
    id: a.id,
    centroid: { x: 0, y: 0 },
    location: a.location,
    shape: a.shape as AnnotationShape,
    channel: a.channel,
    tags: a.tags,
    color: null,
  } as TAnnotationOrStub;
}

const channelName = (channel: number) => `Channel ${channel}`;

/** The pure per-annotation predicate, as the client computes it. */
function resolvePure(gateCase: IFixtureGateCase, plot: IFixturePlot): string[] {
  const series = buildPlotSeries({
    annotations: gateCase.annotations.map(stub),
    values: gateCase.values,
    xAxis: plot.xAxis,
    yAxis: plot.yAxis,
    channelName,
    xCategoryOrder: plot.gate.xCategories,
    yCategoryOrder: plot.gate.yCategories,
  });
  return resolveGateIds(series, plot.gate);
}

function ann(
  id: string,
  overrides: Partial<IFixtureAnnotation> = {},
): IFixtureAnnotation {
  return {
    id,
    tags: [],
    shape: "point",
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
    ...overrides,
  };
}

const PROP_X: TAnalysisAxis = { type: "property", path: ["prop", "Area"] };
const PROP_Y: TAnalysisAxis = { type: "property", path: ["prop", "Mean"] };
const NESTED_Y: TAnalysisAxis = {
  type: "property",
  path: ["prop", "Centroid", "x"],
};
const TAGS_X: TAnalysisAxis = { type: "categorical", key: "tags" };
const CHANNEL_Y: TAnalysisAxis = { type: "categorical", key: "channel" };

function gate(
  vertices: { x: number; y: number }[],
  xCategories: string[] | null = null,
  yCategories: string[] | null = null,
): IAnalysisGate {
  return { categoryKeyVersion: 1, vertices, xCategories, yCategories };
}

const BOX = (x0: number, x1: number, y0: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

/** Everything below defines the fixture INPUTS; expectations are computed. */
function buildFixtureInputs(): Omit<IFixture, "jitterCases" | "gateCases"> & {
  jitterCases: Omit<IFixture["jitterCases"][number], "expected">[];
  gateCases: Omit<IFixtureGateCase, "expected">[];
} {
  const hexIds = [
    "69fa8984a3094194968568c3",
    "000000000000000000000000",
    "ffffffffffffffffffffffff",
    "0123456789abcdef01234567",
    "deadbeefdeadbeefdeadbeef",
    "5f2a9c1b8e7d6a4b3c2d1e0f",
    "aaaaaaaaaaaaaaaaaaaaaaaa",
    "123456789012345678901234",
  ];
  const oddIds = ["", "a", "tag-like-id", "💥astral💥", "ünïcödé"];
  const jitterCases = [...hexIds, ...oddIds].flatMap((id) => [
    { id, salt: X_SALT },
    { id, salt: Y_SALT },
  ]);

  const gateCases: Omit<IFixtureGateCase, "expected">[] = [
    {
      name: "property-x-property with missing and non-finite values",
      annotations: [
        ann("a1"),
        ann("a2"),
        ann("a3"),
        ann("a4"),
        ann("a5"),
        ann("a6"),
      ],
      values: {
        a1: { prop: { Area: 5, Mean: 5 } }, // inside
        a2: { prop: { Area: 50, Mean: 5 } }, // outside x
        a3: { prop: { Area: 5 } }, // missing Mean
        a4: { prop: { Mean: 5 } }, // missing Area
        a5: { prop: { Area: null, Mean: 5 } }, // null is not a value
        a6: { prop: { Area: "5", Mean: 5 } }, // string is not a value
      },
      plots: [{ xAxis: PROP_X, yAxis: PROP_Y, gate: gate(BOX(0, 10, 0, 10)) }],
    },
    {
      name: "nested property path",
      annotations: [ann("n1"), ann("n2")],
      values: {
        n1: { prop: { Area: 1, Centroid: { x: 3 } } },
        n2: { prop: { Area: 1, Centroid: { x: 30 } } },
      },
      plots: [{ xAxis: PROP_X, yAxis: NESTED_Y, gate: gate(BOX(0, 2, 0, 10)) }],
    },
    {
      name: "tags axis with astral tag and duplicate display labels",
      annotations: [
        ann("t1", { tags: ["A", "B"] }), // key v1:["A","B"], label "A, B"
        ann("t2", { tags: ["A, B"] }), // same LABEL, different key
        ann("t3", { tags: ["💥boom"] }),
        ann("t4", { tags: [] }), // (untagged)
        ann("t5", { tags: ["B", "A"] }), // sorts to same key as t1
      ],
      values: {
        t1: { prop: { Mean: 1 } },
        t2: { prop: { Mean: 1 } },
        t3: { prop: { Mean: 1 } },
        t4: { prop: { Mean: 1 } },
        t5: { prop: { Mean: 1 } },
      },
      plots: [
        {
          xAxis: TAGS_X,
          yAxis: PROP_Y,
          // Pinned order: [A,B] at 0, "A, B" at 1, untagged at 2, 💥boom at 3.
          // Polygon covers indices 0 and 1 only.
          gate: gate(
            BOX(-0.4, 1.4, 0, 2),
            [
              encodeAnalysisCategoryKey(["A", "B"]),
              encodeAnalysisCategoryKey(["A, B"]),
              encodeAnalysisCategoryKey([]),
              encodeAnalysisCategoryKey(["💥boom"]),
            ],
            null,
          ),
        },
      ],
    },
    {
      name: "categorical-x-categorical (tags by channel)",
      annotations: [
        ann("c1", { tags: ["red"], channel: 0 }),
        ann("c2", { tags: ["red"], channel: 1 }),
        ann("c3", { tags: ["blue"], channel: 0 }),
        ann("c4", { tags: ["blue"], channel: 2 }),
      ],
      values: {},
      plots: [
        {
          xAxis: TAGS_X,
          yAxis: CHANNEL_Y,
          gate: gate(
            BOX(-0.4, 0.4, -0.4, 1.4),
            [
              encodeAnalysisCategoryKey(["blue"]),
              encodeAnalysisCategoryKey(["red"]),
            ],
            [encodeAnalysisCategoryKey(0), encodeAnalysisCategoryKey(1)],
          ),
        },
      ],
    },
    {
      name: "degenerate gate: fewer than 3 vertices matches nothing",
      annotations: [ann("d1")],
      values: { d1: { prop: { Area: 1, Mean: 1 } } },
      plots: [
        {
          xAxis: PROP_X,
          yAxis: PROP_Y,
          gate: gate([
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ]),
        },
      ],
    },
    {
      name: "polygon slicing a jittered strip: jitter decides membership",
      // 12 annotations in one tag category; the polygon covers only the left
      // part of the strip (x in [-0.29, 0]), so membership depends on each
      // id's jitter sign — exactly what the Python port must reproduce.
      // Realistic 24-hex ids: short sequential ids hash too similarly to
      // discriminate (verified: this set splits 2 in / 10 out).
      annotations: Array.from({ length: 12 }, (_, i) =>
        ann(`${i.toString(16).padStart(4, "0")}abc0123456789def0123`, {
          tags: ["only"],
        }),
      ),
      values: Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [
          `${i.toString(16).padStart(4, "0")}abc0123456789def0123`,
          { prop: { Mean: 1 } },
        ]),
      ),
      plots: [
        {
          xAxis: TAGS_X,
          yAxis: PROP_Y,
          gate: gate(
            BOX(-0.29, 0, 0, 2),
            [encodeAnalysisCategoryKey(["only"])],
            null,
          ),
        },
      ],
    },
    {
      name: "unknown categories are outside the gate",
      annotations: [
        ann("k1", { tags: ["known"] }),
        ann("k2", { tags: ["appeared-later"] }),
      ],
      values: { k1: { prop: { Mean: 1 } }, k2: { prop: { Mean: 1 } } },
      plots: [
        {
          xAxis: TAGS_X,
          yAxis: PROP_Y,
          // Polygon spans far past the appended index; k2 still never matches.
          gate: gate(
            BOX(-0.5, 5, 0, 2),
            [encodeAnalysisCategoryKey(["known"])],
            null,
          ),
        },
      ],
    },
    {
      name: "location axes (xy/z/time) as categories",
      annotations: [
        ann("l1", { location: { XY: 0, Z: 2, Time: 0 } }),
        ann("l2", { location: { XY: 0, Z: 5, Time: 0 } }),
      ],
      values: { l1: { prop: { Mean: 1 } }, l2: { prop: { Mean: 1 } } },
      plots: [
        {
          xAxis: { type: "categorical", key: "z" },
          yAxis: PROP_Y,
          gate: gate(
            BOX(-0.4, 0.4, 0, 2),
            [encodeAnalysisCategoryKey(2), encodeAnalysisCategoryKey(5)],
            null,
          ),
        },
      ],
    },
  ];

  return {
    comment:
      "GENERATED by analysisGatingParity.test.ts (TS is the reference " +
      "implementation) — do not edit by hand. Regenerate with " +
      "UPDATE_PARITY_FIXTURE=1 pnpm vitest run " +
      "src/utils/__tests__/analysisGatingParity.test.ts",
    jitterCases,
    gateCases,
  };
}

function computeFixture(): IFixture {
  const inputs = buildFixtureInputs();
  return {
    comment: inputs.comment,
    jitterCases: inputs.jitterCases.map((c) => ({
      ...c,
      expected: jitterFromId(c.id, c.salt),
    })),
    gateCases: inputs.gateCases.map((c) => {
      const gateCase = c as IFixtureGateCase;
      return {
        ...gateCase,
        expected: gateCase.plots.map((plot) => resolvePure(gateCase, plot)),
      };
    }),
  };
}

describe("analysis gating parity fixture", () => {
  if (process.env.UPDATE_PARITY_FIXTURE) {
    it("regenerates the fixture from the TS implementation", () => {
      const fixture = computeFixture();
      writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n");
      expect(existsSync(FIXTURE_PATH)).toBe(true);
    });
    return;
  }

  const fixture: IFixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

  it("has the case coverage the spec demands", () => {
    expect(fixture.jitterCases.length).toBeGreaterThanOrEqual(20);
    expect(fixture.gateCases.length).toBeGreaterThanOrEqual(7);
  });

  it.each(fixture.jitterCases)(
    "jitter($id, $salt) is bit-exact",
    ({ id, salt, expected }) => {
      // toBe, not toBeCloseTo: the Python port must match to the last bit,
      // and so must we against the committed value.
      expect(jitterFromId(id, salt)).toBe(expected);
    },
  );

  it.each(fixture.gateCases)("$name", (gateCase) => {
    gateCase.plots.forEach((plot, i) => {
      expect(resolvePure(gateCase, plot)).toEqual(gateCase.expected[i]);
    });
  });

  it("matches the current inputs (fixture is not stale)", () => {
    // If someone edits the case definitions above without regenerating, the
    // committed fixture silently tests the OLD cases. Compare structurally.
    expect(computeFixture()).toEqual(fixture);
  });
});
