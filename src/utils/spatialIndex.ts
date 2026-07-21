import RBush from "rbush";

interface SpatialItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
}

export class AnnotationSpatialIndex {
  private tree: RBush<SpatialItem> = new RBush<SpatialItem>();
  private itemById: Map<string, SpatialItem> = new Map();

  bulkLoad(items: { id: string; x: number; y: number }[]): void {
    this.tree = new RBush<SpatialItem>();
    this.itemById = new Map();
    const spatialItems: SpatialItem[] = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const { id, x, y } = items[i];
      const item: SpatialItem = { minX: x, minY: y, maxX: x, maxY: y, id };
      spatialItems[i] = item;
      this.itemById.set(id, item);
    }
    this.tree.load(spatialItems);
  }

  insert(id: string, x: number, y: number): void {
    // Upsert: drop any existing node for this id first so re-inserting can't
    // orphan the old RBush node (itemById would then point only at the new one,
    // making the stale node un-removable and queryable forever — Finding 5).
    if (this.itemById.has(id)) {
      this.remove(id);
    }
    const item: SpatialItem = { minX: x, minY: y, maxX: x, maxY: y, id };
    this.tree.insert(item);
    this.itemById.set(id, item);
  }

  remove(id: string): void {
    const item = this.itemById.get(id);
    if (item) {
      this.tree.remove(item);
      this.itemById.delete(id);
    }
  }

  splitByViewport(
    currentFrameIds: string[],
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): { inViewportIds: string[]; outOfViewportIds: string[] } {
    const inViewport = this.tree.search({ minX, minY, maxX, maxY });
    const inViewportSet = new Set<string>();
    for (const item of inViewport) {
      inViewportSet.add(item.id);
    }

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
   * Classify `currentFrameIds` against TWO nested boxes in a single pass:
   *   - `inViewport`: inside the inner (unexpanded) box — the region the user sees
   *   - `ring`: inside the outer (expanded) box but NOT the inner — the pan-preload margin
   *   - `outside`: outside the outer box
   * The inner box must be contained in the outer box (it always is here: the outer
   * is the inner expanded by 50% each side). This replaces two `splitByViewport`
   * calls plus a caller-side set-difference with one iteration over
   * `currentFrameIds`, using the already-indexed point coordinates directly
   * instead of running two tree searches and building two full result sets.
   * That matters on the hot visibility-update path at ~700K.
   */
  partitionByViewports(
    currentFrameIds: string[],
    innerBox: { minX: number; minY: number; maxX: number; maxY: number },
    outerBox: { minX: number; minY: number; maxX: number; maxY: number },
  ): { inViewport: string[]; ring: string[]; outside: string[] } {
    const inViewport: string[] = [];
    const ring: string[] = [];
    const outside: string[] = [];
    for (const id of currentFrameIds) {
      const item = this.itemById.get(id);
      if (!item) {
        outside.push(id);
        continue;
      }
      // SpatialItem entries are points: bulkLoad and insert always set
      // minX === maxX and minY === maxY.
      const { minX, minY } = item;
      if (
        minX >= innerBox.minX &&
        minX <= innerBox.maxX &&
        minY >= innerBox.minY &&
        minY <= innerBox.maxY
      ) {
        inViewport.push(id);
      } else if (
        minX >= outerBox.minX &&
        minX <= outerBox.maxX &&
        minY >= outerBox.minY &&
        minY <= outerBox.maxY
      ) {
        ring.push(id);
      } else {
        outside.push(id);
      }
    }
    return { inViewport, ring, outside };
  }

  queryBox(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): Set<string> {
    const results = this.tree.search({ minX, minY, maxX, maxY });
    const ids = new Set<string>();
    for (const item of results) {
      ids.add(item.id);
    }
    return ids;
  }

  clear(): void {
    this.tree = new RBush<SpatialItem>();
    this.itemById = new Map();
  }
}

// Module-level singleton — lives outside Vuex reactive state.
// RBush internal nodes would be corrupted by Vue's reactivity proxying.
export const annotationSpatialIndex = new AnnotationSpatialIndex();
