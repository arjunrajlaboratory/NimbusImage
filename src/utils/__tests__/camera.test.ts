import { describe, it, expect } from "vitest";
import { recenterCameraInfo } from "@/utils/camera";
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
