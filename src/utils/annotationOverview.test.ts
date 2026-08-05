import { describe, expect, it } from "vitest";
import { resolveAnnotationOverviewConfig } from "@/store/model";
import {
  ANNOTATION_OVERVIEW_HYSTERESIS,
  annotationOverviewRasterActive,
} from "./annotationOverview";

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
