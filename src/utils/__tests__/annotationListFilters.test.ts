import { describe, it, expect } from "vitest";
import { buildPropertyListFilters } from "@/utils/annotationListFilters";

describe("buildPropertyListFilters", () => {
  it("translates a range filter", () => {
    expect(
      buildPropertyListFilters([
        {
          propertyPath: ["p", "Area"],
          valuesOrRange: "range",
          range: { min: 1, max: 5 },
          values: [],
        },
      ]),
    ).toEqual([{ path: ["p", "Area"], mode: "range", min: 1, max: 5 }]);
  });

  it("translates a values filter", () => {
    expect(
      buildPropertyListFilters([
        {
          propertyPath: ["p", "Label"],
          valuesOrRange: "values",
          range: { min: 0, max: 0 },
          values: [2, 4],
        },
      ]),
    ).toEqual([{ path: ["p", "Label"], mode: "values", values: [2, 4] }]);
  });

  it("excludes filters that are explicitly disabled", () => {
    expect(
      buildPropertyListFilters([
        {
          propertyPath: ["p", "Area"],
          valuesOrRange: "range",
          range: { min: 1, max: 5 },
          enabled: false,
        },
      ]),
    ).toEqual([]);
  });

  it("includes filters with enabled left undefined", () => {
    const out = buildPropertyListFilters([
      {
        propertyPath: ["p", "Area"],
        valuesOrRange: "range",
        range: { min: 1, max: 5 },
      },
    ]);
    expect(out).toHaveLength(1);
  });

  it("returns an empty array for empty input", () => {
    expect(buildPropertyListFilters([])).toEqual([]);
  });
});
