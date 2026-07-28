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
  frameCameraInfoToExtent: vi.fn(() => ({ extentFramed: true })),
  recenterCameraInfo: vi.fn(() => ({ recentered: true })),
  annotations: new Map<string, IAnnotation>(),
  cameraInfo: { center: { x: 0, y: 0 }, zoom: 3, rotate: 0, gcsBounds: [] },
  time: 0,
  zoomRange: { min: 0, max: 12 } as { min: number; max: number } | undefined,
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
    get time() {
      return h.time;
    },
    // goToTrack clamps the requested zoom to what the live map can show.
    get maps() {
      return [{ map: { zoomRange: () => h.zoomRange } }];
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
  frameCameraInfoToExtent: h.frameCameraInfoToExtent,
  recenterCameraInfo: h.recenterCameraInfo,
}));

// The real centroid helper: averages the coordinates.
vi.mock("@/utils/annotation", () => ({
  simpleCentroid: (coords: { x: number; y: number }[]) => ({
    x: coords.reduce((s, c) => s + c.x, 0) / coords.length,
    y: coords.reduce((s, c) => s + c.y, 0) / coords.length,
  }),
}));

import { goToConnection, goToTrack } from "@/utils/annotationNavigation";

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
  h.time = 0;
  h.zoomRange = { min: 0, max: 12 };
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

describe("goToTrack", () => {
  it("centres on the members' bounding box and passes its extent", () => {
    addAnnotation("a", 10, 20, 0);
    addAnnotation("b", 50, 20, 1);
    addAnnotation("c", 30, 60, 2);

    goToTrack(["a", "b", "c"]);

    expect(h.frameCameraInfoToExtent).toHaveBeenCalledTimes(1);
    const [, center, width, height, fraction] = h.frameCameraInfoToExtent.mock
      .calls[0] as any[];
    // Bounding box, not the mean of the centroids: with these three points the
    // centroid mean is (30, 33.3) while the box centre is (30, 40).
    expect(center).toEqual({ x: 30, y: 40 });
    expect(width).toBe(40);
    expect(height).toBe(40);
    expect(fraction).toBe(0.2);
    expect(h.setCameraInfo).toHaveBeenCalledWith({ extentFramed: true });
  });

  it("navigates XY/Z to the track, since it is not drawn elsewhere", () => {
    addAnnotation("a", 0, 0, 0);
    goToTrack(["a"]);
    expect(h.setXY).toHaveBeenCalledWith(0);
    expect(h.setZ).toHaveBeenCalledWith(0);
  });

  /**
   * Time is the timelapse window's centre and the user scrubs it deliberately,
   * so framing a track must not move it when the current frame already falls
   * inside the track's range.
   */
  it("leaves Time alone when it is already inside the track's range", () => {
    h.time = 3;
    addAnnotation("a", 0, 0, 1);
    addAnnotation("b", 10, 10, 5);
    goToTrack(["a", "b"]);
    expect(h.setTime).not.toHaveBeenCalled();
  });

  // ...but a track entirely off-window renders as nothing, so the click would
  // look broken. Clamp to the nearest end — the smallest move that fixes it.
  it("clamps Time to the nearest end when it is outside the range", () => {
    h.time = 40;
    addAnnotation("a", 0, 0, 1);
    addAnnotation("b", 10, 10, 5);
    goToTrack(["a", "b"]);
    expect(h.setTime).toHaveBeenCalledWith(5);

    vi.clearAllMocks();
    h.time = 0;
    goToTrack(["a", "b"]);
    expect(h.setTime).toHaveBeenCalledWith(1);
  });

  it("passes the map's zoom range so a tiny track can't demand infinite zoom", () => {
    addAnnotation("a", 10, 10, 0);
    addAnnotation("b", 10, 10, 1); // identical centroids -> degenerate box
    goToTrack(["a", "b"]);
    const [, , width, height, , options] = h.frameCameraInfoToExtent.mock
      .calls[0] as any[];
    expect(width).toBe(0);
    expect(height).toBe(0);
    expect(options).toEqual({ maxZoom: 12, minZoom: 0 });
  });

  it("survives a map with no zoom range", () => {
    h.zoomRange = undefined;
    addAnnotation("a", 0, 0, 0);
    goToTrack(["a"]);
    const [, , , , , options] = h.frameCameraInfoToExtent.mock
      .calls[0] as any[];
    expect(options).toEqual({ maxZoom: undefined, minZoom: undefined });
  });

  it("ignores members that no longer resolve", () => {
    addAnnotation("a", 0, 0, 0);
    goToTrack(["a", "gone"]);
    const [, center] = h.frameCameraInfoToExtent.mock.calls[0] as any[];
    expect(center).toEqual({ x: 0, y: 0 });
  });

  it("does nothing when no member resolves", () => {
    goToTrack(["gone1", "gone2"]);
    expect(h.frameCameraInfoToExtent).not.toHaveBeenCalled();
    expect(h.setCameraInfo).not.toHaveBeenCalled();
    expect(h.setXY).not.toHaveBeenCalled();
  });
});
