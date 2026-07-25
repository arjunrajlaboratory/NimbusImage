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
    expect(getUnrollCells([], { ...noUnroll, unrollXY: true })).toEqual([]);
  });

  it("labels and locates unrolled XY frames", () => {
    const images = [0, 1, 2].map((IndexXY) => image({ IndexXY }));
    expect(getUnrollCells(images, { ...noUnroll, unrollXY: true })).toEqual([
      { index: 0, label: "XY 1", location: { xy: 0 } },
      { index: 1, label: "XY 2", location: { xy: 1 } },
      { index: 2, label: "XY 3", location: { xy: 2 } },
    ]);
  });

  it("leaves cells unlabelled when nothing is unrolled", () => {
    const images = [0, 1].map((IndexXY) => image({ IndexXY }));
    expect(getUnrollCells(images, noUnroll)).toEqual([
      { index: 0, label: "", location: {} },
      { index: 1, label: "", location: {} },
    ]);
  });

  it("navigates by rank, not by raw frame value", () => {
    // dataset.xy holds the sorted distinct values, and store.xy indexes into
    // it, so XY 5 is the third XY of this dataset — index 2, not 5.
    const images = [0, 2, 5].map((IndexXY) => image({ IndexXY }));
    expect(getUnrollCells(images, { ...noUnroll, unrollXY: true })).toEqual([
      { index: 0, label: "XY 1", location: { xy: 0 } },
      { index: 1, label: "XY 2", location: { xy: 1 } },
      { index: 2, label: "XY 3", location: { xy: 2 } },
    ]);
  });

  it("falls back to PositionZ when IndexZ is absent", () => {
    const images = [0, 0.5, 1].map((PositionZ) => image({ PositionZ }));
    expect(getUnrollCells(images, { ...noUnroll, unrollZ: true })).toEqual([
      { index: 0, label: "Z 1", location: { z: 0 } },
      { index: 1, label: "Z 2", location: { z: 1 } },
      { index: 2, label: "Z 3", location: { z: 2 } },
    ]);
  });

  it("prefers IndexZ over PositionZ", () => {
    const images = [
      image({ IndexZ: 1, PositionZ: 12.5 }),
      image({ IndexZ: 0, PositionZ: 0.5 }),
    ];
    expect(getUnrollCells(images, { ...noUnroll, unrollZ: true })).toEqual([
      { index: 0, label: "Z 2", location: { z: 1 } },
      { index: 1, label: "Z 1", location: { z: 0 } },
    ]);
  });

  it("ranks by value regardless of grid order", () => {
    const images = [2, 0, 1].map((IndexT) => image({ IndexT }));
    expect(getUnrollCells(images, { ...noUnroll, unrollT: true })).toEqual([
      { index: 0, label: "Time 3", location: { time: 2 } },
      { index: 1, label: "Time 1", location: { time: 0 } },
      { index: 2, label: "Time 2", location: { time: 1 } },
    ]);
  });

  it("joins every unrolled dimension into one label", () => {
    const images = [
      image({ IndexXY: 0, IndexZ: 0 }),
      image({ IndexXY: 0, IndexZ: 1 }),
      image({ IndexXY: 1, IndexZ: 0 }),
      image({ IndexXY: 1, IndexZ: 1 }),
    ];
    expect(
      getUnrollCells(images, { ...noUnroll, unrollXY: true, unrollZ: true }),
    ).toEqual([
      { index: 0, label: "XY 1 · Z 1", location: { xy: 0, z: 0 } },
      { index: 1, label: "XY 1 · Z 2", location: { xy: 0, z: 1 } },
      { index: 2, label: "XY 2 · Z 1", location: { xy: 1, z: 0 } },
      { index: 3, label: "XY 2 · Z 2", location: { xy: 1, z: 1 } },
    ]);
  });

  it("keeps single-valued dimensions out of the label but in the location", () => {
    const images = [
      image({ IndexXY: 0, IndexT: 3 }),
      image({ IndexXY: 1, IndexT: 3 }),
    ];
    expect(
      getUnrollCells(images, { ...noUnroll, unrollXY: true, unrollT: true }),
    ).toEqual([
      { index: 0, label: "XY 1", location: { xy: 0, time: 0 } },
      { index: 1, label: "XY 2", location: { xy: 1, time: 0 } },
    ]);
  });

  it("treats a missing index as 0", () => {
    expect(
      getUnrollCells([image({})], { ...noUnroll, unrollXY: true }),
    ).toEqual([{ index: 0, label: "", location: { xy: 0 } }]);
  });
});
