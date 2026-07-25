import { IImage } from "@/store/model";

// Helpers for the unrolled image grid: what each cell is, what it should be
// labelled, and which frame it navigates back to (issue #151).
//
// When a dimension is unrolled, `parseTiles` collapses that dimension's key to
// -1 so every frame lands in one lookup entry, and each frame's position in
// that entry (its `keyOffset`) is its cell in the grid. `ImageViewer` lays the
// grid out row-major with `unrollW` columns, so cell `index` sits at
// `(index % unrollW, floor(index / unrollW))`.

/** Which frame dimensions are currently unrolled into the grid. */
export interface IUnrollFlags {
  unrollXY: boolean;
  unrollZ: boolean;
  unrollT: boolean;
}

/**
 * A location to navigate to, in the same terms as `store.xy` / `.z` / `.time`:
 * indices into `dataset.xy` / `.z` / `.time`. Dimensions that are not unrolled
 * are absent — they already hold the value the user is looking at.
 */
export interface IUnrollCellLocation {
  xy?: number;
  z?: number;
  time?: number;
}

export interface IUnrollCell {
  /** Grid cell index, i.e. the frame's `keyOffset`. */
  index: number;
  /**
   * Corner text, 1-based to match the navigator sliders' `offset` of 1
   * ("XY 3", or "XY 3 · Z 2" when several dimensions are unrolled at once).
   * Empty when no unrolled dimension has more than one value.
   */
  label: string;
  location: IUnrollCellLocation;
}

// One entry per unrollable dimension. `value` mirrors how `parseTiles` reads
// the frame, including the `PositionZ` fallback, so the ordered distinct values
// here are the same ones `dataset.z` etc. are built from. `title` matches the
// navigator slider labels.
const UNROLL_AXES = [
  {
    key: "xy",
    flag: "unrollXY",
    title: "XY",
    value: (image: IImage) => image.frame.IndexXY ?? 0,
  },
  {
    key: "z",
    flag: "unrollZ",
    title: "Z",
    value: (image: IImage) => image.frame.IndexZ ?? image.frame.PositionZ ?? 0,
  },
  {
    key: "time",
    flag: "unrollT",
    title: "Time",
    value: (image: IImage) => image.frame.IndexT ?? 0,
  },
] as const satisfies readonly {
  key: keyof IUnrollCellLocation;
  flag: keyof IUnrollFlags;
  title: string;
  value: (image: IImage) => number;
}[];

/**
 * Describe every cell of the unrolled grid.
 *
 * @param images The images of one unrolled layer, in grid order — the `images`
 *   of a `layerStackImages` entry, whose order is the frames' `keyOffset`.
 * @param flags Which dimensions are unrolled.
 */
export function getUnrollCells(
  images: IImage[],
  flags: IUnrollFlags,
): IUnrollCell[] {
  const unrolledAxes = UNROLL_AXES.filter((axis) => flags[axis.flag]).map(
    (axis) => {
      const values = images.map(axis.value);
      // `dataset.xy` / `.z` / `.time` hold the sorted distinct values of the
      // dimension, and the store navigates by index into those arrays. So a
      // frame's rank among the sorted distinct values *is* the index to set,
      // which is not the raw frame value in general (`z` can fall back to a
      // `PositionZ` float, and nothing guarantees dense indices).
      const ranks = new Map(
        [...new Set(values)].sort((a, b) => a - b).map((v, rank) => [v, rank]),
      );
      return { ...axis, values, ranks };
    },
  );

  return images.map((_image, index) => {
    const location: IUnrollCellLocation = {};
    const labelParts: string[] = [];
    for (const axis of unrolledAxes) {
      const rank = axis.ranks.get(axis.values[index]) ?? 0;
      location[axis.key] = rank;
      // A dimension with a single value carries no information, so leave it out
      // of the label ("XY 3", not "XY 3 · Time 1" on one timepoint). It stays
      // in the location so navigating still pins it.
      if (axis.ranks.size > 1) {
        labelParts.push(`${axis.title} ${rank + 1}`);
      }
    }
    return { index, label: labelParts.join(" · "), location };
  });
}
