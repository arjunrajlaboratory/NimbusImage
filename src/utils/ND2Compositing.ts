// Stage-position compositing for ND2 files: lays every source out by the
// stage position recorded in its file's `nd2_frame_metadata`. Works for one
// multi-position file and for a folder of files (e.g. one file per tile).
//
// Ported to Python in
// devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/
// helpers/multi_source.py (`_can_composite`, `_compositing_positions`,
// `compositing_check`); the parity fixtures keep the two in lockstep, so
// change both together.
import { IGeoJSPositionWithTransform } from "@/store/model";

export interface ICompositingTileMeta {
  sizeX: number;
  sizeY: number;
  mm_x: number;
  mm_y: number;
  frames?: any[];
  IndexRange?: { IndexC?: number } | null;
}

type TInternalMetadata = { [key: string]: any };

interface ICameraTransform {
  s11: number;
  s12: number;
  s21: number;
  s22: number;
}

export interface ICompositingLayout {
  // Pixel position of every `nd2_frame_metadata` entry of every item,
  // concatenated in item order; `itemOffsets[itemIdx]` is where that item's
  // entries start.
  coordinates: IGeoJSPositionWithTransform[];
  itemOffsets: number[];
  // One tile's width and height in mosaic pixels, after the camera
  // transform (a rotated non-square tile swaps them).
  tileWidth: number;
  tileHeight: number;
}

// Two XY positions closer than this fraction of a tile are the same field
// imaged twice.
export const DUPLICATE_POSITION_FRACTION = 0.1;
// Tiles covering less than this fraction of the mosaic's bounding box look
// like separate regions (e.g. different wells), not one stitched area.
export const SPARSE_COVERAGE_FRACTION = 0.25;
// A composite of more tiles than this renders zoomed-out views from that
// many sources unless it is transcoded, so transcode becomes the default.
export const COMPOSITE_TRANSCODE_TILE_THRESHOLD = 16;
// Sub-cells per tolerance cell (per axis) in the duplicate check.
const DUPLICATE_SUBCELLS = 8;
// Camera matrices closer than this are the same orientation.
const CAMERA_MATRIX_TOLERANCE = 0.01;

function frameCount(tile: ICompositingTileMeta): number {
  return tile.frames?.length || 1;
}

function channelsInFile(tile: ICompositingTileMeta): number {
  return tile.IndexRange?.IndexC || 1;
}

/**
 * Which of a file's `nd2_frame_metadata` entries frame `frameIdx` uses.
 * ND2 records one entry per camera frame (position × Z × T) and large_image
 * lists the file's channels fastest within it, so the entry is the frame
 * index divided by the file's own channel count.
 */
export function compositingFrameMetadataIndex(
  tile: ICompositingTileMeta,
  frameIdx: number,
): number {
  return Math.floor(frameIdx / channelsInFile(tile));
}

function isPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && isFinite(value) && value > 0;
}

function hasStagePositions(internalMeta: TInternalMetadata): boolean {
  const framesMetadata = internalMeta?.nd2_frame_metadata;
  return (
    Array.isArray(framesMetadata) &&
    framesMetadata.length > 0 &&
    framesMetadata.every(
      (frame: any) =>
        Array.isArray(frame?.position?.stagePositionUm) &&
        frame.position.stagePositionUm.length >= 2 &&
        frame.position.stagePositionUm
          .slice(0, 2)
          .every((v: unknown) => typeof v === "number" && isFinite(v)),
    )
  );
}

// The camera matrix of one file; a matrix within 0.01 of -I snaps to -I,
// and a missing one is the identity.
function cameraTransform(internalMeta: TInternalMetadata): ICameraTransform {
  const chan = internalMeta.nd2?.channels;
  const volume = chan
    ? chan.volume !== undefined
      ? chan.volume
      : chan[0]?.volume
    : undefined;
  const matrix = volume?.cameraTransformationMatrix;
  if (
    Array.isArray(matrix) &&
    matrix.length >= 4 &&
    matrix.slice(0, 4).every((v) => typeof v === "number" && isFinite(v)) &&
    (Math.abs(matrix[0] - 1) > CAMERA_MATRIX_TOLERANCE ||
      Math.abs(matrix[3] - 1) > CAMERA_MATRIX_TOLERANCE)
  ) {
    if (
      Math.abs(matrix[0] - -1) < CAMERA_MATRIX_TOLERANCE &&
      Math.abs(matrix[3] - -1) < CAMERA_MATRIX_TOLERANCE
    ) {
      return { s11: -1.0, s12: 0.0, s21: 0.0, s22: -1.0 };
    }
    return { s11: matrix[0], s12: matrix[1], s21: matrix[2], s22: matrix[3] };
  }
  return { s11: 1, s12: 0, s21: 0, s22: 1 };
}

