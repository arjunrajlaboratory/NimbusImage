import RBush from "rbush";

interface SpatialItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
}

/**
 * R-tree spatial index for annotation centroids.
 *
 * Stores annotation centroids as degenerate bounding boxes (point = minX===maxX, minY===maxY)
 * in an rbush R-tree for O(log n + k) viewport queries instead of O(n) linear scans.
 *
 * IMPORTANT: This class must live outside Vuex reactive state.
 * Vue 2's Object.defineProperty would recursively walk rbush's internal nodes and corrupt the tree.
 */
export class AnnotationSpatialIndex {
  private tree: RBush<SpatialItem>;

  constructor() {
    this.tree = new RBush<SpatialItem>();
  }

  /**
   * Clear the tree and bulk-load new items.
   * More efficient than individual inserts for initial load.
   */
  bulkLoad(items: { id: string; x: number; y: number }[]): void {
    this.tree.clear();
    const spatialItems: SpatialItem[] = items.map((item) => ({
      minX: item.x,
      minY: item.y,
      maxX: item.x,
      maxY: item.y,
      id: item.id,
    }));
    this.tree.load(spatialItems);
  }

  /**
   * Insert a single annotation centroid into the tree.
   */
  insert(id: string, x: number, y: number): void {
    this.tree.insert({ minX: x, minY: y, maxX: x, maxY: y, id });
  }

  /**
   * Remove a single annotation from the tree.
   * Requires the original coordinates to locate the item efficiently.
   */
  remove(id: string, x: number, y: number): void {
    const item: SpatialItem = { minX: x, minY: y, maxX: x, maxY: y, id };
    this.tree.remove(item, (a, b) => a.id === b.id);
  }

  /**
   * Split currentFrameIds into in-viewport and out-of-viewport sets
   * using an R-tree bbox query.
   *
   * This replaces the O(n) linear scan with O(log n + k) where k = annotations in viewport.
   * After the R-tree query, results are intersected with currentFrameIds via a Set.
   */
  splitByViewport(
    currentFrameIds: string[],
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): { inViewportIds: string[]; outOfViewportIds: string[] } {
    // Query the R-tree for all points in the bounding box
    const results = this.tree.search({ minX, minY, maxX, maxY });
    const inViewportSet = new Set(results.map((item) => item.id));

    const inViewportIds: string[] = [];
    const outOfViewportIds: string[] = [];

    for (const id of currentFrameIds) {
      if (inViewportSet.has(id)) {
        inViewportIds.push(id);
      } else {
        outOfViewportIds.push(id);
      }
    }

    return { inViewportIds, outOfViewportIds };
  }

  /**
   * Clear all items from the tree.
   */
  clear(): void {
    this.tree.clear();
  }
}

/**
 * Module-level singleton.
 * Must NOT be placed inside Vuex state — Vue 2 reactivity would corrupt the R-tree.
 */
export const annotationSpatialIndex = new AnnotationSpatialIndex();
