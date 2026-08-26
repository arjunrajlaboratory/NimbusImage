/**
 * The one list every "something is narrowing your objects" surface counts: the
 * app-bar Filters badge, the app-bar Analysis badge, and the render-coverage
 * HUD suffix. The counting used to live in the store getters alone, so the HUD
 * had nothing to read and a restored gate could shrink the HUD's numbers with
 * no cue anywhere near them.
 */
import { describe, it, expect } from "vitest";
import {
  IActiveConstraintsInput,
  collectActiveConstraints,
  countActiveConstraints,
  describeAxis,
  summarizeActiveConstraints,
} from "@/utils/activeConstraints";
import { PropertyFilterMode } from "@/store/model";

const GATE = {
  categoryKeyVersion: 1 as const,
  vertices: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
  ],
  xCategories: null,
  yCategories: null,
};

function input(
  overrides: Partial<IActiveConstraintsInput> = {},
): IActiveConstraintsInput {
  return {
    tagFilter: { id: "tagFilter", exclusive: false, enabled: false, tags: [] },
    onlyCurrentFrame: false,
    selectionFilter: {
      id: "selection",
      exclusive: true,
      enabled: false,
      annotationIds: [],
    },
    showAnnotationsFromHiddenLayers: true,
    propertyFilters: [],
    roiFilters: [],
    annotationIdFilters: [],
    analysisPlots: [],
    analysisGateIds: {},
    ...overrides,
  };
}

function propertyFilter(enabled: boolean, path: string[]) {
  return {
    id: `pf-${path.join("-")}`,
    exclusive: false,
    enabled,
    propertyPath: path,
    range: { min: 0, max: 5 },
    valuesOrRange: PropertyFilterMode.Range,
    values: [],
  };
}

// Names come from the properties store in the app; the collectors stay free of
// it so they can run inside a store getter.
const resolveName = (path: string[]) =>
  ({ "p.Area": "Area", "p.PECAM1": "PECAM1" })[path.join(".")] ?? null;

describe("collectActiveConstraints", () => {
  it("is empty when nothing narrows the object set", () => {
    expect(collectActiveConstraints(input())).toEqual([]);
  });

  it("collects every filter kind the Filters panel exposes", () => {
    const constraints = collectActiveConstraints(
      input({
        tagFilter: {
          id: "tagFilter",
          exclusive: false,
          enabled: true,
          tags: ["nucleus"],
        },
        onlyCurrentFrame: true,
        selectionFilter: {
          id: "selection",
          exclusive: true,
          enabled: true,
          annotationIds: ["a"],
        },
        showAnnotationsFromHiddenLayers: false,
        propertyFilters: [propertyFilter(true, ["p", "Area"])],
        roiFilters: [
          { id: "roi-0", exclusive: false, enabled: true, roi: [] },
          { id: "roi-1", exclusive: false, enabled: false, roi: [] },
        ],
        annotationIdFilters: [
          {
            id: "list-0",
            exclusive: false,
            enabled: true,
            annotationIds: ["b"],
          },
        ],
      }),
    );
    expect(constraints.map((constraint) => constraint.kind)).toEqual([
      "tag",
      "currentFrame",
      "selection",
      "hiddenLayers",
      "property",
      "roi",
      "annotationId",
    ]);
    expect(
      constraints.every((constraint) => constraint.source === "filters"),
    ).toBe(true);
  });

  it("does not count disabled filters", () => {
    expect(
      collectActiveConstraints(
        input({
          tagFilter: {
            id: "tagFilter",
            exclusive: false,
            enabled: false,
            tags: ["nucleus"],
          },
          propertyFilters: [propertyFilter(false, ["p", "Area"])],
        }),
      ),
    ).toEqual([]);
  });

  it("does not count an enabled values filter whose values list is empty", () => {
    // Emptying the values textarea deliberately writes `values: []`, which the
    // filtering path treats as pass-all (filters.ts) and the backend drops
    // (dropNoOpPropertyFilters). Counting it would make the HUD claim the
    // counts are narrowed while the viewer shows everything.
    const noOp = {
      ...propertyFilter(true, ["p", "Area"]),
      valuesOrRange: PropertyFilterMode.Values,
    };
    expect(
      collectActiveConstraints(input({ propertyFilters: [noOp] })),
    ).toEqual([]);
    expect(
      collectActiveConstraints(
        input({ propertyFilters: [{ ...noOp, values: undefined }] }),
      ),
    ).toEqual([]);
    // With values present the same filter narrows, so it is counted again.
    expect(
      collectActiveConstraints(
        input({ propertyFilters: [{ ...noOp, values: [3] }] }),
      ),
    ).toHaveLength(1);
  });

  it("counts a gate only once it is enabled, drawn AND resolved", () => {
    const plot = {
      id: "p1",
      xAxis: { type: "property" as const, path: ["p", "Area"] },
      yAxis: { type: "property" as const, path: ["p", "PECAM1"] },
      gate: GATE,
      gateEnabled: true,
    };
    // Enabled + drawn but unresolved: an unresolved gate constrains nothing,
    // so the viewer shows MORE than the final answer — nothing to announce.
    expect(
      collectActiveConstraints(input({ analysisPlots: [plot] })),
    ).toHaveLength(0);
    expect(
      collectActiveConstraints(
        input({ analysisPlots: [{ ...plot, gateEnabled: false }] }),
      ),
    ).toHaveLength(0);
    expect(
      collectActiveConstraints(
        input({ analysisPlots: [{ ...plot, gate: null }] }),
      ),
    ).toHaveLength(0);

    const constraints = collectActiveConstraints(
      input({ analysisPlots: [plot], analysisGateIds: { p1: ["a"] } }),
    );
    expect(constraints).toHaveLength(1);
    expect(constraints[0].source).toBe("analysis");
    expect(constraints[0].kind).toBe("gate");
  });
});

