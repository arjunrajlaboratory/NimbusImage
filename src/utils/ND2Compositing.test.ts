import { describe, it, expect } from "vitest";
import {
  canCompositeByStagePosition,
  compositeTranscodeDefault,
  compositingCheck,
  compositingCoordinates,
  compositingFrameMetadataIndex,
  COMPOSITE_TRANSCODE_TILE_THRESHOLD,
  ICompositingTileMeta,
} from "./ND2Compositing";

// 1000 px tiles at 1 µm/px, so stage µm equal mosaic pixels.
function tile(frames: number, channels = 2): ICompositingTileMeta {
  return {
    sizeX: 1000,
    sizeY: 1000,
    mm_x: 0.001,
    mm_y: 0.001,
    frames: Array.from({ length: frames }, () => ({})),
    IndexRange: channels > 1 ? { IndexC: channels } : null,
  };
}

function stages(points: [number, number][], matrix?: number[]) {
  return {
    nd2_frame_metadata: points.map(([x, y]) => ({
      position: { stagePositionUm: [x, y, 0] },
    })),
    ...(matrix
      ? {
          nd2: {
            channels: [{ volume: { cameraTransformationMatrix: matrix } }],
          },
        }
      : {}),
  };
}

// One single-position, 2-channel file per stage position; XY = file index.
function check(points: [number, number][]) {
  const tiles = points.map(() => tile(2));
  const internal = points.map((p) => stages([p]));
  return compositingCheck(
    points.map((_, i) => `tile_${i}.nd2`),
    tiles,
    compositingCoordinates(tiles, internal),
    (itemIdx) => itemIdx,
  );
}

describe("compositingFrameMetadataIndex", () => {
  it("uses the one entry of a single-position file for all channels", () => {
    expect(compositingFrameMetadataIndex(tile(2), 1)).toBe(0);
  });

  it("maps camera frames of a multi-position file (C fastest)", () => {
    // 3 positions x 2 Z = 6 entries, 5 channels -> 30 frames.
    const multi = tile(30, 5);
    expect(compositingFrameMetadataIndex(multi, 4)).toBe(0);
    expect(compositingFrameMetadataIndex(multi, 5)).toBe(1);
    expect(compositingFrameMetadataIndex(multi, 29)).toBe(5);
  });

  it("uses the file's own channel count, not the dataset's", () => {
    // Channels split across files: each file has one channel per entry.
    expect(compositingFrameMetadataIndex(tile(4, 1), 3)).toBe(3);
  });

  it("keeps channel pairs together in a truncated file", () => {
    // 12 entries but large_image truncated the frames to 12 (6 per channel).
    expect(compositingFrameMetadataIndex(tile(12, 2), 11)).toBe(5);
  });
});

describe("canCompositeByStagePosition", () => {
  it("accepts a multi-position file with an entry per camera frame", () => {
    expect(
      canCompositeByStagePosition(
        [tile(4, 2)],
        [
          stages([
            [0, 0],
            [1000, 0],
          ]),
        ],
        0,
      ),
    ).toBe(true);
  });

  it("refuses frames past the file's stage entries", () => {
    expect(
      canCompositeByStagePosition([tile(6, 2)], [stages([[0, 0]])], 0),
    ).toBe(false);
  });

  it("refuses files without a usable pixel size", () => {
    expect(
      canCompositeByStagePosition(
        [{ ...tile(2), mm_x: null as any }],
        [stages([[0, 0]])],
        0,
      ),
    ).toBe(false);
  });

  it("refuses files whose camera orientations differ", () => {
    expect(
      canCompositeByStagePosition(
        [tile(2), tile(2)],
        [stages([[0, 0]], [-1, 0, 0, -1]), stages([[1000, 0]], [1, 0, 0, 1])],
        2,
      ),
    ).toBe(false);
  });

  it("refuses a camera matrix that collapses the tile", () => {
    expect(
      canCompositeByStagePosition(
        [tile(2)],
        [stages([[0, 0]], [0, 0, 0, 0])],
        0,
      ),
    ).toBe(false);
  });

  it("keeps a shear whose diagonal is the identity", () => {
    const { coordinates } = compositingCoordinates(
      [tile(2)],
      [stages([[0, 0]], [1, 0.5, 0, 1])],
    );
    expect(coordinates[0]).toMatchObject({ s11: 1, s12: 0.5, s21: 0, s22: 1 });
  });

  it("still snaps a nearly -I Nikon matrix to -I", () => {
    const { coordinates } = compositingCoordinates(
      [tile(2)],
      [
        stages(
          [[0, 0]],
          [-0.9999992536874144, 0.0012217301724580128, -0.0012, -0.99999925],
        ),
      ],
    );
    expect(coordinates[0]).toMatchObject({ s11: -1, s12: 0, s21: 0, s22: -1 });
  });

  it("refuses a singular camera matrix", () => {
    expect(
      canCompositeByStagePosition(
        [tile(2)],
        [stages([[0, 0]], [2, 2, 1, 1])],
        0,
      ),
    ).toBe(false);
  });

  it("treats a malformed camera matrix as the identity", () => {
    const internal = [stages([[0, 0]], [null as any, 0, 0, "x" as any])];
    expect(compositingCoordinates([tile(2)], internal).coordinates[0].s11).toBe(
      1,
    );
  });

  it("treats a channel without a volume as the identity", () => {
    const internal = [{ ...stages([[0, 0]]), nd2: { channels: [{}] } }];
    expect(canCompositeByStagePosition([tile(2)], internal, 0)).toBe(true);
    expect(compositingCoordinates([tile(2)], internal).coordinates[0].s11).toBe(
      1,
    );
  });
});

