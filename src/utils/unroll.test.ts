import { describe, it, expect, vi } from "vitest";
import { IDataset, IImage } from "@/store/model";
import {
  getUnrollCells,
  IUnrollFlags,
  unrollCellIndex,
  unrollCellOffset,
  unrollGridSize,
  unrollLayoutFor,
  unrolledCoordinates,
} from "./unroll";

// Only `frame` matters to getUnrollCells.
function image(frame: Partial<IImage["frame"]>): IImage {
  return { frame } as IImage;
}

const noUnroll: IUnrollFlags = {
  unrollXY: false,
  unrollZ: false,
  unrollT: false,
};

describe("getUnrollCells", () => {
  it("returns nothing for no images", () => {
    expect(
      getUnrollCells({
        cellImages: [],
        flags: { ...noUnroll, unrollXY: true },
      }),
    ).toEqual([]);
  });

  it("labels and locates unrolled XY frames", () => {
    const cellImages = [0, 1, 2].map((IndexXY) => image({ IndexXY }));
    expect(
      getUnrollCells({ cellImages, flags: { ...noUnroll, unrollXY: true } }),
    ).toEqual([
      { index: 0, label: "XY 1", location: { xy: 0 } },
      { index: 1, label: "XY 2", location: { xy: 1 } },
      { index: 2, label: "XY 3", location: { xy: 2 } },
    ]);
  });

  it("leaves cells unlabelled when nothing is unrolled", () => {
    const cellImages = [0, 1].map((IndexXY) => image({ IndexXY }));
    expect(getUnrollCells({ cellImages, flags: noUnroll })).toEqual([
      { index: 0, label: "", location: {} },
      { index: 1, label: "", location: {} },
    ]);
  });

  it("navigates by rank, not by raw frame value", () => {
    // dataset.xy holds the sorted distinct values, and store.xy indexes into
    // it, so XY 5 is the third XY of this dataset — index 2, not 5.
    const cellImages = [0, 2, 5].map((IndexXY) => image({ IndexXY }));
    expect(
      getUnrollCells({ cellImages, flags: { ...noUnroll, unrollXY: true } }),
    ).toEqual([
      { index: 0, label: "XY 1", location: { xy: 0 } },
      { index: 1, label: "XY 2", location: { xy: 1 } },
      { index: 2, label: "XY 3", location: { xy: 2 } },
    ]);
  });

  it("ranks over the dataset's frames, not just the grid's", () => {
    // A channel imaged only at XY 0 and XY 5, in a dataset whose frames cover
    // XY 0, 2 and 5: rolling up at the second cell has to land on dataset
    // index 2, not on index 1 (which is XY 2, where this channel has no image).
    const cellImages = [0, 5].map((IndexXY) => image({ IndexXY }));
    const axisImages = [0, 2, 5, 0, 2, 5].map((IndexXY) => image({ IndexXY }));
    expect(
      getUnrollCells({
        cellImages,
        axisImages,
        flags: { ...noUnroll, unrollXY: true },
      }),
    ).toEqual([
      { index: 0, label: "XY 1", location: { xy: 0 } },
      { index: 1, label: "XY 3", location: { xy: 2 } },
    ]);
  });

  it("falls back to PositionZ when IndexZ is absent", () => {
    const cellImages = [0, 0.5, 1].map((PositionZ) => image({ PositionZ }));
    expect(
      getUnrollCells({ cellImages, flags: { ...noUnroll, unrollZ: true } }),
    ).toEqual([
      { index: 0, label: "Z 1", location: { z: 0 } },
      { index: 1, label: "Z 2", location: { z: 1 } },
      { index: 2, label: "Z 3", location: { z: 2 } },
    ]);
  });

  it("prefers IndexZ over PositionZ", () => {
    const cellImages = [
      image({ IndexZ: 1, PositionZ: 12.5 }),
      image({ IndexZ: 0, PositionZ: 0.5 }),
    ];
    expect(
      getUnrollCells({ cellImages, flags: { ...noUnroll, unrollZ: true } }),
    ).toEqual([
      { index: 0, label: "Z 2", location: { z: 1 } },
      { index: 1, label: "Z 1", location: { z: 0 } },
    ]);
  });

  it("ranks by value regardless of grid order", () => {
    const cellImages = [2, 0, 1].map((IndexT) => image({ IndexT }));
    expect(
      getUnrollCells({ cellImages, flags: { ...noUnroll, unrollT: true } }),
    ).toEqual([
      { index: 0, label: "Time 3", location: { time: 2 } },
      { index: 1, label: "Time 1", location: { time: 0 } },
      { index: 2, label: "Time 2", location: { time: 1 } },
    ]);
  });

  it("joins every unrolled dimension into one label", () => {
    const cellImages = [
      image({ IndexXY: 0, IndexZ: 0 }),
      image({ IndexXY: 0, IndexZ: 1 }),
      image({ IndexXY: 1, IndexZ: 0 }),
      image({ IndexXY: 1, IndexZ: 1 }),
    ];
    expect(
      getUnrollCells({
        cellImages,
        flags: { ...noUnroll, unrollXY: true, unrollZ: true },
      }),
    ).toEqual([
      { index: 0, label: "XY 1 · Z 1", location: { xy: 0, z: 0 } },
      { index: 1, label: "XY 1 · Z 2", location: { xy: 0, z: 1 } },
      { index: 2, label: "XY 2 · Z 1", location: { xy: 1, z: 0 } },
      { index: 3, label: "XY 2 · Z 2", location: { xy: 1, z: 1 } },
    ]);
  });

  it("keeps single-valued dimensions out of the label but in the location", () => {
    const cellImages = [
      image({ IndexXY: 0, IndexT: 3 }),
      image({ IndexXY: 1, IndexT: 3 }),
    ];
    expect(
      getUnrollCells({
        cellImages,
        flags: { ...noUnroll, unrollXY: true, unrollT: true },
      }),
    ).toEqual([
      { index: 0, label: "XY 1", location: { xy: 0, time: 0 } },
      { index: 1, label: "XY 2", location: { xy: 1, time: 0 } },
    ]);
  });

  it("treats a missing index as 0", () => {
    expect(
      getUnrollCells({
        cellImages: [image({})],
        flags: { ...noUnroll, unrollXY: true },
      }),
    ).toEqual([{ index: 0, label: "", location: { xy: 0 } }]);
  });

  describe("dimension labels", () => {
    const cellImages = [0, 1].map((IndexXY) => image({ IndexXY }));
    const dimensionLabels = { xy: ["19263, -6626", "18743, -8631"] };

    it("appends the dataset's label for the axis", () => {
      expect(
        getUnrollCells({
          cellImages,
          flags: { ...noUnroll, unrollXY: true },
          dimensionLabels,
        }).map((cell) => cell.label),
      ).toEqual(["XY 1 (19263, -6626)", "XY 2 (18743, -8631)"]);
    });

    it("omits the label when the axis is switched off", () => {
      expect(
        getUnrollCells({
          cellImages,
          flags: { ...noUnroll, unrollXY: true },
          dimensionLabels,
          showDimensionLabels: { xy: false },
        }).map((cell) => cell.label),
      ).toEqual(["XY 1", "XY 2"]);
    });

    it("skips axes and entries the dataset has no label for", () => {
      expect(
        getUnrollCells({
          cellImages: [
            image({ IndexXY: 0, IndexZ: 0 }),
            image({ IndexXY: 1, IndexZ: 1 }),
          ],
          flags: { ...noUnroll, unrollXY: true, unrollZ: true },
          // One XY label missing, no z labels at all.
          dimensionLabels: { xy: ["19263, -6626", ""], z: null },
        }).map((cell) => cell.label),
      ).toEqual(["XY 1 (19263, -6626) · Z 1", "XY 2 · Z 2"]);
    });

    it("labels each unrolled dimension it has an entry for", () => {
      expect(
        getUnrollCells({
          cellImages: [
            image({ IndexXY: 0, IndexZ: 0 }),
            image({ IndexXY: 1, IndexZ: 1 }),
          ],
          flags: { ...noUnroll, unrollXY: true, unrollZ: true },
          dimensionLabels: { xy: ["A01", "A02"], z: ["-3 µm", "-2 µm"] },
        }).map((cell) => cell.label),
      ).toEqual(["XY 1 (A01) · Z 1 (-3 µm)", "XY 2 (A02) · Z 2 (-2 µm)"]);
    });

    it("indexes labels by dataset rank, not by grid position", () => {
      // Same sparse-channel grid as above: cell 1 is XY 5, dataset index 2, so
      // it must show the third label.
      expect(
        getUnrollCells({
          cellImages: [0, 5].map((IndexXY) => image({ IndexXY })),
          axisImages: [0, 2, 5].map((IndexXY) => image({ IndexXY })),
          flags: { ...noUnroll, unrollXY: true },
          dimensionLabels: { xy: ["A01", "A02", "A03"] },
        }).map((cell) => cell.label),
      ).toEqual(["XY 1 (A01)", "XY 3 (A03)"]);
    });
  });
});

