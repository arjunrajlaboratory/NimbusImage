import { IDimensionLabels, IImage } from "@/store/model";

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

/** Per-dimension switch for appending the dataset's dimension label. */
export type TUnrollLabelSwitches = {
  [Axis in keyof IUnrollCellLocation]?: boolean;
};

export interface IUnrollCell {
  /** Grid cell index, i.e. the frame's `keyOffset`. */
  index: number;
  /**
   * Corner text, 1-based to match the navigator sliders' `offset` of 1
   * ("XY 3", "XY 3 (19263, -6626)", or "XY 3 · Z 2" when several dimensions
   * are unrolled at once). Empty when no unrolled dimension has more than one
   * value.
   */
  label: string;
  location: IUnrollCellLocation;
}

export interface IUnrollCellsOptions {
  /**
   * The grid's frames in cell order — the `images` of the `layerStackImages`
   * entry whose tiles the grid is drawn from.
   */
  cellImages: IImage[];
  flags: IUnrollFlags;
  /**
   * Every frame of the dataset (`dataset.allImages`). Axis indices are ranked
   * over these, because that is the set `dataset.xy` / `.z` / `.time` are built
   * from — ranking over `cellImages` alone is wrong as soon as the drawn layer
   * covers fewer frames than the dataset does. Defaults to `cellImages`, which
   * is equivalent whenever the layer covers every frame.
   */
  axisImages?: IImage[];
  /** `dataset.dimensionLabels`, if the dataset has any. */
  dimensionLabels?: IDimensionLabels | null;
  /** Defaults to on for every dimension. */
  showDimensionLabels?: TUnrollLabelSwitches;
}

// One entry per unrollable dimension. `value` mirrors how `parseTiles` reads
// the frame, including the `PositionZ` fallback, so the ordered distinct values
// here are the same ones `dataset.z` etc. are built from. `title` matches the
// navigator slider labels, and `labels` names the `dimensionLabels` key, which
// is `t` where the location key is `time`.
const UNROLL_AXES = [
  {
    key: "xy",
    flag: "unrollXY",
    title: "XY",
    labels: "xy",
    value: (image: IImage) => image.frame.IndexXY ?? 0,
  },
  {
    key: "z",
    flag: "unrollZ",
    title: "Z",
    labels: "z",
    value: (image: IImage) => image.frame.IndexZ ?? image.frame.PositionZ ?? 0,
  },
  {
    key: "time",
    flag: "unrollT",
    title: "Time",
    labels: "t",
    value: (image: IImage) => image.frame.IndexT ?? 0,
  },
] as const satisfies readonly {
  key: keyof IUnrollCellLocation;
  flag: keyof IUnrollFlags;
  title: string;
  labels: keyof IDimensionLabels;
  value: (image: IImage) => number;
}[];

// The distinct values of one dimension in ascending order. `parseTiles` builds
// `dataset.xy` / `.z` / `.time` the same way, and the store navigates by index
// into those arrays — so a frame's position here is the index to set. That is
// not the raw frame value in general: `z` can fall back to a `PositionZ` float,
// and nothing guarantees dense indices.
function sortedAxisValues(images: IImage[], value: (i: IImage) => number) {
  return [...new Set(images.map(value))].sort((a, b) => a - b);
}

/** Describe every cell of the unrolled grid. */
export function getUnrollCells({
  cellImages,
  flags,
  axisImages,
  dimensionLabels,
  showDimensionLabels,
}: IUnrollCellsOptions): IUnrollCell[] {
  const unrolledAxes = UNROLL_AXES.filter((axis) => flags[axis.flag]).map(
    (axis) => {
      const values = sortedAxisValues(axisImages ?? cellImages, axis.value);
      return {
        ...axis,
        ranks: new Map(values.map((value, rank) => [value, rank])),
        // A dimension with a single value carries no information, so it is left
        // out of the label ("XY 3", not "XY 3 · Time 1" on one timepoint). It
        // stays in the location so navigating still pins it.
        labelled: values.length > 1,
        dimensionLabels:
          showDimensionLabels?.[axis.key] ?? true
            ? dimensionLabels?.[axis.labels]
            : null,
      };
    },
  );

  return cellImages.map((cellImage, index) => {
    const location: IUnrollCellLocation = {};
    const labelParts: string[] = [];
    for (const axis of unrolledAxes) {
      const rank = axis.ranks.get(axis.value(cellImage)) ?? 0;
      location[axis.key] = rank;
      if (axis.labelled) {
        // The dimension label array is indexed the same way the store is, so
        // by rank rather than by the cell's position in the grid.
        const dimensionLabel = axis.dimensionLabels?.[rank];
        labelParts.push(
          dimensionLabel
            ? `${axis.title} ${rank + 1} (${dimensionLabel})`
            : `${axis.title} ${rank + 1}`,
        );
      }
    }
    return { index, label: labelParts.join(" · "), location };
  });
}
