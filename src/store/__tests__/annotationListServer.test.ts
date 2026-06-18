import { describe, it, expect } from "vitest";
import { buildListFilters } from "../annotationListServer";
import { IIdAnnotationFilter } from "../model";

// Disabled defaults so the id constraints are inactive unless a test
// explicitly enables them. Keeps the membership filters out of the way of the
// tag/location/property/idSubstring cases.
const disabledSelectionFilter: IIdAnnotationFilter = {
  enabled: false,
  exclusive: true,
  id: "selection",
  annotationIds: [],
};
const disabledAnnotationIdFilters: IIdAnnotationFilter[] = [];

describe("buildListFilters", () => {
  it("translates an enabled tag filter (inclusive)", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: true, exclusive: false, tags: ["A", "B"] },
      onlyCurrentFrame: false,
      currentFrame: { XY: 0, Z: 0, Time: 0 },
      idSubstring: "",
      propertyFilters: [],
      selectionFilter: disabledSelectionFilter,
      annotationIdFilters: disabledAnnotationIdFilters,
    });
    expect(filters.tags).toEqual({ values: ["A", "B"], exclusive: false });
    expect(filters.location).toBeUndefined();
    expect(filters.idConstraints).toBeUndefined();
  });

  it("includes location when onlyCurrentFrame is set", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: false, exclusive: false, tags: [] },
      onlyCurrentFrame: true,
      currentFrame: { XY: 2, Z: 1, Time: 0 },
      idSubstring: "",
      propertyFilters: [],
      selectionFilter: disabledSelectionFilter,
      annotationIdFilters: disabledAnnotationIdFilters,
    });
    expect(filters.location).toEqual({ XY: 2, Z: 1, Time: 0 });
  });

  it("translates a property range filter", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: false, exclusive: false, tags: [] },
      onlyCurrentFrame: false,
      currentFrame: { XY: 0, Z: 0, Time: 0 },
      idSubstring: "abc",
      propertyFilters: [
        {
          propertyPath: ["p", "Area"],
          valuesOrRange: "range",
          range: { min: 1, max: 5 },
          values: [],
        },
      ],
      selectionFilter: disabledSelectionFilter,
      annotationIdFilters: disabledAnnotationIdFilters,
    });
    expect(filters.idSubstring).toBe("abc");
    expect(filters.propertyFilters).toEqual([
      { path: ["p", "Area"], mode: "range", min: 1, max: 5 },
    ]);
  });

  it("adds an id constraint for an enabled selection filter", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: false, exclusive: false, tags: [] },
      onlyCurrentFrame: false,
      currentFrame: { XY: 0, Z: 0, Time: 0 },
      idSubstring: "",
      propertyFilters: [],
      selectionFilter: {
        enabled: true,
        exclusive: true,
        id: "selection",
        annotationIds: ["a", "b"],
      },
      annotationIdFilters: disabledAnnotationIdFilters,
    });
    expect(filters.idConstraints).toEqual([["a", "b"]]);
  });

  it("unions enabled annotation-id filters into one constraint", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: false, exclusive: false, tags: [] },
      onlyCurrentFrame: false,
      currentFrame: { XY: 0, Z: 0, Time: 0 },
      idSubstring: "",
      propertyFilters: [],
      selectionFilter: disabledSelectionFilter,
      annotationIdFilters: [
        { enabled: true, exclusive: true, id: "f0", annotationIds: ["a", "b"] },
        { enabled: true, exclusive: true, id: "f1", annotationIds: ["c"] },
      ],
    });
    expect(filters.idConstraints).toEqual([["a", "b", "c"]]);
  });

  it("ignores disabled annotation-id filters", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: false, exclusive: false, tags: [] },
      onlyCurrentFrame: false,
      currentFrame: { XY: 0, Z: 0, Time: 0 },
      idSubstring: "",
      propertyFilters: [],
      selectionFilter: disabledSelectionFilter,
      annotationIdFilters: [
        {
          enabled: false,
          exclusive: true,
          id: "f0",
          annotationIds: ["a", "b"],
        },
      ],
    });
    expect(filters.idConstraints).toBeUndefined();
  });

  it("produces two constraints when both selection and id filters apply", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: false, exclusive: false, tags: [] },
      onlyCurrentFrame: false,
      currentFrame: { XY: 0, Z: 0, Time: 0 },
      idSubstring: "",
      propertyFilters: [],
      selectionFilter: {
        enabled: true,
        exclusive: true,
        id: "selection",
        annotationIds: ["a", "b", "c"],
      },
      annotationIdFilters: [
        {
          enabled: true,
          exclusive: true,
          id: "f0",
          annotationIds: ["b", "c", "d"],
        },
      ],
    });
    expect(filters.idConstraints).toEqual([
      ["a", "b", "c"],
      ["b", "c", "d"],
    ]);
  });

  it("omits idConstraints when neither membership filter is enabled", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: false, exclusive: false, tags: [] },
      onlyCurrentFrame: false,
      currentFrame: { XY: 0, Z: 0, Time: 0 },
      idSubstring: "",
      propertyFilters: [],
      selectionFilter: disabledSelectionFilter,
      annotationIdFilters: disabledAnnotationIdFilters,
    });
    expect(filters.idConstraints).toBeUndefined();
  });
});