// One tile's width and height in mosaic pixels under `transform`.
function tileFootprint(
  transform: ICameraTransform,
  sizeX: number,
  sizeY: number,
) {
  const corners = [
    { x: 0, y: 0 },
    { x: sizeX, y: 0 },
    { x: 0, y: sizeY },
    { x: sizeX, y: sizeY },
  ].map((corner) => ({
    x: transform.s11 * corner.x + transform.s12 * corner.y,
    y: transform.s21 * corner.x + transform.s22 * corner.y,
  }));
  const xs = extent(corners, (c) => c.x);
  const ys = extent(corners, (c) => c.y);
  return {
    width: xs.max - xs.min,
    height: ys.max - ys.min,
    minX: xs.min,
    minY: ys.min,
  };
}

function sameTransform(a: ICameraTransform, b: ICameraTransform): boolean {
  return (["s11", "s12", "s21", "s22"] as const).every(
    (key) => Math.abs(a[key] - b[key]) <= CAMERA_MATRIX_TOLERANCE,
  );
}

/**
 * Whether the items can be composited by stage position: every file has a
 * stage position for each camera frame its frames use, a usable pixel size,
 * and the same camera orientation (the mosaic extent is computed from one).
 * Several files additionally need the same tile geometry and an XY
 * assignment that tells their positions apart (`xyAssignmentSize > 1`), so
 * the option appears once the user moves the tile-index variable to XY.
 */
export function canCompositeByStagePosition(
  tilesMetadata: ICompositingTileMeta[],
  internalMetadata: TInternalMetadata[],
  xyAssignmentSize: number,
): boolean {
  if (
    tilesMetadata.length === 0 ||
    tilesMetadata.length !== internalMetadata.length ||
    !internalMetadata.every(hasStagePositions) ||
    !tilesMetadata.every(
      (tile) =>
        isPositiveNumber(tile.sizeX) &&
        isPositiveNumber(tile.sizeY) &&
        isPositiveNumber(tile.mm_x) &&
        isPositiveNumber(tile.mm_y),
    ) ||
    !tilesMetadata.every(
      (tile, itemIdx) =>
        compositingFrameMetadataIndex(tile, frameCount(tile) - 1) <
        internalMetadata[itemIdx].nd2_frame_metadata.length,
    )
  ) {
    return false;
  }
  const firstTransform = cameraTransform(internalMetadata[0]);
  const footprint = tileFootprint(
    firstTransform,
    tilesMetadata[0].sizeX,
    tilesMetadata[0].sizeY,
  );
  if (
    // A degenerate matrix (e.g. all zeros) collapses the tile to nothing.
    !(footprint.width > 0 && footprint.height > 0) ||
    !internalMetadata.every((meta) =>
      sameTransform(cameraTransform(meta), firstTransform),
    )
  ) {
    return false;
  }
  if (tilesMetadata.length === 1) {
    return true;
  }
  const first = tilesMetadata[0];
  return (
    xyAssignmentSize > 1 &&
    tilesMetadata.every(
      (tile) =>
        tile.sizeX === first.sizeX &&
        tile.sizeY === first.sizeY &&
        tile.mm_x === first.mm_x &&
        tile.mm_y === first.mm_y,
    )
  );
}

// Min and max of one field without spreading into Math.min/max, which
// overflows the call stack for very large frame counts.
function extent<T>(values: T[], field: (value: T) => number) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    const v = field(value);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/**
 * Pixel positions for every `nd2_frame_metadata` entry of every item. All
 * files share the first file's pixel size and camera orientation (the gate
 * checks both), which also sets the mosaic's extent.
 */
