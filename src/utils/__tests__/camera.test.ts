import { describe, it, expect } from "vitest";
import {
  recenterCameraInfo,
  frameCameraInfo,
  cameraRefreshNeeded,
} from "@/utils/camera";
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
  // Pan refreshes on ANY amount (zoom unchanged this event); zoom keeps a
  // magnification hysteresis vs the last refresh: fraction 0.2 → threshold
  // log2(1.2) ≈ 0.263 levels. Args: (current, lastRefresh, lastEvent, fraction).
  const refresh = { zoom: 4, center: { x: 100, y: 100 } };
  // "prev event" at the same zoom as the refresh, unless a test overrides it.
  const sameZoomEvent = { zoom: 4, center: { x: 100, y: 100 } };

  it("refreshes when there is no prior refresh baseline", () => {
    expect(
      cameraRefreshNeeded(
        { zoom: 4, center: { x: 100, y: 100 } },
        null,
        null,
        0.2,
      ),
    ).toBe(true);
  });

  it("refreshes on any pan when the zoom is unchanged this event", () => {
    // Even a 1-unit move refreshes now (no pan threshold).
    expect(
      cameraRefreshNeeded(
        { zoom: 4, center: { x: 101, y: 100 } },
        refresh,
        sameZoomEvent,
        0.2,
      ),
    ).toBe(true);
  });

  it("skips a centered zoom change below the magnification threshold", () => {
    // |Δzoom| = 0.2 < log2(1.2) ≈ 0.263, center unchanged → skip
    expect(
      cameraRefreshNeeded(
        { zoom: 4.2, center: { x: 100, y: 100 } },
        refresh,
        sameZoomEvent,
        0.2,
      ),
    ).toBe(false);
  });

  it("refreshes a centered zoom change at or above the magnification threshold", () => {
    expect(
      cameraRefreshNeeded(
        { zoom: 4.3, center: { x: 100, y: 100 } },
        refresh,
        sameZoomEvent,
        0.2,
      ),
    ).toBe(true);
  });

  it("keeps zoom hysteresis when a sub-threshold zoom also drifts the center", () => {
    // Scroll-wheel zoom: this event changed the zoom (4 → 4.2) and drifted the
    // center. Because the zoom changed THIS event, the drift is not a pan → skip.
    expect(
      cameraRefreshNeeded(
        { zoom: 4.2, center: { x: 180, y: 100 } },
        refresh,
        sameZoomEvent, // previous event was at zoom 4
        0.2,
      ),
    ).toBe(false);
  });

  it("refreshes a pan after a sub-threshold zoom (does not get poisoned by the frozen refresh baseline)", () => {
    // Regression: a sub-threshold zoom left the refresh baseline frozen at
    // zoom 4, and the previous event is now at zoom 4.2. A subsequent pure pan
    // (still zoom 4.2, center moved) must refresh — the zoom is unchanged vs the
    // previous event, so it's a pan, even though |4.2 - 4| ≠ 0 vs the refresh.
    expect(
      cameraRefreshNeeded(
        { zoom: 4.2, center: { x: 200, y: 100 } },
        refresh, // last refresh still at zoom 4
        { zoom: 4.2, center: { x: 100, y: 100 } }, // previous event at zoom 4.2
        0.2,
      ),
    ).toBe(true);
  });

  it("keeps zoom hysteresis on the FIRST camera event (no previous event)", () => {
    // A non-camera refresh (e.g. a frame change) set lastRefresh but there is no
    // prior camera event yet. A sub-threshold cursor-centered zoom drifts the
    // center; it must be read as a zoom (vs the last-refresh zoom), not a pan.
    expect(
      cameraRefreshNeeded(
        { zoom: 4.2, center: { x: 180, y: 100 } },
        refresh,
        null, // no previous camera event
        0.2,
      ),
    ).toBe(false);
  });

  it("skips when nothing changed", () => {
    expect(
      cameraRefreshNeeded(
        { zoom: 4, center: { x: 100, y: 100 } },
        refresh,
        sameZoomEvent,
        0.2,
      ),
    ).toBe(false);
  });
});

describe("frameCameraInfo", () => {
  // A connection is only drawn when BOTH endpoints are displayed, so
  // navigating to one at high zoom must widen the view to include the other.
  it("zooms out to fit a span wider than the viewport", () => {
    const info = makeCameraInfo(); // 20 wide x 10 tall, zoom 3
    const framed = frameCameraInfo(info, { x: 100, y: 100 }, 40, 10);
    // Needs 2x the width => one zoom level out.
    expect(framed.zoom).toBeCloseTo(2);
    const xs = framed.gcsBounds.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40);
  });

  it("uses whichever axis needs the most room", () => {
    const info = makeCameraInfo(); // 20 x 10
    // Height needs 4x; width needs only 1x.
    const framed = frameCameraInfo(info, { x: 100, y: 100 }, 5, 40);
    expect(framed.zoom).toBeCloseTo(1);
    const ys = framed.gcsBounds.map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40);
  });

  it("never zooms IN when the span already fits", () => {
    const info = makeCameraInfo();
    const framed = frameCameraInfo(info, { x: 150, y: 150 }, 2, 2);
    expect(framed.zoom).toBe(info.zoom);
    expect(framed.center).toEqual({ x: 150, y: 150 });
  });

  it("recenters on the given point while scaling", () => {
    const info = makeCameraInfo();
    const framed = frameCameraInfo(info, { x: 300, y: 400 }, 40, 10);
    expect(framed.center).toEqual({ x: 300, y: 400 });
    const xs = framed.gcsBounds.map((p) => p.x);
    const ys = framed.gcsBounds.map((p) => p.y);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(300);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(400);
  });

  it("preserves rotation rather than rebuilding an axis-aligned box", () => {
    const info = makeCameraInfo();
    expect(frameCameraInfo(info, { x: 100, y: 100 }, 40, 10).rotate).toBe(
      info.rotate,
    );
  });
});