// ---- Grid geometry (issue #1280) --------------------------------------------

describe("unrollGridSize", () => {
  // The layout ImageViewer draws, and the definition store.unrollGrid mirrors.
  // These are the historical values of the inline formula it replaced.
  it.each([
    [1, 1, 1],
    [2, 2, 1],
    [3, 2, 2],
    [4, 2, 2],
    [5, 3, 2],
    [9, 3, 3],
    [16, 4, 4],
  ])("lays %i square frames out %ix%i", (cellCount, unrollW, unrollH) => {
    expect(unrollGridSize(cellCount, 1024, 1024)).toEqual({
      unrollW,
      unrollH,
    });
  });

  it("gives a wide frame fewer columns", () => {
    // Keeping the grid near one frame's aspect ratio means a 4:1 frame stacks
    // into rows sooner than a square one does.
    expect(unrollGridSize(4, 4000, 1000)).toEqual({ unrollW: 1, unrollH: 4 });
    expect(unrollGridSize(16, 4000, 1000)).toEqual({ unrollW: 2, unrollH: 8 });
  });

  it("never asks for more columns than there are frames", () => {
    expect(unrollGridSize(2, 1000, 4000)).toEqual({ unrollW: 2, unrollH: 1 });
  });

  // Degenerate inputs happen mid-load, when no frame has a size yet. A zero
  // width would make the cell offset NaN and put the camera nowhere.
  it.each([
    [0, 1024, 1024],
    [4, 0, 1024],
    [4, 1024, 0],
    [-1, 1024, 1024],
  ])("falls back to 1x1 for (%i, %i, %i)", (cellCount, sizeX, sizeY) => {
    expect(unrollGridSize(cellCount, sizeX, sizeY)).toEqual({
      unrollW: 1,
      unrollH: 1,
    });
  });
});

