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
import { IPropertyAnnotationFilter, PropertyFilterMode } from "./model";
import {
  buildAnnotationBrowserConfig,
  resolveAnnotationBrowserConfig,
} from "@/utils/annotationBrowserConfig";

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

    it("schedules a save when a visible property filter is updated", () => {
      filters.hydrateAnnotationBrowserFilters({
        filterPaths: [["prop-a"]],
        propertyFilters: [],
      });
      filters.updatePropertyFilter(makeFilter("prop-a"));
      expect(filters.propertyFilters).toHaveLength(1);
      expect(mocks.scheduleAnnotationBrowserSave).toHaveBeenCalledTimes(1);
    });

    it("keeps chat-created property filters session-only", () => {
      filters.updatePropertyFilter(makeFilter("prop-a"));
      expect(filters.propertyFilters).toHaveLength(1);
      expect(mocks.scheduleAnnotationBrowserSave).not.toHaveBeenCalled();
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

  describe("filter row ownership", () => {
    it("removes the property filter with its row", () => {
      filters.hydrateAnnotationBrowserFilters({
        filterPaths: [["prop-a"]],
        propertyFilters: [makeFilter("prop-a")],
      });
      filters.togglePropertyPathFiltering(["prop-a"]);
      expect(filters.filterPaths).toEqual([]);
      expect(filters.propertyFilters).toEqual([]);
      expect(mocks.scheduleAnnotationBrowserSave).toHaveBeenCalledTimes(1);
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
        analysisPlots: [],
      });
    });

    it("drops paths and filters referencing unknown properties", () => {
      const resolved = resolveAnnotationBrowserConfig(
        {
          displayedPropertyPaths: [["prop-a"], ["gone", "sub"]],
          filterPaths: [["prop-a"], ["gone"]],
          propertyFilters: [makeFilter("prop-a"), makeFilter("gone")],
        },
        ["prop-a"],
      );
      expect(resolved.displayedPropertyPaths).toEqual([["prop-a"]]);
      expect(resolved.filterPaths).toEqual([["prop-a"]]);
      expect(resolved.propertyFilters).toEqual([makeFilter("prop-a")]);
    });

    it("drops property filters with no corresponding visible row", () => {
      const resolved = resolveAnnotationBrowserConfig(
        {
          displayedPropertyPaths: [],
          filterPaths: [], // no rows
          propertyFilters: [makeFilter("prop-a")], // known property, but hidden
        },
        ["prop-a"],
      );
      expect(resolved.propertyFilters).toEqual([]);
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
      // filterPaths resolved to empty, so no filter has a visible row.
      expect(resolved.propertyFilters).toEqual([]);
    });
  });

  describe("buildAnnotationBrowserConfig", () => {
    it("omits session-only filters without a visible row", () => {
      const built = buildAnnotationBrowserConfig(
        [["prop-a"]],
        [["prop-a"]],
        [makeFilter("prop-a"), { ...makeFilter("prop-b"), enabled: false }],
        [],
      );
      expect(built.displayedPropertyPaths).toEqual([["prop-a"]]);
      expect(built.filterPaths).toEqual([["prop-a"]]);
      expect(built.propertyFilters).toEqual([makeFilter("prop-a")]);
    });

    it("returns copies rather than the input arrays", () => {
      const displayed = [["prop-a"]];
      const filterPaths = [["prop-a"]];
      const built = buildAnnotationBrowserConfig(
        displayed,
        filterPaths,
        [makeFilter("prop-a")],
        [],
      );
      expect(built.displayedPropertyPaths).not.toBe(displayed);
      expect(built.filterPaths).not.toBe(filterPaths);
    });
  });

  describe("analysis plots", () => {
    const GATE = {
      categoryKeyVersion: 1 as const,
      vertices: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      xCategories: null,
      yCategories: ["v1:[]"],
    };
    const plot = (overrides: any = {}) => ({
      id: "p1",
      xAxis: { type: "property", path: ["prop-a", "Area"] },
      yAxis: { type: "categorical", key: "tags" },
      gate: GATE,
      gateEnabled: true,
      ...overrides,
    });

    it("persists the gate polygon and survives a round trip", () => {
      const built = buildAnnotationBrowserConfig([], [], [], [plot() as any]);
      expect(
        resolveAnnotationBrowserConfig(built, ["prop-a"]).analysisPlots,
      ).toEqual([plot()]);
    });

    it("never persists resolved annotation ids", () => {
      // The whole reason gates are polygons: ids belong to one dataset, while a
      // configuration is shared by every dataset that uses it.
      const built = buildAnnotationBrowserConfig(
        [],
        [],
        [],
        [plot({ gateAnnotationIds: ["a", "b"] }) as any],
      );
      expect(JSON.stringify(built)).not.toContain("gateAnnotationIds");
    });

    it("drops a plot's axis when its property left the configuration", () => {
      const resolved = resolveAnnotationBrowserConfig(
        { analysisPlots: [plot() as any] },
        ["other-prop"],
      );
      // Axis gone, and the gate with it: the polygon's coordinates are only
      // meaningful against the axes it was drawn on.
      expect(resolved.analysisPlots![0].xAxis).toBeNull();
      expect(resolved.analysisPlots![0].gate).toBeNull();
    });

    it("drops an unknown categorical key rather than trusting it", () => {
      const resolved = resolveAnnotationBrowserConfig(
        {
          analysisPlots: [
            plot({ yAxis: { type: "categorical", key: "nope" } }) as any,
          ],
        },
        ["prop-a"],
      );
      expect(resolved.analysisPlots![0].yAxis).toBeNull();
      expect(resolved.analysisPlots![0].gate).toBeNull();
    });

    it("drops an unversioned legacy label even when it looks encoded", () => {
      const resolved = resolveAnnotationBrowserConfig(
        {
          analysisPlots: [
            plot({
              gate: {
                ...GATE,
                categoryKeyVersion: undefined,
                yCategories: ['v1:["A"]'],
              },
            }) as any,
          ],
        },
        ["prop-a"],
      );

      expect(resolved.analysisPlots![0].gate).toBeNull();
    });

    it("upgrades a legacy property-only gate to the current key version", () => {
      const resolved = resolveAnnotationBrowserConfig(
        {
          analysisPlots: [
            plot({
              yAxis: { type: "property", path: ["prop-a", "Mean"] },
              gate: {
                ...GATE,
                categoryKeyVersion: undefined,
                xCategories: null,
                yCategories: null,
              },
            }) as any,
          ],
        },
        ["prop-a"],
      );

      expect(resolved.analysisPlots![0].gate?.categoryKeyVersion).toBe(1);
    });

    it("drops malformed gates and plots", () => {
      const resolved = resolveAnnotationBrowserConfig(
        {
          analysisPlots: [
            plot({ gate: { vertices: [{ x: 0, y: 0 }] } }) as any, // < 3 vertices
            plot({ id: "p2", gate: { vertices: [{ x: 0 }, {}, {}] } }) as any,
            plot({ id: "" }) as any, // no usable id
            "not an object" as any,
          ],
        },
        ["prop-a"],
      );
      expect(resolved.analysisPlots!.map((p) => p.id)).toEqual(["p1", "p2"]);
      expect(resolved.analysisPlots!.every((p) => p.gate === null)).toBe(true);
    });

    it("defaults a missing gateEnabled to true", () => {
      const resolved = resolveAnnotationBrowserConfig(
        { analysisPlots: [plot({ gateEnabled: undefined }) as any] },
        ["prop-a"],
      );
      expect(resolved.analysisPlots![0].gateEnabled).toBe(true);
    });

    it("tolerates a configuration saved before analysis plots existed", () => {
      expect(
        resolveAnnotationBrowserConfig({ filterPaths: [] }, ["prop-a"])
          .analysisPlots,
      ).toEqual([]);
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
