import { describe, expect, it } from "vitest";
import { resolveAnnotationOverviewConfig } from "@/store/model";
import {
  annotationMatchesRasterSelector,
  annotationRasterSelectorsForLayers,
  annotationRasterSelectorsSupported,
  ANNOTATION_OVERVIEW_HYSTERESIS,
  MAX_ANNOTATION_RASTER_SELECTORS,
  annotationOverviewRasterActive,
  stableRandomSampleById,
  zoomForVectorAnnotations,
} from "./annotationOverview";

const slice = (type: string, value: number | null = null) => ({
  type,
  value,
});

const layer = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "layer",
    channel: 0,
    visible: true,
    xy: slice("current"),
    z: slice("current"),
    time: slice("current"),
    ...overrides,
  }) as any;

describe("stableRandomSampleById", () => {
  it("returns every item when the input is within the limit", () => {
    const items = [{ id: "a" }, { id: "b" }];
    expect(stableRandomSampleById(items, 5, (item) => item.id)).toEqual(items);
  });

  it("returns a stable pseudo-random subset at the requested limit", () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      id: `annotation-${index}`,
      index,
    }));
    const first = stableRandomSampleById(items, 5, (item) => item.id);
    const second = stableRandomSampleById(items, 5, (item) => item.id);

    expect(first).toHaveLength(5);
    expect(second).toEqual(first);
    expect(first.some((item) => item.index >= 5)).toBe(true);
  });
});

describe("annotationOverviewRasterActive", () => {
  const config = resolveAnnotationOverviewConfig({ enabled: true });

  it("switches to vectors at the configured threshold", () => {
    expect(
      annotationOverviewRasterActive({
        config,
        unitsPerPixel: config.vectorSwitchThreshold,
        wasActive: true,
        unrolling: false,
      }),
    ).toBe(false);
  });

  it("switches back to raster only beyond the hysteresis band", () => {
    const upper =
      config.vectorSwitchThreshold * (1 + ANNOTATION_OVERVIEW_HYSTERESIS);
    expect(
      annotationOverviewRasterActive({
        config,
        unitsPerPixel: upper,
        wasActive: false,
        unrolling: false,
      }),
    ).toBe(false);
    expect(
      annotationOverviewRasterActive({
        config,
        unitsPerPixel: upper + 0.01,
        wasActive: false,
        unrolling: false,
      }),
    ).toBe(true);
  });

  it("does not flap inside the hysteresis band", () => {
    const unitsPerPixel = config.vectorSwitchThreshold * 1.05;
    expect(
      annotationOverviewRasterActive({
        config,
        unitsPerPixel,
        wasActive: true,
        unrolling: false,
      }),
    ).toBe(true);
    expect(
      annotationOverviewRasterActive({
        config,
        unitsPerPixel,
        wasActive: false,
        unrolling: false,
      }),
    ).toBe(false);
  });

  it("always disables raster while unrolling or when configured off", () => {
    expect(
      annotationOverviewRasterActive({
        config,
        unitsPerPixel: 100,
        wasActive: true,
        unrolling: true,
      }),
    ).toBe(false);
    expect(
      annotationOverviewRasterActive({
        config: { ...config, enabled: false },
        unitsPerPixel: 100,
        wasActive: true,
        unrolling: false,
      }),
    ).toBe(false);
  });
});

describe("annotationRasterSelectorsForLayers", () => {
  it("matches visible current, offset, and max-merge layer predicates", () => {
    const layers = [
      layer({ id: "current", channel: 0 }),
      layer({
        id: "offset",
        channel: 2,
        z: slice("offset", 1),
      }),
      layer({
        id: "max-merge",
        channel: 3,
        z: slice("max-merge"),
        time: slice("max-merge"),
      }),
      layer({ id: "hidden", channel: 4, visible: false }),
      layer({ id: "invalid", channel: 5 }),
      layer({ id: "duplicate", channel: 0 }),
    ];

    expect(
      annotationRasterSelectorsForLayers({
        layers,
        showHiddenLayers: false,
        layerSliceIndexes: (candidate) => {
          if (candidate.id === "invalid") return null;
          if (candidate.id === "offset") {
            return { xyIndex: 2, zIndex: 4, tIndex: 6 };
          }
          return { xyIndex: 2, zIndex: 3, tIndex: 6 };
        },
      }),
    ).toEqual([
      { channel: 0, XY: 2, Z: 3, Time: 6 },
      { channel: 2, XY: 2, Z: 4, Time: 6 },
      { channel: 3, XY: 2 },
    ]);
  });

  it("includes hidden layers only when vector rendering does", () => {
    expect(
      annotationRasterSelectorsForLayers({
        layers: [layer({ channel: 4, visible: false })],
        showHiddenLayers: true,
        layerSliceIndexes: () => ({
          xyIndex: 1,
          zIndex: 2,
          tIndex: 3,
        }),
      }),
    ).toEqual([{ channel: 4, XY: 1, Z: 2, Time: 3 }]);
  });

  it("accepts the backend selector limit and rejects larger requests", () => {
    const selectors = Array.from(
      { length: MAX_ANNOTATION_RASTER_SELECTORS },
      (_, channel) => ({ channel }),
    );

    expect(annotationRasterSelectorsSupported(selectors)).toBe(true);
    expect(
      annotationRasterSelectorsSupported([...selectors, { channel: 64 }]),
    ).toBe(false);
  });

  it("matches fixed axes and treats omitted max-merge axes as wildcards", () => {
    const annotation = {
      channel: 2,
      location: { XY: 1, Z: 99, Time: 3 },
    };

    expect(
      annotationMatchesRasterSelector(annotation, {
        channel: 2,
        XY: 1,
        Time: 3,
      }),
    ).toBe(true);
    expect(
      annotationMatchesRasterSelector(annotation, {
        channel: 2,
        XY: 1,
        Z: 0,
        Time: 3,
      }),
    ).toBe(false);
    expect(
      annotationMatchesRasterSelector(annotation, {
        channel: 1,
        XY: 1,
        Time: 3,
      }),
    ).toBe(false);
  });
});

describe("zoomForVectorAnnotations", () => {
  it("zooms just past the vector threshold and respects max zoom", () => {
    const zoom = zoomForVectorAnnotations({
      currentZoom: 3,
      unitsPerPixel: 4,
      vectorSwitchThreshold: 1,
      maxZoom: 12,
    });
    expect(zoom).toBeGreaterThan(5);
    expect(zoom).toBeLessThan(5.1);

    expect(
      zoomForVectorAnnotations({
        currentZoom: 3,
        unitsPerPixel: 4,
        vectorSwitchThreshold: 1,
        maxZoom: 4,
      }),
    ).toBe(4);
  });

  it("does not change zoom when vectors are already visible", () => {
    expect(
      zoomForVectorAnnotations({
        currentZoom: 5,
        unitsPerPixel: 1,
        vectorSwitchThreshold: 1,
      }),
    ).toBeNull();
  });
});
