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
