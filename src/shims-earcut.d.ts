declare module "earcut" {
  // Triangulate a flat [x0, y0, x1, y1, ...] coordinate array; returns a flat
  // list of triangle vertex indices into the input ring.
  function earcut(
    data: ArrayLike<number>,
    holeIndices?: ArrayLike<number> | null,
    dimensions?: number,
  ): number[];
  export default earcut;
}
