import { describe, expect, it } from "vitest";
import {
  AUTO_DENSITY_LEVEL,
  MAX_TRANSCRIPT_TILES_PER_REQUEST,
  estimatePoints,
  invertAffine3,
  planTranscriptLevel,
  tilesInView,
  viewToTranscriptMicrons,
} from "./transcriptTiles";

// A 4-level pyramid over a 2 mm x 1 mm section; every level-0 tile holds
// 1000 molecules and, as clustering merges them, each coarser level holds
// half the previous total.
function schema(levels = 4) {
  const tiles = [];
  for (let level = 0; level < levels; level++) {
    const size = 250 * Math.pow(2, level);
    const keys: string[] = [];
    const counts: number[] = [];
    for (let gx = 0; gx < Math.ceil(2000 / size); gx++) {
      for (let gy = 0; gy < Math.ceil(1000 / size); gy++) {
        keys.push(`${gx},${gy}`);
        counts.push(1000 * Math.pow(2, level));
      }
    }
    tiles.push({
      level,
      tileMicrons: size,
      tilePixels: size / 0.5,
      keys,
      counts,
    });
  }
  return {
    gridSizeMicrons: 250,
    tiles,
    genes: 100,
    pixelSize: 0.5,
    transform: null,
  };
}

describe("viewToTranscriptMicrons", () => {
  it("clamps to the image and scales by the pixel size", () => {
    expect(
      viewToTranscriptMicrons(
        { left: -100, top: 50, right: 300, bottom: 5000 },
        schema(),
        4000,
        2000,
      ),
    ).toEqual({ left: 0, top: 25, right: 150, bottom: 1000 });
  });

  it("returns null when the image is off screen", () => {
    expect(
      viewToTranscriptMicrons(
        { left: 5000, top: 0, right: 6000, bottom: 100 },
        schema(),
        4000,
        2000,
      ),
    ).toBeNull();
  });

  it("undoes the registration transform before scaling", () => {
    // H&E pixels = 2 * transcript pixels + (10, 20).
    const transform = [
      [2, 0, 10],
      [0, 2, 20],
      [0, 0, 1],
    ];
    const bounds = viewToTranscriptMicrons(
      { left: 10, top: 20, right: 210, bottom: 120 },
      { pixelSize: 0.5, transform },
      1000,
      1000,
    )!;
    expect(bounds.left).toBeCloseTo(0);
    expect(bounds.top).toBeCloseTo(0);
    expect(bounds.right).toBeCloseTo(50);
    expect(bounds.bottom).toBeCloseTo(25);
    expect(invertAffine3(transform)[0]).toEqual([0.5, -0, -5]);
    expect(() =>
      invertAffine3([
        [1, 2, 0],
        [2, 4, 0],
        [0, 0, 1],
      ]),
    ).toThrow(/invertible/);
  });
});

describe("tilesInView", () => {
  it("lists only tiles the pyramid has", () => {
    const view = { left: 240, top: 0, right: 510, bottom: 10 };
    expect(tilesInView(schema(), 0, view)).toEqual({
      keys: ["0,0", "1,0", "2,0"],
      count: 3000,
    });
    // Beyond the section there are no tiles to ask for.
    expect(
      tilesInView(schema(), 0, { left: 5000, top: 0, right: 6000, bottom: 10 }),
    ).toEqual({ keys: [], count: 0 });
    expect(tilesInView(schema(), 2, view).keys).toEqual(["0,0"]);
  });
});

describe("planTranscriptLevel", () => {
  it("takes the finest level that fits the budget", () => {
    const view = { left: 0, top: 0, right: 2000, bottom: 1000 };
    // 32 level-0 tiles x 1000 = 32000 points x (1 gene x 5 / 100) = 1600.
    expect(planTranscriptLevel(schema(), view, 1, 300_000)).toMatchObject({
      level: 0,
      fits: true,
      estimate: 1600,
    });
    // A tighter budget pushes to the level where the estimate fits:
    // 8 level-1 tiles x 2000 x 0.05 = 800.
    expect(planTranscriptLevel(schema(), view, 1, 1000)).toMatchObject({
      level: 1,
      estimate: 800,
    });
    expect(planTranscriptLevel(schema(), view, 20, 1000)).toMatchObject({
      level: 3,
      fits: false,
    });
  });

  it("respects the tile cap even under budget", () => {
    // 1 mm grid at 250 um tiles across 10 mm: 1600 tiles at level 0.
    const wide = schema();
    wide.tiles[0].keys = [];
    wide.tiles[0].counts = [];
    for (let gx = 0; gx < 40; gx++) {
      for (let gy = 0; gy < 40; gy++) {
        wide.tiles[0].keys.push(`${gx},${gy}`);
        wide.tiles[0].counts.push(1);
      }
    }
    const view = { left: 0, top: 0, right: 10_000, bottom: 10_000 };
    const plan = planTranscriptLevel(wide, view, 1, 1_000_000);
    expect(tilesInView(wide, 0, view).keys.length).toBeGreaterThan(
      MAX_TRANSCRIPT_TILES_PER_REQUEST,
    );
    expect(plan.level).toBeGreaterThan(0);
  });

  it("estimates a gene's share of a tile", () => {
    expect(estimatePoints(1000, 1, 100)).toBe(50);
    expect(estimatePoints(1000, 50, 100)).toBe(1000);
    expect(estimatePoints(1000, 1, 0)).toBe(1000);
    expect(AUTO_DENSITY_LEVEL).toBe(2);
  });
});
