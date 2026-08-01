import { describe, it, expect, beforeEach } from "vitest";
import annotationListServer, {
  buildListFilters,
} from "../annotationListServer";
import filters from "../filters";
import { IIdAnnotationFilter } from "../model";

describe("annotationListServer defaults", () => {
  it("defaults to a page size of 10 (matching the client list)", () => {
    expect(annotationListServer.pageSize).toBe(10);
  });
});

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

  it("adds one AND constraint per analysis gate, not a union", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: false, exclusive: false, tags: [] },
      onlyCurrentFrame: false,
      currentFrame: { XY: 0, Z: 0, Time: 0 },
      idSubstring: "",
      propertyFilters: [],
      selectionFilter: disabledSelectionFilter,
      annotationIdFilters: disabledAnnotationIdFilters,
      // Only active gates reach here — the store's activeAnalysisGateIdLists
      // has already dropped disabled and unresolved ones.
      analysisGates: [["a", "b"], ["b"]],
    });
    // Two sets, NOT one unioned set: sequential gating is an AND.
    expect(filters.idConstraints).toEqual([["a", "b"], ["b"]]);
  });

  it("omits idConstraints when there are no analysis gates", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: false, exclusive: false, tags: [] },
      onlyCurrentFrame: false,
      currentFrame: { XY: 0, Z: 0, Time: 0 },
      idSubstring: "",
      propertyFilters: [],
      selectionFilter: disabledSelectionFilter,
      annotationIdFilters: disabledAnnotationIdFilters,
      analysisGates: [],
    });
    expect(filters.idConstraints).toBeUndefined();
  });
});

// An analysis gate resolved to zero annotations is a REAL gate meaning
// "nothing" — an empty lasso — and reaches buildListFilters as an empty inner
// idConstraints entry. The list API deliberately rejects [[]] with a 400 (see
// server/helpers/validation.py), so sending it left the request failed and the
// PREVIOUS rows on screen instead of showing zero results.
describe("queryMatchesNothing", () => {
  const GATE = {
    vertices: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ],
    xCategories: null,
    yCategories: null,
  };

  beforeEach(() => {
    filters.resetFilterState();
  });

  it("is false for an ordinary query", () => {
    expect(annotationListServer.queryMatchesNothing).toBe(false);
  });

  it("is true when a gate resolved to no annotations", () => {
    filters.addAnalysisPlot("p1");
    filters.setAnalysisPlotGate({ id: "p1", gate: GATE });
    filters.setAnalysisGateIds({ p1: [] });
    // The constraint the backend would reject...
    expect(annotationListServer.currentFilters.idConstraints).toEqual([[]]);
    // ...so the client answers it without asking.
    expect(annotationListServer.queryMatchesNothing).toBe(true);
  });

  it("is false again once the gate matches something", () => {
    filters.addAnalysisPlot("p1");
    filters.setAnalysisPlotGate({ id: "p1", gate: GATE });
    filters.setAnalysisGateIds({ p1: ["a"] });
    expect(annotationListServer.queryMatchesNothing).toBe(false);
  });
});
