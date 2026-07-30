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
  showTimelapseMode: true,
  timelapseModeWindow: 10,
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

vi.mock("@/store/timelapse", () => ({
  default: {
    get showMode() {
      return h.showTimelapseMode;
    },
    // The drawn window is +/- this, and goToTrack must compare against the same
    // number the draw path does.
    get modeWindow() {
      return h.timelapseModeWindow;
    },
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
  h.showTimelapseMode = true;
  h.timelapseModeWindow = 10;
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
   * inside the track's range — the whole window is drawn, so the track is
   * already on screen.
   */
  it("leaves Time alone when a member is inside the drawn window", () => {
    h.showTimelapseMode = true;
    h.timelapseModeWindow = 10;
    h.time = 3;
    addAnnotation("a", 0, 0, 1);
    addAnnotation("b", 10, 10, 5);
    goToTrack(["a", "b"]);
    expect(h.setTime).not.toHaveBeenCalled();
  });

  /**
   * ...but the By-track view works with the mode OFF, where only one timepoint
   * is drawn. Leaving Time alone there frames a region containing nothing: with
   * members at T1 and T5 viewed at T3, no member and no link is on screen, so
   * the row expands and the camera moves to empty image. Snap to the nearest
   * member instead.
   */
  it("snaps Time to the nearest member outside timelapse mode", () => {
    h.showTimelapseMode = false;
    h.time = 3;
    addAnnotation("a", 0, 0, 1);
    addAnnotation("b", 10, 10, 5);
    goToTrack(["a", "b"]);
    // T3 is inside [1, 5], so the timelapse rule would not have moved at all.
    expect(h.setTime).toHaveBeenCalledWith(1);

    vi.clearAllMocks();
    h.time = 4; // nearer T5 now
    goToTrack(["a", "b"]);
    expect(h.setTime).toHaveBeenCalledWith(5);
  });

  /**
   * A track can span XY/Z: `Connect selected` chains whatever is selected by
   * ascending time with no slice constraint. Taking XY/Z from one member while
   * deriving the box and the time from ALL of them navigated to one slice and
   * framed another — the nearest time could belong to a member that is not drawn
   * there, so the row expanded onto empty image.
   */
  it("frames only the anchor slice for a cross-slice track", () => {
    h.showTimelapseMode = false;
    h.time = 7;
    // Nearest to T7 is "b" on XY 1 — so XY 1 is the anchor slice.
    addAnnotation("a", 0, 0, 0);
    h.annotations.get("a")!.location.XY = 0;
    addAnnotation("b", 100, 100, 8);
    h.annotations.get("b")!.location.XY = 1;
    addAnnotation("c", 110, 120, 9);
    h.annotations.get("c")!.location.XY = 1;

    goToTrack(["a", "b", "c"]);

    expect(h.setXY).toHaveBeenCalledWith(1);
    const [, center, width, height] = h.frameCameraInfoToExtent.mock
      .calls[0] as any[];
    // Box over b and c only. Including "a" at (0,0) would give a 110x120 box
    // centred at (55, 60) — most of it empty image on a slice a isn't on.
    expect(width).toBe(10);
    expect(height).toBe(20);
    expect(center).toEqual({ x: 105, y: 110 });
    // ...and Time lands on a member of THAT slice.
    expect(h.setTime).toHaveBeenCalledWith(8);
  });

  // Slice isolation applies in timelapse mode too: the mode widens which TIMES
  // are drawn, not which slices. (It cannot change the Time decision — the anchor
  // is the globally nearest member, so it always lies on the anchor slice — but
  // it must not leak the other slice's geometry into the box.)
  it("frames only the anchor slice in timelapse mode as well", () => {
    h.showTimelapseMode = true;
    h.timelapseModeWindow = 10;
    h.time = 0;
    addAnnotation("a", 0, 0, 0);
    h.annotations.get("a")!.location.XY = 0;
    addAnnotation("a2", 20, 30, 1);
    h.annotations.get("a2")!.location.XY = 0;
    addAnnotation("b", 900, 900, 2);
    h.annotations.get("b")!.location.XY = 1;

    goToTrack(["a", "a2", "b"]);

    expect(h.setXY).toHaveBeenCalledWith(0);
    const [, center, width, height] = h.frameCameraInfoToExtent.mock
      .calls[0] as any[];
    expect(width).toBe(20);
    expect(height).toBe(30);
    expect(center).toEqual({ x: 10, y: 15 });
    // Both anchor-slice members are inside the window, so Time stays put.
    expect(h.setTime).not.toHaveBeenCalled();
  });

  /**
   * The sparse-track case. A T1→T100 jump viewed at T50 with the default window
   * of 10 has T50 comfortably inside the track's RANGE, so a range check left
   * Time alone — while the draw path, which filters to
   * `[time - window, time + window]`, kept no member at all. Expanding the row
   * then moved and zoomed the camera onto an empty timelapse view. The check has
   * to use the same window the draw path uses.
   */
  it("snaps Time when every member is outside the drawn window", () => {
    h.showTimelapseMode = true;
    h.timelapseModeWindow = 10;
    h.time = 50;
    addAnnotation("a", 0, 0, 1);
    addAnnotation("b", 10, 10, 100);
    goToTrack(["a", "b"]);
    // Nearest member to T50 is T1 (49 away) vs T100 (50 away).
    expect(h.setTime).toHaveBeenCalledWith(1);
  });

  // ...and a window wide enough to reach a member must NOT move Time.
  it("leaves Time alone when a wide window reaches a member", () => {
    h.showTimelapseMode = true;
    h.timelapseModeWindow = 60;
    h.time = 50;
    addAnnotation("a", 0, 0, 1);
    addAnnotation("b", 10, 10, 100);
    goToTrack(["a", "b"]);
    expect(h.setTime).not.toHaveBeenCalled();
  });

  it("does not move Time outside the mode when already on a member", () => {
    h.showTimelapseMode = false;
    h.time = 5;
    addAnnotation("a", 0, 0, 1);
    addAnnotation("b", 10, 10, 5);
    goToTrack(["a", "b"]);
    expect(h.setTime).not.toHaveBeenCalled();
  });

  // ...but a track entirely off-window renders as nothing, so the click would
  // look broken. Clamp to the nearest end — the smallest move that fixes it.
  // Outside the window is where the snap happens, and the nearest member is the
  // nearest end of the range. Note the second half: at T0 with a window of 10
  // BOTH members are inside [-10, 10], so they are drawn and Time must NOT move
  // — the previous range-based rule moved it to T1 for nothing.
  it("snaps Time to the nearest end when the window reaches no member", () => {
    h.showTimelapseMode = true;
    h.timelapseModeWindow = 10;
    h.time = 40;
    addAnnotation("a", 0, 0, 1);
    addAnnotation("b", 10, 10, 5);
    goToTrack(["a", "b"]);
    expect(h.setTime).toHaveBeenCalledWith(5);

    vi.clearAllMocks();
    h.time = 0;
    goToTrack(["a", "b"]);
    expect(h.setTime).not.toHaveBeenCalled();
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
