import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
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
  frameCameraInfoToExtent: vi.fn(() => ({ extentFramed: true })),
  recenterCameraInfo: vi.fn(() => ({ recentered: true })),
  recenterCameraInfoAtZoom: vi.fn(() => ({ recenteredAndZoomed: true })),
  annotations: new Map<string, IAnnotation>(),
  cameraInfo: { center: { x: 0, y: 0 }, zoom: 3, rotate: 0, gcsBounds: [] },
  unrollXY: false,
  unrollZ: false,
  unrollT: false,
  unrollW: 1,
  /** Every frame of the dataset, in grid-cell order. Empty = no unrolling set up. */
  frames: [] as any[],
  time: 0,
  zoomRange: { min: 0, max: 12 } as { min: number; max: number } | undefined,
  unitsPerPixel: 1,
  overviewConfig: {
    enabled: false,
    mode: "shapes",
    opacity: 0.6,
    vectorSwitchThreshold: 1,
  },
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
    get time() {
      return h.time;
    },
    // goToTrack clamps the requested zoom to what the live map can show.
    get maps() {
      return [
        {
          map: {
            zoomRange: () => h.zoomRange,
            unitsPerPixel: () => h.unitsPerPixel,
          },
        },
      ];
    },
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    getAnnotationFromId: (id: string) => h.annotations.get(id),
    getStub: () => undefined,
    annotationCentroids: {},
    get overviewConfig() {
      return h.overviewConfig;
    },
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
  recenterCameraInfoAtZoom: h.recenterCameraInfoAtZoom,
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
  goToTrack,
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
  h.time = 0;
  h.zoomRange = { min: 0, max: 12 };
  h.unitsPerPixel = 1;
  h.overviewConfig = {
    enabled: false,
    mode: "shapes",
    opacity: 0.6,
    vectorSwitchThreshold: 1,
  };
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

