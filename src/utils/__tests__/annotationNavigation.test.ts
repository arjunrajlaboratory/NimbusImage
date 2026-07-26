import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnnotationShape, IAnnotation } from "@/store/model";

const h = vi.hoisted(() => ({
  setXY: vi.fn(),
  setZ: vi.fn(),
  setTime: vi.fn(),
  setCameraInfo: vi.fn(),
  setHoveredAnnotationId: vi.fn(),
  ensureHydrated: vi.fn(),
  frameCameraInfo: vi.fn(() => ({ framed: true })),
  recenterCameraInfo: vi.fn(() => ({ recentered: true })),
  annotations: new Map<string, IAnnotation>(),
  cameraInfo: { center: { x: 0, y: 0 }, zoom: 3, rotate: 0, gcsBounds: [] },
}));

vi.mock("@/store", () => ({
  default: {
    setXY: h.setXY,
    setZ: h.setZ,
    setTime: h.setTime,
    setCameraInfo: h.setCameraInfo,
    get cameraInfo() {
      return h.cameraInfo;
    },
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    getAnnotationFromId: (id: string) => h.annotations.get(id),
    getStub: () => undefined,
    annotationCentroids: {},
    setHoveredAnnotationId: h.setHoveredAnnotationId,
    ensureHydrated: h.ensureHydrated,
  },
}));

vi.mock("@/utils/camera", () => ({
  frameCameraInfo: h.frameCameraInfo,
  recenterCameraInfo: h.recenterCameraInfo,
}));

// The real centroid helper: averages the coordinates.
vi.mock("@/utils/annotation", () => ({
  simpleCentroid: (coords: { x: number; y: number }[]) => ({
    x: coords.reduce((s, c) => s + c.x, 0) / coords.length,
    y: coords.reduce((s, c) => s + c.y, 0) / coords.length,
  }),
}));

import { goToConnection } from "@/utils/annotationNavigation";

function addAnnotation(id: string, x: number, y: number, time = 0) {
  h.annotations.set(id, {
    id,
    name: null,
    tags: [],
    shape: AnnotationShape.Point,
    channel: 0,
    location: { XY: 0, Z: 0, Time: time },
    coordinates: [{ x, y }],
    datasetId: "ds",
    color: null,
  } as IAnnotation);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.annotations.clear();
});

describe("goToConnection", () => {
  // Regression: the caller used to pass Math.abs of each delta. frameCameraInfo
  // projects the vector onto the camera axes, and under rotation the sign
  // changes the required scale substantially — |dx|,|dy| under-scales and
  // leaves an endpoint off screen.
  it("passes the SIGNED endpoint delta to frameCameraInfo", () => {
    addAnnotation("parent", 100, 100);
    addAnnotation("child", 40, 130); // dx = -60, dy = +30

    goToConnection("parent", "child");

    expect(h.frameCameraInfo).toHaveBeenCalledTimes(1);
    const [, center, spanX, spanY] = h.frameCameraInfo.mock.calls[0] as any[];
    expect(center).toEqual({ x: 70, y: 115 }); // midpoint
    expect(spanX).toBeLessThan(0); // sign retained, not |dx|
    expect(spanX).toBeCloseTo(-60 * 1.6);
    expect(spanY).toBeCloseTo(30 * 1.6);
  });

  it("frames both endpoints when they share a frame", () => {
    addAnnotation("parent", 0, 0, 2);
    addAnnotation("child", 80, 0, 2);

    goToConnection("parent", "child");

    expect(h.frameCameraInfo).toHaveBeenCalled();
    expect(h.setTime).toHaveBeenCalledWith(2);
    expect(h.ensureHydrated).toHaveBeenCalledWith(["parent", "child"]);
  });

  // Endpoints on different frames can never both be displayed in normal mode,
  // so there is nothing to frame — fall back to a plain navigate.
  it("does not frame when the endpoints are on different frames", () => {
    addAnnotation("parent", 0, 0, 0);
    addAnnotation("child", 80, 0, 3);

    goToConnection("parent", "child");

    expect(h.frameCameraInfo).not.toHaveBeenCalled();
    expect(h.recenterCameraInfo).toHaveBeenCalled();
  });

  it("degrades to a plain navigate when one endpoint is missing", () => {
    addAnnotation("parent", 10, 10);

    goToConnection("parent", "gone");

    expect(h.frameCameraInfo).not.toHaveBeenCalled();
    expect(h.recenterCameraInfo).toHaveBeenCalled();
  });

  it("does nothing when both endpoints are missing", () => {
    goToConnection("gone1", "gone2");

    expect(h.frameCameraInfo).not.toHaveBeenCalled();
    expect(h.recenterCameraInfo).not.toHaveBeenCalled();
    expect(h.setCameraInfo).not.toHaveBeenCalled();
  });
});