describe("compositingCoordinates", () => {
  it("handles more frames than Math.min can take as arguments", () => {
    const points: [number, number][] = Array.from(
      { length: 200_000 },
      (_, i) => [i, 0],
    );
    const { coordinates } = compositingCoordinates(
      [tile(400_000, 2)],
      [stages(points)],
    );
    expect(coordinates).toHaveLength(200_000);
    expect(coordinates[0].x).toBe(0);
  });
});

describe("compositingCheck", () => {
  it("accepts a regular grid of adjacent tiles", () => {
    expect(
      check([
        [0, 0],
        [1000, 0],
        [0, 1000],
        [1000, 1000],
      ]),
    ).toEqual({ error: null, warning: null, tileCount: 4 });
  });

  it("counts a multi-position file's positions as tiles", () => {
    // One file: 20 positions x 3 Z, 2 channels; Z entries share a tile.
    const points: [number, number][] = Array.from({ length: 60 }, (_, i) => [
      1000 * Math.floor(i / 3),
      0,
    ]);
    const tiles = [tile(120, 2)];
    expect(
      compositingCheck(
        ["multi.nd2"],
        tiles,
        compositingCoordinates(tiles, [stages(points)]),
        (_itemIdx, frameIdx) => Math.floor(frameIdx / 6),
      ).tileCount,
    ).toBe(20);
  });

  it("refuses two files within a tenth of a tile of each other", () => {
    const result = check([
      [0, 0],
      [1000, 0],
      [60, -40],
    ]);
    expect(result.error).toContain('"tile_0.nd2" (XY 1)');
    expect(result.error).toContain('"tile_2.nd2" (XY 3)');
  });

  it("does not call heavily overlapping neighbours duplicates", () => {
    expect(
      check([
        [0, 0],
        [150, 0],
      ]).error,
    ).toBeNull();
  });

  it("treats stage entries sharing an XY value as one tile", () => {
    // Channels split across files: two files at each position, same XY.
    const tiles = [tile(1, 1), tile(1, 1), tile(1, 1), tile(1, 1)];
    const internal = [
      stages([[0, 0]]),
      stages([[0, 0]]),
      stages([[1000, 0]]),
      stages([[1000, 0]]),
    ];
    expect(
      compositingCheck(
        ["a_c0", "a_c1", "b_c0", "b_c1"],
        tiles,
        compositingCoordinates(tiles, internal),
        (itemIdx) => Math.floor(itemIdx / 2),
      ),
    ).toMatchObject({ error: null, warning: null });
  });

  it("catches a duplicate next to any merged point, not just the first", () => {
    // Same-XY points at x=0 and x=99 merge into one tile; a different-XY
    // point at x=198 is 99 px (< 100 px tolerance) from the merged one.
    const tiles = [tile(1, 1), tile(1, 1), tile(1, 1)];
    const internal = [stages([[0, 0]]), stages([[99, 0]]), stages([[198, 0]])];
    const result = compositingCheck(
      ["a.nd2", "b.nd2", "c.nd2"],
      tiles,
      compositingCoordinates(tiles, internal),
      (itemIdx) => (itemIdx < 2 ? 0 : 1),
    );
    expect(result.error).toContain('"b.nd2" (XY 1) and "c.nd2" (XY 2)');
  });

  it("measures tolerances on the rotated tile, not the raw size", () => {
    // 2000 x 500 tiles rotated 90 degrees: 500 wide, 2000 tall on screen.
    // 100 px apart in x is not within a tenth of the 500 px rotated width
    // (but would be within a tenth of the raw 2000 px sizeX).
    const rotated = { ...tile(1, 1), sizeX: 2000, sizeY: 500 };
    const tiles = [rotated, rotated];
    const internal = [
      stages([[0, 0]], [0, -1, 1, 0]),
      stages([[100, 0]], [0, -1, 1, 0]),
    ];
    const layout = compositingCoordinates(tiles, internal);
    expect([layout.tileWidth, layout.tileHeight]).toEqual([500, 2000]);
    expect(
      compositingCheck(["a.nd2", "b.nd2"], tiles, layout, (i) => i).error,
    ).toBeNull();
  });

  it("does not flag a point near a merged box but far from its points", () => {
    // Same-XY points at (0,99) and (99,0); a different-XY point at
    // (149,149) is more than 100 px from each in one axis.
    const tiles = [tile(1, 1), tile(1, 1), tile(1, 1)];
    const internal = [
      stages([[0, -99]]),
      stages([[99, 0]]),
      stages([[149, -149]]),
    ];
    const result = compositingCheck(
      ["a.nd2", "b.nd2", "c.nd2"],
      tiles,
      compositingCoordinates(tiles, internal),
      (itemIdx) => (itemIdx < 2 ? 0 : 1),
    );
    expect(result.error).toBeNull();
  });

  it("checks every file when XY repeats across files", () => {
    // XY from frame order: both files hold XY 0 and 1, at the same stages,
    // so file 2's positions would be skipped if keyed by XY value alone.
    const tiles = [tile(4, 2), tile(4, 2)];
    const internal = [
      stages([
        [0, 0],
        [1000, 0],
      ]),
      stages([
        [1000, 0],
        [0, 0],
      ]),
    ];
    const result = compositingCheck(
      ["a.nd2", "b.nd2"],
      tiles,
      compositingCoordinates(tiles, internal),
      (_itemIdx, frameIdx) => Math.floor(frameIdx / 2),
    );
    expect(result.error).toContain('"a.nd2" (XY 2) and "b.nd2" (XY 1)');
  });

  it("reports no coverage warning alongside a duplicate", () => {
    const points: [number, number][] = [
      [0, 0],
      [1000, 0],
      [3, 0],
      ...Array.from({ length: 58 }, (_, i): [number, number] => [
        1000 * (i + 2),
        0,
      ]),
    ];
    const result = check(points);
    expect(result.error).toContain("same stage position");
    expect(result.warning).toBeNull();
  });

  it("checks long stacks at one position in linear time", () => {
    // 10 positions x 3000 Z/T entries, 2 channels, one XY value each.
    const points: [number, number][] = Array.from(
      { length: 30_000 },
      (_, i) => [1000 * Math.floor(i / 3000), 0],
    );
    const tiles = [tile(60_000, 2)];
    const started = performance.now();
    const result = compositingCheck(
      ["stack.nd2"],
      tiles,
      compositingCoordinates(tiles, [stages(points)]),
      (_itemIdx, frameIdx) => Math.floor(frameIdx / 6000),
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ error: null, warning: null });
  });

  it("warns, without refusing, when the tiles are far apart", () => {
    const result = check([
      [0, 0],
      [1000, 0],
      [20000, 0],
      [21000, 0],
    ]);
    expect(result.error).toBeNull();
    expect(result.warning).toContain("cover only 18%");
  });
});

describe("compositeTranscodeDefault", () => {
  it("keeps the file-type default when not compositing", () => {
    expect(compositeTranscodeDefault(false, false, 1000)).toBe(false);
    expect(compositeTranscodeDefault(true, false, 2)).toBe(true);
  });

  it("turns transcode on when compositing many tiles", () => {
    const n = COMPOSITE_TRANSCODE_TILE_THRESHOLD;
    expect(compositeTranscodeDefault(false, true, n)).toBe(false);
    expect(compositeTranscodeDefault(false, true, n + 1)).toBe(true);
    // No tile count (a refused composite) is not "many".
    expect(compositeTranscodeDefault(false, true, null)).toBe(false);
  });
});