describe("countActiveConstraints", () => {
  const constraints = collectActiveConstraints(
    input({
      tagFilter: {
        id: "tagFilter",
        exclusive: false,
        enabled: true,
        tags: ["nucleus"],
      },
      propertyFilters: [propertyFilter(true, ["p", "Area"])],
      analysisPlots: [
        {
          id: "p1",
          xAxis: null,
          yAxis: null,
          gate: GATE,
          gateEnabled: true,
        },
      ],
      analysisGateIds: { p1: ["a"] },
    }),
  );

  it("counts each panel's own constraints separately", () => {
    expect(countActiveConstraints(constraints, "filters")).toBe(2);
    expect(countActiveConstraints(constraints, "analysis")).toBe(1);
  });

  it("counts everything narrowing the set when no panel is given", () => {
    // The HUD's number: the user reading "826 of 826 in view" cannot tell
    // which panel did the narrowing, so both count.
    expect(countActiveConstraints(constraints)).toBe(3);
  });
});

describe("describeAxis", () => {
  it("names categorical axes from the shared axis table", () => {
    expect(
      describeAxis({ type: "categorical", key: "tags" }, resolveName),
    ).toBe("Tags");
  });

  it("names property axes through the resolver", () => {
    expect(
      describeAxis({ type: "property", path: ["p", "Area"] }, resolveName),
    ).toBe("Area");
  });

  it("is null for an axis that has not been chosen", () => {
    expect(describeAxis(null, resolveName)).toBeNull();
  });
});

describe("summarizeActiveConstraints", () => {
  it("names the gate's plane and the filters alongside it", () => {
    const constraints = collectActiveConstraints(
      input({
        tagFilter: {
          id: "tagFilter",
          exclusive: false,
          enabled: true,
          tags: ["nucleus"],
        },
        analysisPlots: [
          {
            id: "p1",
            xAxis: { type: "property", path: ["p", "Area"] },
            yAxis: { type: "property", path: ["p", "PECAM1"] },
            gate: GATE,
            gateEnabled: true,
          },
        ],
        analysisGateIds: { p1: ["a"] },
      }),
    );
    expect(summarizeActiveConstraints(constraints, resolveName)).toBe(
      "1 tag filter; 1 lasso gate on Area × PECAM1",
    );
  });

  it("collapses identical constraints into a pluralized count", () => {
    const constraints = collectActiveConstraints(
      input({
        propertyFilters: [
          propertyFilter(true, ["p", "Area"]),
          propertyFilter(true, ["p", "Area"]),
          propertyFilter(true, ["p", "PECAM1"]),
        ],
      }),
    );
    expect(summarizeActiveConstraints(constraints, resolveName)).toBe(
      "2 property filters on Area; 1 property filter on PECAM1",
    );
  });

  it("omits the plane of a half-configured gate rather than implying one axis", () => {
    const constraints = collectActiveConstraints(
      input({
        analysisPlots: [
          {
            id: "p1",
            xAxis: { type: "property", path: ["p", "Area"] },
            yAxis: null,
            gate: GATE,
            gateEnabled: true,
          },
        ],
        analysisGateIds: { p1: ["a"] },
      }),
    );
    expect(summarizeActiveConstraints(constraints, resolveName)).toBe(
      "1 lasso gate",
    );
  });

  it("falls back to no property name when the path no longer resolves", () => {
    const constraints = collectActiveConstraints(
      input({ propertyFilters: [propertyFilter(true, ["p", "Gone"])] }),
    );
    expect(summarizeActiveConstraints(constraints, resolveName)).toBe(
      "1 property filter",
    );
  });
});