export function compositingCoordinates(
  tilesMetadata: ICompositingTileMeta[],
  internalMetadata: TInternalMetadata[],
): ICompositingLayout {
  const { mm_x, mm_y, sizeX, sizeY } = tilesMetadata[0];
  const coordinates: IGeoJSPositionWithTransform[] = [];
  const itemOffsets: number[] = [];
  for (const internalMeta of internalMetadata) {
    itemOffsets.push(coordinates.length);
    const transform = cameraTransform(internalMeta);
    for (const frame of internalMeta.nd2_frame_metadata) {
      const framePos = frame.position.stagePositionUm;
      coordinates.push({
        x: framePos[0] / (mm_x * 1000),
        y: framePos[1] / (mm_y * 1000),
        ...transform,
      });
    }
  }

  const footprint = tileFootprint(
    {
      s11: coordinates[0]?.s11 ?? 1,
      s12: coordinates[0]?.s12 ?? 0,
      s21: coordinates[0]?.s21 ?? 0,
      s22: coordinates[0]?.s22 ?? 1,
    },
    sizeX,
    sizeY,
  );
  const coordX = extent(coordinates, (c) => c.x);
  const coordY = extent(coordinates, (c) => c.y);
  const minCoordinate = { x: coordX.min + footprint.minX };
  const maxCoordinate = { y: coordY.max - footprint.minY };
  return {
    coordinates: coordinates.map((c) => ({
      x: Math.round(c.x - minCoordinate.x),
      y: Math.round(maxCoordinate.y - c.y),
      s11: c.s11,
      s12: c.s12,
      s21: c.s21,
      s22: c.s22,
    })),
    itemOffsets,
    tileWidth: footprint.width,
    tileHeight: footprint.height,
  };
}

// Why a requested composite cannot be honored when the files fail the gate.
export const COMPOSITING_UNAVAILABLE =
  "Composite was requested, but these files cannot be laid out by stage " +
  "position: that needs ND2 stage positions for every frame, one tile " +
  "size, pixel size and camera orientation, and (for several files) an " +
  "XY assignment that tells them apart. Leave Composite off to configure " +
  "them as separate XY positions.";

export interface ICompositingCheck {
  error: string | null;
  warning: string | null;
  // Distinct tiles (stage positions) in the composite; null with an error.
  tileCount: number | null;
}

/**
 * Problems with laying these sources out by stage position, from every
 * stage entry the sources use. `error`: two entries with different XY
 * values at the same stage position (the same field imaged twice), which
 * refuses compositing. Entries sharing an XY value there (a Z stack, or
 * channels split across files) are one tile. `warning`: the tiles cover
 * little of the mosaic, which does not refuse it. `tileCount`: the
 * distinct tiles the composite holds. `xyValue(itemIdx,
 * frameIdx)` is the frame's XY assignment.
 */
