import { describe, expect, it } from "vitest";
import { resolveAnnotationOverviewConfig } from "@/store/model";
import {
  ANNOTATION_OVERVIEW_HYSTERESIS,
  annotationOverviewRasterActive,
  stableRandomSampleById,
  zoomForVectorAnnotations,
} from "./annotationOverview";

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
