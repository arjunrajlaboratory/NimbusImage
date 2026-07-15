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
  // Unified zoom + pan hysteresis: skip the refresh only when BOTH the zoom
  // magnification change is < fraction AND the center moved < fraction × the
  // viewport extent. fraction 0.2 → zoom threshold = log2(1.2) ≈ 0.263 levels;
  // pan threshold = 0.2 × extent. Here extent = 1000 → pan threshold = 200.
  const last = { zoom: 4, center: { x: 100, y: 100 } };
  const extent = 1000;

  it("refreshes when there is no prior refresh baseline", () => {
    expect(
      cameraRefreshNeeded(
        { zoom: 4, center: { x: 100, y: 100 } },
        null,
        0.2,
        extent,
      ),
    ).toBe(true);
  });

  it("skips a small pan below the distance threshold (zoom unchanged)", () => {
    // moved 100 < 200 → skip
    expect(
      cameraRefreshNeeded(
        { zoom: 4, center: { x: 200, y: 100 } },
        last,
        0.2,
        extent,
      ),
    ).toBe(false);
  });

  it("refreshes a pan at or beyond the distance threshold", () => {
    // moved 250 > 200 → refresh
    expect(
      cameraRefreshNeeded(
        { zoom: 4, center: { x: 350, y: 100 } },
        last,
        0.2,
        extent,
      ),
    ).toBe(true);
    // diagonal move: hypot(200,200) ≈ 283 > 200 → refresh
    expect(
      cameraRefreshNeeded(
        { zoom: 4, center: { x: 300, y: 300 } },
        last,
        0.2,
        extent,
      ),
    ).toBe(true);
  });

  it("skips a centered zoom change below the magnification threshold", () => {
    // |Δzoom| = 0.2 < log2(1.2) ≈ 0.263 → skip
    expect(
      cameraRefreshNeeded(
        { zoom: 4.2, center: { x: 100, y: 100 } },
        last,
        0.2,
        extent,
      ),
    ).toBe(false);
  });

  it("refreshes a centered zoom change at or above the magnification threshold", () => {
    // |Δzoom| = 0.3 > 0.263 → refresh
    expect(
      cameraRefreshNeeded(
        { zoom: 4.3, center: { x: 100, y: 100 } },
        last,
        0.2,
        extent,
      ),
    ).toBe(true);
  });

  it("skips when both a small pan and a small zoom are below their thresholds", () => {
    // moved 100 < 200 AND |Δzoom| 0.2 < 0.263 → skip
    expect(
      cameraRefreshNeeded(
        { zoom: 4.2, center: { x: 180, y: 100 } },
        last,
        0.2,
        extent,
      ),
    ).toBe(false);
  });

  it("refreshes when a sub-threshold pan combines with an over-threshold zoom", () => {
    expect(
      cameraRefreshNeeded(
        { zoom: 4.3, center: { x: 180, y: 100 } },
        last,
        0.2,
        extent,
      ),
    ).toBe(true);
  });

  it("refreshes on any pan when the viewport extent is unknown", () => {
    // extent 0 → can't scale the pan distance → refresh on any center move (safe).
    expect(
      cameraRefreshNeeded(
        { zoom: 4, center: { x: 101, y: 100 } },
        last,
        0.2,
        0,
      ),
    ).toBe(true);
  });

  it("skips when nothing changed", () => {
    expect(
      cameraRefreshNeeded(
        { zoom: 4, center: { x: 100, y: 100 } },
        last,
        0.2,
        extent,
      ),
    ).toBe(false);
  });
});
