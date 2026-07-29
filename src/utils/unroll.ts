import {
  IAnnotationLocation,
  IDataset,
  IDimensionLabels,
  IGeoJSPosition,
  IImage,
} from "@/store/model";
import { unrollIndexFromImages } from "@/utils/annotation";

// Helpers for the unrolled image grid: what each cell is, what it should be
// labelled, which frame it navigates back to (issue #151), and where a point
// drawn on one of its frames actually lands (issue #1280).
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

// ---- Grid geometry (issue #1280) --------------------------------------------
//
// Everything below answers one question: given a point in a frame's own
// coordinates, where does it end up on the unrolled grid? The rendering path
// (`AnnotationViewer`) and the navigation path (`annotationNavigation`) BOTH
// need that answer, and they used to disagree — navigation centred the camera on
// the raw centroid while the viewer drew the annotation a tile-width away, so
// clicking an Object Browser row for anything outside the first tile panned to
// the wrong place. One implementation, used by both, is what keeps them honest.

/** The unrolled grid's dimensions, in cells. */
export interface IUnrollGrid {
  unrollW: number;
  unrollH: number;
}

/** A 1×1 grid — the layout when nothing is unrolled, or nothing is loaded. */
const SINGLE_CELL: IUnrollGrid = { unrollW: 1, unrollH: 1 };

/**
 * Lay `cellCount` frames of `sizeX`×`sizeY` out into the grid the viewer draws.
 *
 * Row-major, with the column count chosen to keep the whole grid roughly the
 * aspect ratio of a single frame. This is the definition — `ImageViewer` sizes
 * its maps and positions its frame labels from it, and the store mirrors it in
 * `unrollGrid` for everyone else, so it must stay the only copy of the formula.
 */
export function unrollGridSize(
  cellCount: number,
  sizeX: number,
  sizeY: number,
): IUnrollGrid {
  if (cellCount < 1 || sizeX <= 0 || sizeY <= 0) {
    return SINGLE_CELL;
  }
  const unrollW = Math.min(
    cellCount,
    Math.max(1, Math.ceil(Math.sqrt(sizeX * sizeY * cellCount) / sizeX)),
  );
  return { unrollW, unrollH: Math.ceil(cellCount / unrollW) };
}

/**
 * Which cell of the grid the frame at `location` occupies.
 *
 * Mirrors how `parseTiles` builds the collapsed lookup: the unrolled dimensions
 * are asked for as -1 so every frame lands in one entry, and the frame's
 * position within it (`keyOffset`) is its cell.
 */
export function unrollCellIndex(
  location: IAnnotationLocation,
  flags: IUnrollFlags,
  dataset: IDataset | null,
): number {
  const images = dataset?.images(
    flags.unrollZ ? -1 : location.Z,
    flags.unrollT ? -1 : location.Time,
    flags.unrollXY ? -1 : location.XY,
    0,
  );
  if (!images) {
    return 0;
  }
  return unrollIndexFromImages(location.XY, location.Z, location.Time, images);
}

/**
 * Everything needed to place a frame-local point on the grid.
 *
 * Build one with `unrollLayoutFor`, never by hand — the two callers that matter
 * (the drawing path and the navigation path) have to agree, and going through
 * one constructor is what makes that checkable.
 */
export interface IUnrollLayout {
  /** When false, coordinates pass through untouched. */
  unroll: boolean;
  flags: IUnrollFlags;
  /** Columns in the grid — `unrollGridSize().unrollW`. */
  unrollW: number;
  /** One cell's size in world units, i.e. any frame's `sizeX` / `sizeY`. */
  sizeX: number;
  sizeY: number;
  /** Frame lookup, for resolving a location to its cell. */
  dataset: IDataset | null;
}

/**
 * Assemble a layout from store state.
 *
 * `unrollW` is the one input the two callers supply differently, deliberately.
 * `AnnotationViewer` passes its prop — the grid `ImageViewer` last laid the tiles
 * out on — so drawing stays keyed to what is on screen, and so drawn centroids
 * don't take a reactive dependency on `layerStackImages` (which changes on every
 * contrast tweak). Navigation passes `store.unrollGrid.unrollW`. They are the
 * same number: `ImageViewer` sets that prop from `unrollGridSize` over the same
 * `layerStackImages` entry `store.unrollGrid` reads.
 */
export function unrollLayoutFor({
  flags,
  unrollW,
  image,
  dataset,
}: {
  flags: IUnrollFlags;
  unrollW: number;
  /** Any frame of the dataset — only its `sizeX` / `sizeY` are read. */
  image: IImage | null | undefined;
  dataset: IDataset | null;
}): IUnrollLayout {
  return {
    unroll: flags.unrollXY || flags.unrollZ || flags.unrollT,
    flags,
    unrollW,
    sizeX: image?.sizeX ?? 0,
    sizeY: image?.sizeY ?? 0,
    dataset,
  };
}

/** The world-space origin of grid cell `cellIndex`. */
export function unrollCellOffset(
  cellIndex: number,
  unrollW: number,
  sizeX: number,
  sizeY: number,
): IGeoJSPosition {
  return {
    x: sizeX * Math.floor(cellIndex % unrollW),
    y: sizeY * Math.floor(cellIndex / unrollW),
  };
}

/**
 * Translate `coordinates` — a shape's points in its own frame's coordinates —
 * to where that shape is drawn on the unrolled grid.
 *
 * Returns the input array itself when nothing is unrolled, so the common path
 * allocates nothing.
 */
export function unrolledCoordinates(
  coordinates: IGeoJSPosition[],
  location: IAnnotationLocation,
  layout: IUnrollLayout,
): IGeoJSPosition[] {
  if (!layout.unroll) {
    return coordinates;
  }
  const offset = unrollCellOffset(
    unrollCellIndex(location, layout.flags, layout.dataset),
    layout.unrollW,
    layout.sizeX,
    layout.sizeY,
  );
  return coordinates.map((point) => ({
    x: offset.x + point.x,
    y: offset.y + point.y,
    z: point.z,
  }));
}

/** `unrolledCoordinates` for a single point. */
export function unrolledPoint(
  point: IGeoJSPosition,
  location: IAnnotationLocation,
  layout: IUnrollLayout,
): IGeoJSPosition {
  return unrolledCoordinates([point], location, layout)[0];
}
