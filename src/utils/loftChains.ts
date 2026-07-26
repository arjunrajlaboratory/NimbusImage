import { IPlanarPoint, overlapFraction } from "@/utils/contourLoft";

// Chain matching for lofted 3D annotation surfaces (see annotationsTo3D.ts).
// Pure plain-data functions so the work can run in a web worker; use
// computeLoftChains (loftChainsWorkerClient.ts) from the UI thread.

export interface ILoftChainInput {
  polygon: IPlanarPoint[];
  // Depth in original slice indices; only consecutive depths can be linked.
  depth: number;
  // Polygons are only linked within the same group (the annotation tag).
  group: string;
}

export interface ILoftChainRequest {
  requestId: number;
  inputs: ILoftChainInput[];
  minOverlapFraction: number;
}

export interface ILoftChainResponse {
  requestId: number;
  chains: number[][];
}

// Pairs each polygon with at most one polygon on the next slice — greedy
// best-overlap matching, like frame-to-frame tracking — and returns the
// resulting chains as lists of input indices, ordered by depth. Only
// same-group polygons on consecutive depths whose xy overlap reaches
// `minOverlapFraction` (fraction of the smaller polygon's area; 0 links any
// positive overlap) are joined; unlinked polygons come back as chains of 1.
export function buildLoftChainIndices(
  inputs: ILoftChainInput[],
  minOverlapFraction: number,
): number[][] {
  const allBounds = inputs.map(({ polygon }) => {
    const xs = polygon.map((point) => point.x);
    const ys = polygon.map((point) => point.y);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
  const boundsIntersect = (a: number, b: number) => {
    const [aMinX, aMinY, aMaxX, aMaxY] = allBounds[a];
    const [bMinX, bMinY, bMaxX, bMaxY] = allBounds[b];
    return aMinX <= bMaxX && bMinX <= aMaxX && aMinY <= bMaxY && bMinY <= aMaxY;
  };

  const byGroupAndDepth = new Map<string, Map<number, number[]>>();
  inputs.forEach((input, index) => {
    const byDepth = byGroupAndDepth.get(input.group) ?? new Map();
    byGroupAndDepth.set(input.group, byDepth);
    byDepth.set(input.depth, [...(byDepth.get(input.depth) ?? []), index]);
  });

  const nextOf = new Map<number, number>();
  const hasPrevious = new Set<number>();
  for (const byDepth of byGroupAndDepth.values()) {
    for (const [depth, sliceIndices] of byDepth) {
      const nextSliceIndices = byDepth.get(depth + 1);
      if (!nextSliceIndices) {
        continue;
      }
      const candidates: { lower: number; upper: number; overlap: number }[] =
        [];
      for (const lower of sliceIndices) {
        for (const upper of nextSliceIndices) {
          if (!boundsIntersect(lower, upper)) {
            continue;
          }
          const overlap = overlapFraction(
            inputs[lower].polygon,
            inputs[upper].polygon,
          );
          if (overlap > 0 && overlap >= minOverlapFraction) {
            candidates.push({ lower, upper, overlap });
          }
        }
      }
      candidates.sort((a, b) => b.overlap - a.overlap);
      for (const { lower, upper } of candidates) {
        if (!nextOf.has(lower) && !hasPrevious.has(upper)) {
          nextOf.set(lower, upper);
          hasPrevious.add(upper);
        }
      }
    }
  }

  const chains: number[][] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    if (hasPrevious.has(index)) {
      continue;
    }
    const chain: number[] = [];
    for (
      let link: number | undefined = index;
      link !== undefined;
      link = nextOf.get(link)
    ) {
      chain.push(link);
    }
    chains.push(chain);
  }
  return chains;
}