export function compositingCheck(
  itemNames: string[],
  tilesMetadata: ICompositingTileMeta[],
  layout: ICompositingLayout,
  xyValue: (itemIdx: number, frameIdx: number) => number,
): ICompositingCheck {
  // Measured in mosaic space: the camera transform can rotate the tile.
  const { tileWidth, tileHeight } = layout;
  const tolX = DUPLICATE_POSITION_FRACTION * tileWidth;
  const tolY = DUPLICATE_POSITION_FRACTION * tileHeight;

  const points: { x: number; y: number; xy: number; item: number }[] = [];
  for (let itemIdx = 0; itemIdx < itemNames.length; ++itemIdx) {
    const tile = tilesMetadata[itemIdx];
    let lastEntry = -1;
    for (let frameIdx = 0; frameIdx < frameCount(tile); ++frameIdx) {
      const entry = compositingFrameMetadataIndex(tile, frameIdx);
      if (entry === lastEntry) {
        continue;
      }
      lastEntry = entry;
      const position = layout.coordinates[layout.itemOffsets[itemIdx] + entry];
      points.push({
        x: position.x,
        y: position.y,
        xy: xyValue(itemIdx, frameIdx),
        item: itemIdx,
      });
    }
  }

  // Points are bucketed into tolerance-sized cells, each split into
  // DUPLICATE_SUBCELLS x DUPLICATE_SUBCELLS sub-cells. Each sub-cell keeps
  // one box per XY value covering every point of that value merged there,
  // so a long Z/T stack at one position stays a few entries (linear), and
  // no merged point is forgotten: a different-XY point within tolerance of
  // any of them is caught. A box spans at most 1/DUPLICATE_SUBCELLS of the
  // tolerance, which bounds how far "near a box" can overstate "near a
  // point".
  interface ICellBox {
    xy: number;
    sub: string; // sub-cell within the cell
    first: number; // index of the earliest point in the box
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  }
  const near = (box: ICellBox, x: number, y: number) =>
    Math.max(box.minX - x, x - box.maxX, 0) < tolX &&
    Math.max(box.minY - y, y - box.maxY, 0) < tolY;
  let error: string | null = null;
  let tileCount = 0;
  const cells = new Map<string, ICellBox[]>();
  for (let index = 0; index < points.length && error === null; ++index) {
    const point = points[index];
    const cellX = Math.floor(point.x / tolX);
    const cellY = Math.floor(point.y / tolY);
    let duplicateOf: number | null = null;
    let sameTile = false;
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) {
        for (const box of cells.get(`${cellX + dx},${cellY + dy}`) ?? []) {
          if (!near(box, point.x, point.y)) {
            continue;
          }
          if (box.xy === point.xy) {
            sameTile = true;
          } else if (duplicateOf === null || box.first < duplicateOf) {
            duplicateOf = box.first;
          }
        }
      }
    }
    if (duplicateOf !== null) {
      const first = points[duplicateOf];
      error =
        `"${itemNames[first.item]}" (XY ${first.xy + 1}) and ` +
        `"${itemNames[point.item]}" (XY ${point.xy + 1}) are at the same ` +
        "stage position, so compositing would draw one on top of the " +
        "other. Remove the duplicate, or leave Composite off to keep them " +
        "as separate XY positions.";
      break;
    }
    if (!sameTile) {
      tileCount++;
    }
    const key = `${cellX},${cellY}`;
    const sub =
      `${Math.floor(point.x / (tolX / DUPLICATE_SUBCELLS))},` +
      `${Math.floor(point.y / (tolY / DUPLICATE_SUBCELLS))}`;
    const cell = cells.get(key) ?? [];
    const box = cell.find((b) => b.xy === point.xy && b.sub === sub);
    if (box) {
      box.minX = Math.min(box.minX, point.x);
      box.maxX = Math.max(box.maxX, point.x);
      box.minY = Math.min(box.minY, point.y);
      box.maxY = Math.max(box.maxY, point.y);
    } else {
      cell.push({
        xy: point.xy,
        sub,
        first: index,
        minX: point.x,
        maxX: point.x,
        minY: point.y,
        maxY: point.y,
      });
      cells.set(key, cell);
    }
  }

  let warning: string | null = null;
  if (error === null && tileCount > 1) {
    const xs = extent(points, (p) => p.x);
    const ys = extent(points, (p) => p.y);
    const width = xs.max - xs.min + tileWidth;
    const height = ys.max - ys.min + tileHeight;
    const coverage = (tileCount * tileWidth * tileHeight) / (width * height);
    if (coverage < SPARSE_COVERAGE_FRACTION) {
      warning =
        `The ${tileCount} tiles cover only ` +
        `${Math.round(coverage * 100)}% of the ${Math.round(width)} × ` +
        `${Math.round(height)} ` +
        "px composite, so they look like separate regions (for example, " +
        "different wells). Consider leaving Composite off to keep them as " +
        "separate XY positions.";
    }
  }
  return { error, warning, tileCount: error === null ? tileCount : null };
}

/**
 * Transcode by default when compositing many tiles: zoomed-out views of an
 * untranscoded composite read every source (about 78 s for 6,400 tiles).
 * Counts composited positions, whether from many files or one
 * multi-position file.
 */
export function compositeTranscodeDefault(
  transcodeDefault: boolean,
  compositing: boolean,
  tileCount: number | null,
): boolean {
  return (
    transcodeDefault ||
    (compositing && (tileCount ?? 0) > COMPOSITE_TRANSCODE_TILE_THRESHOLD)
  );
}
