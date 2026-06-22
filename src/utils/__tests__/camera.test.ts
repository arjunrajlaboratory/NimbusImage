import { describe, it, expect } from "vitest";
import { recenterCameraInfo, cameraRefreshNeeded } from "@/utils/camera";
import type { ICameraInfo } from "@/store/model";

function makeCameraInfo(): ICameraInfo {
  return {
    center: { x: 100, y: 100 },
    zoom: 3,
    rotate: 0.5,
    // A 20x10 viewport box centered on (100, 100).
    gcsBounds: [
      { x: 90, y: 95 },
      { x: 110, y: 95 },
      { x: 110, y: 105 },
      { x: 90, y: 105 },
    ],
  };
}

describe("recenterCameraInfo", () => {
  it("translates gcsBounds by the center delta (pure pan)", () => {
    const result = recenterCameraInfo(makeCameraInfo(), { x: 300, y: 250 });
    // delta = (300 - 100, 250 - 100) = (200, 150)
    expect(result.gcsBounds).toEqual([
      { x: 290, y: 245 },
      { x: 310, y: 245 },
      { x: 310, y: 255 },
      { x: 290, y: 255 },
    ]);
  });

  it("sets the new center", () => {
    const result = recenterCameraInfo(makeCameraInfo(), { x: 300, y: 250 });
    expect(result.center).toEqual({ x: 300, y: 250 });
  });

  it("preserves zoom and rotation (a pan changes neither)", () => {
    const result = recenterCameraInfo(makeCameraInfo(), { x: 300, y: 250 });
    expect(result.zoom).toBe(3);
    expect(result.rotate).toBe(0.5);
  });

  it("leaves bounds unchanged when the center does not move", () => {
    const info = makeCameraInfo();
    const result = recenterCameraInfo(info, { x: 100, y: 100 });
    expect(result.gcsBounds).toEqual(info.gcsBounds);
  });

  it("does not mutate the input camera info", () => {
    const info = makeCameraInfo();
    recenterCameraInfo(info, { x: 300, y: 250 });
    expect(info.center).toEqual({ x: 100, y: 100 });
    expect(info.gcsBounds[0]).toEqual({ x: 90, y: 95 });
  });

  it("preserves a per-corner z coordinate while translating x/y", () => {
    const info = makeCameraInfo();
    info.gcsBounds[0] = { x: 90, y: 95, z: 7 };
    const result = recenterCameraInfo(info, { x: 300, y: 250 });
    expect(result.gcsBounds[0]).toEqual({ x: 290, y: 245, z: 7 });
  });
});

describe("cameraRefreshNeeded", () => {
  // Zoom-only hysteresis (user choice): pans always refresh; a centered zoom
  // refreshes only once the magnification has changed by >= the fraction.
  // fraction 0.2 → threshold = log2(1.2) ≈ 0.263 zoom levels.
  const last = { zoom: 4, center: { x: 100, y: 100 } };

  it("refreshes when there is no prior refresh baseline", () => {
    expect(
      cameraRefreshNeeded({ zoom: 4, center: { x: 100, y: 100 } }, null, 0.2),
    ).toBe(true);
  });

  it("always refreshes on a pan (any center move), even with zoom unchanged", () => {
    expect(
      cameraRefreshNeeded({ zoom: 4, center: { x: 101, y: 100 } }, last, 0.2),
    ).toBe(true);
    expect(
      cameraRefreshNeeded({ zoom: 4, center: { x: 100, y: 100.5 } }, last, 0.2),
    ).toBe(true);
  });

  it("skips a centered zoom change below the magnification threshold", () => {
    // |Δzoom| = 0.2 < log2(1.2) ≈ 0.263 → skip
    expect(
      cameraRefreshNeeded({ zoom: 4.2, center: { x: 100, y: 100 } }, last, 0.2),
    ).toBe(false);
    expect(
      cameraRefreshNeeded({ zoom: 3.8, center: { x: 100, y: 100 } }, last, 0.2),
    ).toBe(false);
  });

  it("refreshes a centered zoom change at or above the magnification threshold", () => {
    // |Δzoom| = 0.3 > 0.263 → refresh
    expect(
      cameraRefreshNeeded({ zoom: 4.3, center: { x: 100, y: 100 } }, last, 0.2),
    ).toBe(true);
    expect(
      cameraRefreshNeeded({ zoom: 3.7, center: { x: 100, y: 100 } }, last, 0.2),
    ).toBe(true);
  });

  it("skips when nothing changed", () => {
    expect(
      cameraRefreshNeeded({ zoom: 4, center: { x: 100, y: 100 } }, last, 0.2),
    ).toBe(false);
  });

  it("respects a different fraction", () => {
    // fraction 1.0 → threshold = log2(2) = 1 level. Δzoom 0.9 skips, 1.0 refreshes.
    expect(
      cameraRefreshNeeded({ zoom: 4.9, center: { x: 100, y: 100 } }, last, 1.0),
    ).toBe(false);
    expect(
      cameraRefreshNeeded({ zoom: 5.0, center: { x: 100, y: 100 } }, last, 1.0),
    ).toBe(true);
  });
});
