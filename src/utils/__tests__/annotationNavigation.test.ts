import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnnotationShape, IAnnotation, IImage } from "@/store/model";

/** One tile of the unroll fixture below. Square, to keep the grid predictable. */
const TILE = 1024;

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
  unrollXY: false,
  unrollZ: false,
  unrollT: false,
  unrollW: 1,
  /** Every frame of the dataset, in grid-cell order. Empty = no unrolling set up. */
  frames: [] as any[],
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
    get unrollXY() {
      return h.unrollXY;
    },
    get unrollZ() {
      return h.unrollZ;
    },
    get unrollT() {
      return h.unrollT;
    },
    get unroll() {
      return h.unrollXY || h.unrollZ || h.unrollT;
    },
    get unrollGrid() {
      return { unrollW: h.unrollW, unrollH: 1 };
    },
    get dataset() {
      if (h.frames.length === 0) {
        return null;
      }
      return {
        // The collapsed lookup `parseTiles` builds: an unrolled axis is asked
        // for as -1 and every frame along it comes back in one list.
        images: () => h.frames,
        anyImage: () => ({ sizeX: 1024, sizeY: 1024 }) as IImage,
      };
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

// Only `simpleCentroid` is stubbed, and with its real behavior (the average).
// `unrollIndexFromImages` is deliberately left REAL: `@/utils/unroll` calls it to
// resolve a location to its grid cell, and a fixed-value stub there would make
// every unroll assertion below pass for the wrong reason.
vi.mock("@/utils/annotation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/annotation")>()),
  simpleCentroid: (coords: { x: number; y: number }[]) => ({
    x: coords.reduce((s, c) => s + c.x, 0) / coords.length,
    y: coords.reduce((s, c) => s + c.y, 0) / coords.length,
  }),
}));

import {
  goToAnnotationLocation,
  goToConnection,
} from "@/utils/annotationNavigation";

/**
 * Unroll `frameCount` timepoints into a `width`-column grid.
 *
 * Frames are given `keyOffset`s in cell order, which is what `parseTiles` does
 * and what the grid layout is indexed by.
 */
function unrollTime(frameCount: number, width: number) {
  h.unrollT = true;
  h.unrollW = width;
  h.frames = Array.from({ length: frameCount }, (_, i) => ({
    keyOffset: i,
    frame: { IndexXY: 0, IndexZ: 0, IndexT: i },
  }));
}

function addAnnotation(
  id: string,
  x: number,
  y: number,
  time = 0,
  { XY = 0, Z = 0 }: { XY?: number; Z?: number } = {},
) {
  h.annotations.set(id, {
    id,
    name: null,
    tags: [],
    shape: AnnotationShape.Point,
    channel: 0,
    location: { XY, Z, Time: time },
    coordinates: [{ x, y }],
    datasetId: "ds",
    color: null,
  } as IAnnotation);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.annotations.clear();
  h.unrollXY = false;
  h.unrollZ = false;
  h.unrollT = false;
  h.unrollW = 1;
  h.frames = [];
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

// Issue #1280. With an axis unrolled, every frame along it is drawn side by side
// and the viewer offsets each annotation by its frame's cell — so the camera has
// to be aimed at the offset position, not the raw centroid. Measured on
// normmedia_8well_col2_livecellgfp before the fix: an object whose centroid was
// x = 260 rendered at x = 1284 (tile 1 of a 1024-wide grid) and the camera went
// to x = 260 — a full tile away, onto the equivalent spot of tile 0.
describe("navigation on the unrolled grid", () => {
  it("centres on the tile-offset centroid, not the raw one", () => {
    unrollTime(4, 4);
    addAnnotation("obj", 260, 100, 1); // Time 1 => cell 1 => +1024 in x

    goToAnnotationLocation("obj");

    expect(h.recenterCameraInfo).toHaveBeenCalledTimes(1);
    const [, center] = h.recenterCameraInfo.mock.calls[0] as any[];
    expect(center).toEqual({ x: 260 + TILE, y: 100, z: undefined });
  });

  it("wraps onto the next grid row past the last column", () => {
    unrollTime(4, 2); // 2x2 grid
    addAnnotation("obj", 10, 20, 3); // cell 3 => column 1, row 1

    goToAnnotationLocation("obj");

    const [, center] = h.recenterCameraInfo.mock.calls[0] as any[];
    expect(center).toEqual({ x: 10 + TILE, y: 20 + TILE, z: undefined });
  });

  it("leaves the centroid alone for a frame on the first cell", () => {
    unrollTime(4, 4);
    addAnnotation("obj", 260, 100, 0);

    goToAnnotationLocation("obj");

    const [, center] = h.recenterCameraInfo.mock.calls[0] as any[];
    expect(center).toEqual({ x: 260, y: 100, z: undefined });
  });

  // The pre-existing behavior must not change when nothing is unrolled: the raw
  // centroid IS the drawn position there.
  it("does not offset when unrolling is off", () => {
    addAnnotation("obj", 260, 100, 1);

    goToAnnotationLocation("obj");

    const [, center] = h.recenterCameraInfo.mock.calls[0] as any[];
    expect(center).toEqual({ x: 260, y: 100 });
  });

  // The same-frame gate was too strict while unrolling: both endpoints ARE on
  // screen, and the connection is genuinely drawn as a line between two cells.
  it("frames cross-time endpoints while time is unrolled", () => {
    unrollTime(4, 4);
    addAnnotation("parent", 100, 50, 0);
    addAnnotation("child", 200, 50, 2); // cell 2 => +2048 in x

    goToConnection("parent", "child");

    expect(h.frameCameraInfo).toHaveBeenCalledTimes(1);
    const [, center, spanX, spanY] = h.frameCameraInfo.mock.calls[0] as any[];
    // Drawn at x = 100 and x = 200 + 2048 = 2248.
    expect(center).toEqual({ x: (100 + 2248) / 2, y: 50 });
    expect(spanX).toBeCloseTo((2248 - 100) * 1.6);
    expect(spanY).toBeCloseTo(0);
  });

  // Unrolling T does not put two Z slices on screen, so a Z-crossing connection
  // still can't be framed.
  it("still declines to frame when the endpoints differ on a rolled axis", () => {
    unrollTime(4, 4);
    addAnnotation("parent", 0, 0, 0, { Z: 0 });
    addAnnotation("child", 80, 0, 0, { Z: 1 });

    goToConnection("parent", "child");

    expect(h.frameCameraInfo).not.toHaveBeenCalled();
    expect(h.recenterCameraInfo).toHaveBeenCalled();
  });
});
