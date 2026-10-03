import { describe, it, expect } from "vitest";
import {
  buildPropertyListFilters,
  sortsEqual,
} from "@/utils/annotationListFilters";

describe("sortsEqual", () => {
  it("treats two nulls as equal", () => {
    expect(sortsEqual(null, null)).toBe(true);
  });

  it("treats null and a sort as unequal", () => {
    expect(sortsEqual(null, { type: "field", key: "name", order: "asc" })).toBe(
      false,
    );
  });

  it("compares field sorts by type, key, and order", () => {
    const a = { type: "field" as const, key: "name", order: "asc" as const };
    expect(sortsEqual(a, { ...a })).toBe(true);
    expect(sortsEqual(a, { ...a, order: "desc" })).toBe(false);
    expect(sortsEqual(a, { ...a, key: "location.XY" })).toBe(false);
  });

  it("compares property sorts by their key path element-wise", () => {
    const a = {
      type: "property" as const,
      key: ["propA", "sub0"],
      order: "asc" as const,
    };
    expect(sortsEqual(a, { ...a, key: ["propA", "sub0"] })).toBe(true);
    expect(sortsEqual(a, { ...a, key: ["propA", "sub1"] })).toBe(false);
    expect(sortsEqual(a, { ...a, key: ["propA"] })).toBe(false);
  });

  it("treats a string key and a single-element array key as unequal", () => {
    // Different sort types/keys must not collapse together.
    expect(
      sortsEqual(
        { type: "field", key: "propA", order: "asc" },
        { type: "property", key: ["propA"], order: "asc" },
      ),
    ).toBe(false);
  });
});

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