describe("unrollCellOffset", () => {
  it("walks the grid row-major", () => {
    expect(unrollCellOffset(0, 3, 100, 200)).toEqual({ x: 0, y: 0 });
    expect(unrollCellOffset(2, 3, 100, 200)).toEqual({ x: 200, y: 0 });
    expect(unrollCellOffset(3, 3, 100, 200)).toEqual({ x: 0, y: 200 });
    expect(unrollCellOffset(7, 3, 100, 200)).toEqual({ x: 100, y: 400 });
  });
});

// A dataset whose frames differ only in time, given keyOffsets in cell order —
// what parseTiles produces for the collapsed (unrolled) lookup.
function timeDataset(frameCount: number): IDataset {
  const frames = Array.from({ length: frameCount }, (_, i) => ({
    keyOffset: i,
    frame: { IndexXY: 0, IndexZ: 0, IndexT: i },
  }));
  return { images: () => frames } as unknown as IDataset;
}

describe("unrollCellIndex", () => {
  it("collapses the unrolled axes in the frame lookup", () => {
    const images = vi.fn().mockReturnValue([]);
    unrollCellIndex(
      { XY: 1, Z: 2, Time: 3 },
      { unrollXY: false, unrollZ: false, unrollT: true },
      { images } as unknown as IDataset,
    );
    // Signature is (z, time, xy, channel); only the unrolled axis becomes -1.
    expect(images).toHaveBeenCalledWith(2, -1, 1, 0);
  });

  it("resolves a location to its keyOffset", () => {
    const flags = { unrollXY: false, unrollZ: false, unrollT: true };
    expect(
      unrollCellIndex({ XY: 0, Z: 0, Time: 2 }, flags, timeDataset(4)),
    ).toBe(2);
  });

  const unrolledT = { unrollXY: false, unrollZ: false, unrollT: true };

  it("falls back to cell 0 with no dataset", () => {
    expect(unrollCellIndex({ XY: 0, Z: 0, Time: 2 }, unrolledT, null)).toBe(0);
  });

  it("falls back to cell 0 when the lookup has no frames", () => {
    for (const images of [() => null, () => []]) {
      expect(
        unrollCellIndex({ XY: 0, Z: 0, Time: 2 }, unrolledT, {
          images,
        } as unknown as IDataset),
      ).toBe(0);
    }
  });

  it("falls back to cell 0 when no frame matches the location", () => {
    expect(
      unrollCellIndex({ XY: 0, Z: 0, Time: 99 }, unrolledT, timeDataset(4)),
    ).toBe(0);
  });
});

