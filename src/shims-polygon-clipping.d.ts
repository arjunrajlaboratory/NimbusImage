declare module "polygon-clipping" {
  type Ring = [number, number][];
  type Polygon = Ring[];
  type MultiPolygon = Polygon[];

  interface PolygonClipping {
    union(...polygons: Polygon[]): MultiPolygon;
    intersection(...polygons: Polygon[]): MultiPolygon;
    difference(subject: Polygon, ...clippings: Polygon[]): MultiPolygon;
    xor(...polygons: Polygon[]): MultiPolygon;
  }

  const polygonClipping: PolygonClipping;
  export default polygonClipping;
}
