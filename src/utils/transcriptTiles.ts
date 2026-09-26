import { IGeoJSBounds, ISpatialTranscriptsSchema } from "@/store/model";

/**
 * Level-of-detail arithmetic for the transcript overlay (SPATIAL_PLUGIN.md,
 * Phase 3). Pure so the choices can be tested without a map.
 *
 * The 10x pyramid tiles level L in squares of `gridSizeMicrons * 2^L`
 * microns, keyed "gx,gy" from the origin. The viewer's bounds are image
 * pixels; a registration on another image (H&E) carries a transform from
 * the transcripts' pixel grid to this one, so the view goes through its
 * inverse before the pixel size turns it into microns.
 */

/** Tiles per request the overlay is willing to ask for at one level. */
export const MAX_TRANSCRIPT_TILES_PER_REQUEST = 64;
/** In "auto" mode, the heat map takes over when points would have to come
 * from tiles this coarse or coarser (1 mm at the default 250 um grid): a
 * whole section of clustered points is a solid sheet, the heat map is not. */
export const AUTO_DENSITY_LEVEL = 2;
/** A gene averages 1/genes of the molecules, but the panel's popular genes
 * run far above the mean; the estimate leans that way. */
export const GENE_SHARE_FACTOR = 5;

export interface ITranscriptLevelPlan {
  level: number;
  tiles: string[];
  // Upper-bound guess of the points those tiles hold for the chosen genes.
  estimate: number;
  // The plan fits the tile cap and the point budget.
  fits: boolean;
}

export function invertAffine3(matrix: number[][]): number[][] {
  const [[a, b, c], [d, e, f]] = matrix;
  const det = a * e - b * d;
  if (!Number.isFinite(det) || det === 0) {
    throw new Error("transform is not invertible");
  }
  return [
    [e / det, -b / det, (b * f - c * e) / det],
    [-d / det, a / det, (c * d - a * f) / det],
    [0, 0, 1],
  ];
}

function applyAffine(matrix: number[][], x: number, y: number) {
  return {
    x: matrix[0][0] * x + matrix[0][1] * y + matrix[0][2],
    y: matrix[1][0] * x + matrix[1][1] * y + matrix[1][2],
  };
}

/** The viewer's bounds (image pixels, clamped to the image) as microns on
 * the transcripts' grid. Returns null when nothing of the image is on
 * screen. */
export function viewToTranscriptMicrons(
  view: IGeoJSBounds,
  schema: Pick<ISpatialTranscriptsSchema, "pixelSize" | "transform">,
  sizeX: number,
  sizeY: number,
): IGeoJSBounds | null {
  const left = Math.max(0, Math.min(view.left, view.right));
  const right = Math.min(sizeX, Math.max(view.left, view.right));
  const top = Math.max(0, Math.min(view.top, view.bottom));
  const bottom = Math.min(sizeY, Math.max(view.top, view.bottom));
  if (right <= left || bottom <= top) {
    return null;
  }
  let corners = [
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
  ];
  if (schema.transform) {
    const inverse = invertAffine3(schema.transform);
    corners = corners.map((corner) => applyAffine(inverse, corner.x, corner.y));
  }
  const xs = corners.map((corner) => corner.x * schema.pixelSize);
  const ys = corners.map((corner) => corner.y * schema.pixelSize);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

/** Keys of the level's tiles that intersect the view AND exist in the
 * pyramid, with their point counts. */
export function tilesInView(
  schema: Pick<ISpatialTranscriptsSchema, "gridSizeMicrons" | "tiles">,
  level: number,
  viewMicrons: IGeoJSBounds,
): { keys: string[]; count: number } {
  const size = schema.gridSizeMicrons * Math.pow(2, level);
  const levelTiles = schema.tiles[level];
  const gx0 = Math.floor(viewMicrons.left / size);
  const gx1 = Math.floor(viewMicrons.right / size);
  const gy0 = Math.floor(viewMicrons.top / size);
  const gy1 = Math.floor(viewMicrons.bottom / size);
  const wanted = new Set<string>();
  for (let gx = Math.max(0, gx0); gx <= gx1; gx++) {
    for (let gy = Math.max(0, gy0); gy <= gy1; gy++) {
      wanted.add(`${gx},${gy}`);
    }
  }
  const keys: string[] = [];
  let count = 0;
  levelTiles.keys.forEach((key, index) => {
    if (wanted.has(key)) {
      keys.push(key);
      count += levelTiles.counts[index];
    }
  });
  return { keys, count };
}

export function estimatePoints(
  tileCount: number,
  geneCount: number,
  totalGenes: number,
): number {
  if (totalGenes <= 0) {
    return tileCount;
  }
  return Math.ceil(
    tileCount * Math.min(1, (geneCount * GENE_SHARE_FACTOR) / totalGenes),
  );
}

/** The finest level whose view tiles fit the tile cap and the point budget;
 * the coarsest level (flagged `fits: false`) when none does. */
export function planTranscriptLevel(
  schema: Pick<
    ISpatialTranscriptsSchema,
    "gridSizeMicrons" | "tiles" | "genes"
  >,
  viewMicrons: IGeoJSBounds,
  geneCount: number,
  pointBudget: number,
): ITranscriptLevelPlan {
  let fallback: ITranscriptLevelPlan | null = null;
  for (let level = 0; level < schema.tiles.length; level++) {
    const { keys, count } = tilesInView(schema, level, viewMicrons);
    const estimate = estimatePoints(count, geneCount, schema.genes);
    const plan = { level, tiles: keys, estimate, fits: true };
    if (
      keys.length <= MAX_TRANSCRIPT_TILES_PER_REQUEST &&
      estimate <= pointBudget
    ) {
      return plan;
    }
    fallback = { ...plan, fits: false };
  }
  return fallback ?? { level: 0, tiles: [], estimate: 0, fits: true };
}