describe("annotation overview navigation", () => {
  it("zooms a table-row destination into the vector-visible range", async () => {
    h.overviewConfig = {
      ...h.overviewConfig,
      enabled: true,
      vectorSwitchThreshold: 1,
    };
    h.unitsPerPixel = 4;
    addAnnotation("obj", 260, 100);

    goToAnnotationLocation("obj");

    expect(h.recenterCameraInfo).not.toHaveBeenCalled();
    expect(h.recenterCameraInfoAtZoom).toHaveBeenCalledTimes(1);
    const [, center, zoom] = h.recenterCameraInfoAtZoom.mock.calls[0] as any[];
    expect(center).toEqual({ x: 260, y: 100 });
    expect(zoom).toBeGreaterThan(5);
    expect(zoom).toBeLessThan(5.1);
    expect(h.setCameraInfo).toHaveBeenCalledWith({
      recenteredAndZoomed: true,
    });

    // One immediate request plus a retry after raster suppression reacts to
    // the camera transition.
    expect(h.ensureHydrated).toHaveBeenCalledTimes(1);
    await nextTick();
    expect(h.ensureHydrated).toHaveBeenCalledTimes(2);
    expect(h.ensureHydrated).toHaveBeenLastCalledWith(["obj"]);
  });

  it("keeps pure-pan navigation when vectors are already visible", () => {
    h.overviewConfig = { ...h.overviewConfig, enabled: true };
    h.unitsPerPixel = 0.5;
    addAnnotation("obj", 260, 100);

    goToAnnotationLocation("obj");

    expect(h.recenterCameraInfo).toHaveBeenCalledTimes(1);
    expect(h.recenterCameraInfoAtZoom).not.toHaveBeenCalled();
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

  // Issue #1280. All three of goToTrack's "which members are drawn" rules assumed
  // a single frame is on screen. The slice filter and bounding box always relax
  // for an unrolled axis, and the box uses drawn rather than raw coordinates.
  // Time relaxes only for the base layer; the overlay's window stays authoritative.
  describe("on the unrolled grid", () => {
    it("frames the drawn box, spanning cells for a cross-time track", () => {
      unrollTime(4, 4); // one row of 4 cells, tile 1024
      addAnnotation("a", 10, 20, 0); // cell 0 => drawn at (10, 20)
      addAnnotation("b", 50, 20, 2); // cell 2 => drawn at (50 + 2048, 20)

      goToTrack(["a", "b"]);

      const [, center, width, height] = h.frameCameraInfoToExtent.mock
        .calls[0] as any[];
      expect(center).toEqual({ x: (10 + 50 + 2 * TILE) / 2, y: 20 });
      expect(width).toBe(40 + 2 * TILE);
      expect(height).toBe(0);
    });

    // Without the offset the same track frames a 40-unit box on the first tile,
    // which is the pre-fix behaviour.
    it("does not collapse the box to the raw centroids", () => {
      unrollTime(4, 4);
      addAnnotation("a", 10, 20, 0);
      addAnnotation("b", 50, 20, 2);

      goToTrack(["a", "b"]);

      const [, , width] = h.frameCameraInfoToExtent.mock.calls[0] as any[];
      expect(width).not.toBe(40);
    });

    // The time rule depends on WHICH layer draws the track, because only one of
    // the two relaxes time when unrolled. Both directions are pinned below; a rule
    // conditioned on `unrollT` alone gets one of them wrong, and so does a rule
    // that ignores `unrollT` entirely. Both mistakes were made in review.

    // Overlay OFF: the base annotation layer draws every timepoint when unrolled
    // (`allT = store.unrollT || max-merge`), so the whole track is on screen and
    // Time must be left alone.
    it("leaves Time alone when unrolled with the overlay off", () => {
      unrollTime(4, 4);
      h.showTimelapseMode = false;
      h.time = 0;
      addAnnotation("a", 0, 0, 3); // 3 away, and no window without the overlay

      goToTrack(["a"]);

      expect(h.setTime).not.toHaveBeenCalled();
    });

    // Overlay ON: it windows its own segments and dots to `currentTime ±
    // modeWindow` even when every frame is on screen, so leaving Time put would
    // frame a track with no track drawn on it. Regression guard for a review
    // finding: this originally short-circuited on `store.unrollT` regardless of
    // the overlay, and so disagreed with the draw path.
    it("still snaps Time when unrolled, because the overlay still windows", () => {
      unrollTime(4, 4);
      h.showTimelapseMode = true;
      h.timelapseModeWindow = 1;
      h.time = 0;
      addAnnotation("a", 0, 0, 3);

      goToTrack(["a"]);

      expect(h.setTime).toHaveBeenCalledWith(3);
    });

    // ...and it still leaves Time alone when a member IS in the window, so the
    // rule above is "match the overlay", not "always move Time".
    it("leaves Time alone when a member is inside the window, unrolled", () => {
      unrollTime(4, 4);
      h.showTimelapseMode = true;
      h.timelapseModeWindow = 10;
      h.time = 0;
      addAnnotation("a", 0, 0, 3);

      goToTrack(["a"]);

      expect(h.setTime).not.toHaveBeenCalled();
    });

    it("snaps Time the same way when time is NOT unrolled", () => {
      h.showTimelapseMode = true;
      h.timelapseModeWindow = 1;
      h.time = 0;
      addAnnotation("a", 0, 0, 3);

      goToTrack(["a"]);

      expect(h.setTime).toHaveBeenCalledWith(3);
    });

    // A cross-slice track is framed to the anchor's slice only when the other
    // slices genuinely aren't drawn; unrolling Z puts them all on screen.
    it("includes other-Z members when Z is unrolled", () => {
      h.unrollZ = true;
      h.frames = [
        { keyOffset: 0, frame: { IndexXY: 0, IndexZ: 0, IndexT: 0 } },
        { keyOffset: 1, frame: { IndexXY: 0, IndexZ: 1, IndexT: 0 } },
      ];
      h.unrollW = 2;
      addAnnotation("a", 10, 10, 0, { Z: 0 }); // cell 0
      addAnnotation("b", 20, 10, 0, { Z: 1 }); // cell 1 => +1024 in x

      goToTrack(["a", "b"]);

      const [, , width] = h.frameCameraInfoToExtent.mock.calls[0] as any[];
      // Both members counted, and at their drawn positions.
      expect(width).toBe(10 + TILE);
    });

    it("still frames only the anchor slice when Z is NOT unrolled", () => {
      addAnnotation("a", 10, 10, 0, { Z: 0 });
      addAnnotation("b", 20, 10, 0, { Z: 1 });

      goToTrack(["a", "b"]);

      const [, , width] = h.frameCameraInfoToExtent.mock.calls[0] as any[];
      expect(width).toBe(0); // anchor alone
    });
  });

  it("does nothing when no member resolves", () => {
    goToTrack(["gone1", "gone2"]);
    expect(h.frameCameraInfoToExtent).not.toHaveBeenCalled();
    expect(h.setCameraInfo).not.toHaveBeenCalled();
    expect(h.setXY).not.toHaveBeenCalled();
  });
});