describe("unrolledCoordinates", () => {
  const layout = (unrollW: number, frameCount: number) =>
    unrollLayoutFor({
      flags: { unrollXY: false, unrollZ: false, unrollT: true },
      unrollW,
      image: { sizeX: 1024, sizeY: 512 } as IImage,
      dataset: timeDataset(frameCount),
    });

  it("offsets a shape by its frame's cell", () => {
    expect(
      unrolledCoordinates(
        [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
        { XY: 0, Z: 0, Time: 3 },
        layout(2, 4), // cell 3 => column 1, row 1
      ),
    ).toEqual([
      { x: 10 + 1024, y: 20 + 512, z: undefined },
      { x: 30 + 1024, y: 40 + 512, z: undefined },
    ]);
  });

  it("preserves z", () => {
    expect(
      unrolledCoordinates(
        [{ x: 1, y: 2, z: 7 }],
        { XY: 0, Z: 0, Time: 1 },
        layout(4, 4),
      ),
    ).toEqual([{ x: 1 + 1024, y: 2, z: 7 }]);
  });

  // The un-unrolled path is the overwhelmingly common one and runs per
  // annotation per draw, so it must not allocate.
  it("returns the very same array when nothing is unrolled", () => {
    const coordinates = [{ x: 1, y: 2 }];
    const rolled = unrollLayoutFor({
      flags: { unrollXY: false, unrollZ: false, unrollT: false },
      unrollW: 1,
      image: { sizeX: 1024, sizeY: 512 } as IImage,
      dataset: timeDataset(4),
    });
    expect(rolled.unroll).toBe(false);
    expect(
      unrolledCoordinates(coordinates, { XY: 0, Z: 0, Time: 3 }, rolled),
    ).toBe(coordinates);
  });
});

describe("unrollLayoutFor", () => {
  it("is unrolled when any single axis is", () => {
    const base = {
      unrollW: 2,
      image: { sizeX: 8, sizeY: 4 } as IImage,
      dataset: null,
    };
    for (const flag of ["unrollXY", "unrollZ", "unrollT"] as const) {
      const flags = { unrollXY: false, unrollZ: false, unrollT: false };
      flags[flag] = true;
      expect(unrollLayoutFor({ ...base, flags }).unroll).toBe(true);
    }
  });

  it("tolerates a dataset with no sized frame yet", () => {
    expect(
      unrollLayoutFor({
        flags: { unrollXY: false, unrollZ: false, unrollT: true },
        unrollW: 1,
        image: null,
        dataset: null,
      }),
    ).toMatchObject({ sizeX: 0, sizeY: 0 });
  });
});
