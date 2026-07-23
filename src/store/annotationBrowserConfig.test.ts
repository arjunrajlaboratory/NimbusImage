/**
 * Tests for persisting the annotation browser's interface state (displayed
 * property columns, property filter rows and their ranges) in the
 * configuration metadata.
 *
 * Covers the three store-level guarantees the feature relies on:
 * - user-initiated toggles/filter edits schedule a configuration save,
 *   while hydration from a loaded configuration never does;
 * - resolveAnnotationBrowserConfig drops malformed entries and paths that
 *   reference properties no longer attached to the configuration;
 * - updateDisplayedFromComputedProperties does not prune freshly-hydrated
 *   paths before any property values have been fetched.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scheduleAnnotationBrowserSave: vi.fn(),
}));

vi.mock("./index", () => ({
  default: {
    xy: 0,
    z: 0,
    time: 0,
    dataset: null,
    propertiesAPI: {},
    scheduleAnnotationBrowserSave: mocks.scheduleAnnotationBrowserSave,
  },
}));
vi.mock("./annotation", () => ({
  default: { annotations: [], selectedAnnotationIds: [], stubOnlyMode: false },
}));
vi.mock("./jobs", () => ({
  default: {},
  createProgressEventCallback: () => () => {},
  createErrorEventCallback: () => () => {},
}));
vi.mock("./progress", () => ({ default: {} }));
vi.mock("geojs", () => ({
  default: { util: { pointInPolygon: () => false } },
}));
vi.mock("@/utils/annotation", () => ({
  tagCloudFilterFunction: () => true,
  annotationTestPoints: () => [],
  canComputeAnnotationProperty: () => false,
}));

import filters from "./filters";
import properties from "./properties";
import {
  IPropertyAnnotationFilter,
  PropertyFilterMode,
  resolveAnnotationBrowserConfig,
} from "./model";

function makeFilter(propertyId: string): IPropertyAnnotationFilter {
  return {
    id: `filter-${propertyId}`,
    propertyPath: [propertyId],
    range: { min: 0, max: 10 },
    exclusive: false,
    enabled: true,
    valuesOrRange: PropertyFilterMode.Range,
  };
}

describe("annotation browser config persistence", () => {
  beforeEach(() => {
    filters.resetFilterState();
    properties.resetPropertyState();
    mocks.scheduleAnnotationBrowserSave.mockClear();
  });

  describe("save scheduling", () => {
    it("schedules a save when a property column is toggled", () => {
      properties.togglePropertyPathVisibility(["prop-a"]);
      expect(properties.displayedPropertyPaths).toEqual([["prop-a"]]);
      expect(mocks.scheduleAnnotationBrowserSave).toHaveBeenCalledTimes(1);
    });

    it("schedules a save when a filter row is toggled", () => {
      filters.togglePropertyPathFiltering(["prop-a"]);
      expect(filters.filterPaths).toEqual([["prop-a"]]);
      expect(mocks.scheduleAnnotationBrowserSave).toHaveBeenCalledTimes(1);
    });

    it("schedules a save when a property filter is updated", () => {
      filters.updatePropertyFilter(makeFilter("prop-a"));
      expect(filters.propertyFilters).toHaveLength(1);
      expect(mocks.scheduleAnnotationBrowserSave).toHaveBeenCalledTimes(1);
    });

    it("does not schedule a save when hydrating from a configuration", () => {
      properties.hydrateDisplayedPropertyPaths([["prop-a"], ["prop-b"]]);
      filters.hydrateAnnotationBrowserFilters({
        filterPaths: [["prop-a"]],
        propertyFilters: [makeFilter("prop-a")],
      });
      expect(properties.displayedPropertyPaths).toEqual([
        ["prop-a"],
        ["prop-b"],
      ]);
      expect(filters.filterPaths).toEqual([["prop-a"]]);
      expect(filters.propertyFilters).toHaveLength(1);
      expect(mocks.scheduleAnnotationBrowserSave).not.toHaveBeenCalled();
    });

    it("does not schedule a save on dataset-switch resets", () => {
      filters.resetFilterState();
      properties.resetPropertyState();
      expect(mocks.scheduleAnnotationBrowserSave).not.toHaveBeenCalled();
    });
  });

  describe("disabled filter enabled-state (Codex #1)", () => {
    it("re-enables an existing disabled filter when its row is re-added", () => {
      // A disabled orphan left behind after the row was removed.
      filters.hydrateAnnotationBrowserFilters({
        filterPaths: [],
        propertyFilters: [{ ...makeFilter("prop-a"), enabled: false }],
      });
      filters.togglePropertyPathFiltering(["prop-a"]);
      expect(filters.filterPaths).toEqual([["prop-a"]]);
      expect(filters.propertyFilters[0].enabled).toBe(true);
    });

    it("does not re-enable when a filter row is being removed", () => {
      filters.hydrateAnnotationBrowserFilters({
        filterPaths: [["prop-a"]],
        propertyFilters: [{ ...makeFilter("prop-a"), enabled: false }],
      });
      filters.togglePropertyPathFiltering(["prop-a"]); // removes the row
      expect(filters.filterPaths).toEqual([]);
      expect(filters.propertyFilters[0].enabled).toBe(false);
    });

    it("hydration preserves a deliberately disabled visible filter", () => {
      filters.hydrateAnnotationBrowserFilters({
        filterPaths: [["prop-a"]],
        propertyFilters: [{ ...makeFilter("prop-a"), enabled: false }],
      });
      // No store-level force-enable: the enabled:false state survives.
      expect(filters.propertyFilters[0].enabled).toBe(false);
      expect(mocks.scheduleAnnotationBrowserSave).not.toHaveBeenCalled();
    });
  });

  describe("resolveAnnotationBrowserConfig", () => {
    it("returns empty state for a configuration without the key", () => {
      expect(resolveAnnotationBrowserConfig(undefined, ["prop-a"])).toEqual({
        displayedPropertyPaths: [],
        filterPaths: [],
        propertyFilters: [],
      });
    });

    it("drops paths and filters referencing unknown properties", () => {
      const resolved = resolveAnnotationBrowserConfig(
        {
          displayedPropertyPaths: [["prop-a"], ["gone", "sub"]],
          filterPaths: [["gone"]],
          propertyFilters: [makeFilter("prop-a"), makeFilter("gone")],
        },
        ["prop-a"],
      );
      expect(resolved.displayedPropertyPaths).toEqual([["prop-a"]]);
      expect(resolved.filterPaths).toEqual([]);
      expect(resolved.propertyFilters).toEqual([makeFilter("prop-a")]);
    });

    it("tolerates malformed persisted data", () => {
      const resolved = resolveAnnotationBrowserConfig(
        {
          displayedPropertyPaths: [
            "not-a-path",
            [],
            [42],
            ["prop-a"],
          ] as unknown as string[][],
          filterPaths: "garbage" as unknown as string[][],
          propertyFilters: [
            { broken: true },
            makeFilter("prop-a"),
          ] as unknown as IPropertyAnnotationFilter[],
        },
        ["prop-a"],
      );
      expect(resolved.displayedPropertyPaths).toEqual([["prop-a"]]);
      expect(resolved.filterPaths).toEqual([]);
      expect(resolved.propertyFilters).toEqual([makeFilter("prop-a")]);
    });
  });

  describe("updateDisplayedFromComputedProperties prune guard", () => {
    it("keeps hydrated paths while no property values are available yet", () => {
      properties.hydrateDisplayedPropertyPaths([["prop-a"]]);
      // No properties/values fetched: computedPropertyPaths is empty.
      properties.updateDisplayedFromComputedProperties();
      expect(properties.displayedPropertyPaths).toEqual([["prop-a"]]);
    });

    it("still prunes stale paths once values are available", () => {
      // setPropertiesImpl is protected (the public setProperties action also
      // syncs propertyIds to the backend, which this test doesn't exercise).
      (
        properties as unknown as {
          setPropertiesImpl: (props: { id: string; name: string }[]) => void;
        }
      ).setPropertiesImpl([
        { id: "prop-a", name: "A" },
        { id: "prop-b", name: "B" },
      ]);
      properties.updatePropertyValues({
        "annotation-1": { "prop-a": 1 },
      } as never);
      properties.hydrateDisplayedPropertyPaths([["prop-a"], ["prop-b"]]);
      properties.updateDisplayedFromComputedProperties();
      expect(properties.displayedPropertyPaths).toEqual([["prop-a"]]);
    });
  });
});
