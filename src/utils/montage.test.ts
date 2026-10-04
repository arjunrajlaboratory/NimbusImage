import { describe, it, expect, vi } from "vitest";
import {
  annotationImageBounds,
  clipToImage,
  drawMontagePanel,
  montageExportColumns,
  montageGrid,
  montageWindows,
  regionOutputSize,
  IMontagePanelContent,
} from "./montage";
import { AnnotationShape, IAnnotation, IAnnotationStub } from "@/store/model";

function makeAnnotation(
  coordinates: { x: number; y: number }[],
  shape = AnnotationShape.Polygon,
): IAnnotation {
  return {
    id: "a1",
    name: null,
    tags: [],
    shape,
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
    coordinates,
    datasetId: "ds",
    color: null,
  };
}

function makeStub(overrides: Partial<IAnnotationStub> = {}): IAnnotationStub {
  return {
    id: "s1",
    centroid: { x: 100, y: 200 },
    location: { XY: 0, Z: 0, Time: 0 },
    shape: AnnotationShape.Polygon,
    channel: 0,
    tags: [],
    color: null,
    ...overrides,
  };
}

describe("annotationImageBounds", () => {
  it("is the coordinates' bounding box for a full annotation", () => {
    const bounds = annotationImageBounds(
      makeAnnotation([
        { x: 10, y: 50 },
        { x: 30, y: 20 },
        { x: 20, y: 40 },
      ]),
    );
    expect(bounds).toEqual({ left: 10, top: 20, right: 30, bottom: 50 });
  });

  it("is centroid ± estimated radius for an unhydrated stub", () => {
    expect(annotationImageBounds(makeStub({ estimatedRadius: 5 }))).toEqual({
      left: 95,
      top: 195,
      right: 105,
      bottom: 205,
    });
  });

  it("is an empty box at the centroid for a stub without a radius", () => {
    expect(annotationImageBounds(makeStub())).toEqual({
      left: 100,
      top: 200,
      right: 100,
      bottom: 200,
    });
  });
});

describe("montageWindows", () => {
  const small = { left: 0, top: 0, right: 10, bottom: 4 };
  const large = { left: 100, top: 100, right: 140, bottom: 120 };

  it("pads each object's longer side and centers the square on it", () => {
    const [window] = montageWindows([small], 5, "fit");
    expect(window).toEqual({ left: -5, top: -8, right: 15, bottom: 12 });
  });

  it("gives every panel the largest window in uniform mode", () => {
    const windows = montageWindows([small, large], 5, "uniform");
    for (const window of windows) {
      expect(window.right - window.left).toBe(50);
      expect(window.bottom - window.top).toBe(50);
    }
    // Still centered on each object.
    expect((windows[0].left + windows[0].right) / 2).toBe(5);
    expect((windows[1].left + windows[1].right) / 2).toBe(120);
  });

  it("keeps each object's own size in fit mode", () => {
    const [a, b] = montageWindows([small, large], 5, "fit");
    expect(a.right - a.left).toBe(20);
    expect(b.right - b.left).toBe(50);
  });

  it("sizes a point object's window by the padding alone", () => {
    const point = { left: 7, top: 7, right: 7, bottom: 7 };
    const [window] = montageWindows([point], 32, "fit");
    expect(window).toEqual({ left: -25, top: -25, right: 39, bottom: 39 });
  });

  it("never produces an empty window", () => {
    const point = { left: 7, top: 7, right: 7, bottom: 7 };
    const [window] = montageWindows([point], 0, "fit");
    expect(window.right - window.left).toBe(1);
  });
});

describe("clipToImage", () => {
  it("clips to the image and snaps outward to whole pixels", () => {
    expect(
      clipToImage({ left: -5.5, top: 2.2, right: 20.1, bottom: 30 }, 16, 100),
    ).toEqual({ left: 0, top: 2, right: 16, bottom: 30 });
  });

  it("is null when the window misses the image", () => {
    expect(
      clipToImage({ left: 200, top: 0, right: 220, bottom: 20 }, 100, 100),
    ).toBeNull();
  });
});

describe("regionOutputSize", () => {
  const rect = { left: 0, top: 0, right: 400, bottom: 200 };

  it("downsamples to the drawn scale", () => {
    expect(regionOutputSize(rect, 0.5)).toEqual({ width: 200, height: 100 });
  });

  it("never asks for more than the native resolution", () => {
    expect(regionOutputSize(rect, 3)).toEqual({ width: 400, height: 200 });
  });
});

