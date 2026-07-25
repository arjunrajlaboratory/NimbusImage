import { describe, it, expect } from "vitest";
import { IImage } from "@/store/model";
import { getUnrollCells, IUnrollFlags } from "./unroll";

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