describe("montageGrid", () => {
  it("lays panels out row-major with gaps", () => {
    expect(montageGrid(5, 2, 100, 10)).toEqual({
      columns: 2,
      rows: 3,
      width: 210,
      height: 320,
    });
  });

  it("does not leave empty columns when there are fewer panels", () => {
    expect(montageGrid(2, 6, 100, 10).columns).toBe(2);
  });
});

describe("montageExportColumns", () => {
  it("keeps the on-screen column count when it is wide enough", () => {
    // 8 columns of 160 with 6px gaps need 1322 px; 8 ≥ √20.
    expect(montageExportColumns(1322, 160, 6, 20)).toBe(8);
  });

  it("uses at least √n columns so a long page stays within canvas limits", () => {
    // One column on screen, 200 panels → 15 columns, 14 rows.
    expect(montageExportColumns(300, 320, 6, 200)).toBe(15);
  });
});

describe("drawMontagePanel", () => {
  function mockContext() {
    return {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn(() => ({ width: 10 })),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      lineJoin: "",
      font: "",
      textBaseline: "",
      imageSmoothingEnabled: true,
    };
  }

  const baseContent: IMontagePanelContent = {
    image: null,
    // 100 image px drawn into a 200 px panel → scale 2.
    window: { left: -20, top: 0, right: 80, bottom: 100 },
    imageRect: { left: 0, top: 0, right: 80, bottom: 100 },
    outline: null,
    color: "#ff0000",
    indexLabel: null,
    textLines: [],
  };

  it("draws a clipped crop offset by the part of the window off-image", () => {
    const ctx = mockContext();
    const image = { width: 80, height: 100 } as unknown as ImageBitmap;
    drawMontagePanel(ctx as any, 10, 20, 200, { ...baseContent, image }, 1);
    expect(ctx.drawImage).toHaveBeenCalledWith(image, 50, 20, 160, 200);
    // Upsampled ×2: show pixels, don't blur.
    expect(ctx.imageSmoothingEnabled).toBe(false);
  });

  it("maps outline coordinates into panel space and closes polygons", () => {
    const ctx = mockContext();
    drawMontagePanel(
      ctx as any,
      0,
      0,
      200,
      {
        ...baseContent,
        outline: {
          shape: AnnotationShape.Polygon,
          coordinates: [
            { x: 0, y: 0 },
            { x: 10, y: 5 },
            { x: 0, y: 10 },
          ],
        },
      },
      1,
    );
    expect(ctx.moveTo).toHaveBeenCalledWith(40, 0);
    expect(ctx.lineTo).toHaveBeenCalledWith(60, 10);
    expect(ctx.closePath).toHaveBeenCalled();
    expect(ctx.strokeStyle).toBe("#ff0000");
  });

  it("leaves lines open", () => {
    const ctx = mockContext();
    drawMontagePanel(
      ctx as any,
      0,
      0,
      200,
      {
        ...baseContent,
        outline: {
          shape: AnnotationShape.Line,
          coordinates: [
            { x: 0, y: 0 },
            { x: 10, y: 5 },
          ],
        },
      },
      1,
    );
    expect(ctx.closePath).not.toHaveBeenCalled();
  });

  it("draws a point as a ring at its position", () => {
    const ctx = mockContext();
    drawMontagePanel(
      ctx as any,
      0,
      0,
      200,
      {
        ...baseContent,
        outline: {
          shape: AnnotationShape.Point,
          coordinates: [{ x: 30, y: 50 }],
        },
      },
      2,
    );
    expect(ctx.arc).toHaveBeenCalledWith(100, 100, 12, 0, 2 * Math.PI);
  });

  it("prints the index at the top and property lines at the bottom", () => {
    const ctx = mockContext();
    drawMontagePanel(
      ctx as any,
      0,
      0,
      200,
      { ...baseContent, indexLabel: "#7", textLines: ["a: 1", "b: 2"] },
      1,
    );
    const texts = ctx.fillText.mock.calls.map(([text]) => text);
    expect(texts).toEqual(["#7", "a: 1", "b: 2"]);
    const [, , indexY] = ctx.fillText.mock.calls[0];
    const [, , lastY] = ctx.fillText.mock.calls[2];
    expect(indexY).toBeLessThan(20);
    expect(lastY).toBeGreaterThan(180);
  });
});
