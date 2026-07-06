import vtkCellArray from "@kitware/vtk.js/Common/Core/CellArray";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkLookupTable, {
  vtkLookupTable as VtkLookupTable,
} from "@kitware/vtk.js/Common/Core/LookupTable";
import vtkPoints from "@kitware/vtk.js/Common/Core/Points";
import vtkPolyData, {
  vtkPolyData as VtkPolyData,
} from "@kitware/vtk.js/Common/DataModel/PolyData";
import earcut from "earcut";
import {
  AnnotationShape,
  IAnnotation,
  IAnnotationPropertyValues,
  TVolumeAxis,
  TVolumeSegmentationColorMode,
} from "@/store/model";
import { getValueFromObjectAndPath } from "@/utils/paths";
import { logWarning } from "@/utils/log";
import type { VolumeGeometry } from "@/store/VolumeAPI";

export interface IAnnotationsTo3DOptions {
  annotations: IAnnotation[];
  geometry: VolumeGeometry;
  currentXY: number;
  currentTime: number;
  // The current z index, used to filter annotations when time is the depth
  // axis (only annotations on this z plane are shown).
  currentZ?: number;
  // Which axis is mapped to the volume depth. Defaults to "z".
  axis?: TVolumeAxis;
  colorMode: TVolumeSegmentationColorMode;
  propertyPath: string[];
  propertyValues: IAnnotationPropertyValues;
}

export interface IAnnotationsTo3DResult {
  // Extruded polygon/rectangle prisms and line ribbons, one scalar per cell.
  // Rendered as a shaded, translucent surface.
  surfacePolyData: VtkPolyData;
  // One point per point annotation, one scalar per point. Rendered as spheres
  // of radius `pointRadius`.
  pointsPolyData: VtkPolyData;
  // Sphere radius (µm) for point annotations, derived from the volume size.
  pointRadius: number;
  lookupTable: VtkLookupTable;
  scalarRange: [number, number];
  usedCount: number;
  skippedByShape: Record<string, number>;
}

const tagPalette: [number, number, number][] = [
  [0.82, 0.66, 1.0],
  [0.22, 0.72, 0.96],
  [0.44, 0.86, 0.45],
  [0.96, 0.38, 0.52],
  [0.69, 0.54, 0.95],
  [0.98, 0.57, 0.26],
  [0.34, 0.83, 0.78],
  [0.9, 0.48, 0.82],
];

function makeLookupTable(
  colors: [number, number, number][],
  scalarRange: [number, number],
): VtkLookupTable {
  const lookupTable = vtkLookupTable.newInstance();
  lookupTable.setRange(scalarRange[0], scalarRange[1]);
  lookupTable.setNumberOfColors(colors.length);

  const table = new Uint8Array(colors.length * 4);
  colors.forEach(([red, green, blue], index) => {
    const offset = index * 4;
    table[offset] = Math.round(red * 255);
    table[offset + 1] = Math.round(green * 255);
    table[offset + 2] = Math.round(blue * 255);
    table[offset + 3] = 255;
  });
  lookupTable.setTable(
    vtkDataArray.newInstance({
      numberOfComponents: 4,
      values: table,
    }),
  );
  return lookupTable;
}

function neutralLookupTable(): VtkLookupTable {
  return makeLookupTable([[0.74, 0.74, 0.7]], [0, 1]);
}

function finitePoints(points: IAnnotation["coordinates"]) {
  return points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: point.x, y: point.y }));
}

function normalizedPolygon(points: IAnnotation["coordinates"]) {
  const result = finitePoints(points);
  const first = result[0];
  const last = result.at(-1);
  if (first && last && first.x === last.x && first.y === last.y) {
    result.pop();
  }
  return result;
}

// Converts source-image pixel coordinates and depth indices to world µm.
interface IWorldTransform {
  toX(x: number): number;
  toY(y: number): number;
  zCenter(depthIndex: number): number;
  spacingZ: number;
}

function makeWorldTransform(geometry: VolumeGeometry): IWorldTransform {
  const [spacingX, spacingY, spacingZ] = geometry.spacing;
  const [originX, originY, originZ] = geometry.origin;
  const [fetchedWidth, fetchedHeight] = geometry.dimensions;
  const [sourceWidth, sourceHeight] = geometry.sourceSize;
  const sourceSpacingX = spacingX * (fetchedWidth / sourceWidth);
  const sourceSpacingY = spacingY * (fetchedHeight / sourceHeight);
  return {
    toX: (x) => originX + x * sourceSpacingX,
    toY: (y) => originY + y * sourceSpacingY,
    zCenter: (depthIndex) => originZ + depthIndex * spacingZ,
    spacingZ,
  };
}

// Sphere radius for point annotations: a few source pixels across and at
// least most of a slice thickness, but never a large fraction of the volume.
function suggestedPointRadius(geometry: VolumeGeometry): number {
  const [spacingX, spacingY, spacingZ] = geometry.spacing;
  const [dimX, dimY, dimZ] = geometry.dimensions;
  const [sourceWidth, sourceHeight] = geometry.sourceSize;
  const sourceSpacingX = spacingX * (dimX / sourceWidth);
  const sourceSpacingY = spacingY * (dimY / sourceHeight);
  const diagonal = Math.hypot(
    dimX * spacingX,
    dimY * spacingY,
    dimZ * spacingZ,
  );
  const radius = Math.min(
    Math.max(3 * Math.max(sourceSpacingX, sourceSpacingY), 0.6 * spacingZ),
    diagonal / 50,
  );
  return Number.isFinite(radius) && radius > 0 ? radius : 1;
}

interface ISurfaceMesh {
  points: number[];
  triangles: number[];
  cellScalars: number[];
}

function addPrism(
  sourcePoints: { x: number; y: number }[],
  depthIndex: number,
  scalar: number,
  world: IWorldTransform,
  mesh: ISurfaceMesh,
) {
  const z0 = world.zCenter(depthIndex) - world.spacingZ / 2;
  const z1 = z0 + world.spacingZ;
  const baseIndex = mesh.points.length / 3;

  for (const point of sourcePoints) {
    mesh.points.push(world.toX(point.x), world.toY(point.y), z0);
  }
  for (const point of sourcePoints) {
    mesh.points.push(world.toX(point.x), world.toY(point.y), z1);
  }

  const addTriangle = (a: number, b: number, c: number) => {
    mesh.triangles.push(3, a, b, c);
    mesh.cellScalars.push(scalar);
  };

  // Triangulate the (possibly concave) polygon caps via earcut. Backface
  // culling is disabled on the actor, so cap winding does not matter.
  const flat: number[] = [];
  for (const point of sourcePoints) {
    flat.push(point.x, point.y);
  }
  const topBase = baseIndex + sourcePoints.length;
  const capIndices = earcut(flat);
  for (let index = 0; index < capIndices.length; index += 3) {
    const a = capIndices[index];
    const b = capIndices[index + 1];
    const c = capIndices[index + 2];
    addTriangle(baseIndex + a, baseIndex + b, baseIndex + c);
    addTriangle(topBase + a, topBase + c, topBase + b);
  }

  for (let index = 0; index < sourcePoints.length; index += 1) {
    const next = (index + 1) % sourcePoints.length;
    const bottomA = baseIndex + index;
    const bottomB = baseIndex + next;
    const topA = baseIndex + sourcePoints.length + index;
    const topB = baseIndex + sourcePoints.length + next;
    addTriangle(bottomA, bottomB, topB);
    addTriangle(bottomA, topB, topA);
  }
}

// Extrudes a polyline through the slice thickness, producing a vertical
// ribbon (two triangles per segment) that matches the prism walls visually.
function addRibbon(
  sourcePoints: { x: number; y: number }[],
  depthIndex: number,
  scalar: number,
  world: IWorldTransform,
  mesh: ISurfaceMesh,
) {
  const z0 = world.zCenter(depthIndex) - world.spacingZ / 2;
  const z1 = z0 + world.spacingZ;
  const baseIndex = mesh.points.length / 3;

  for (const point of sourcePoints) {
    mesh.points.push(world.toX(point.x), world.toY(point.y), z0);
  }
  for (const point of sourcePoints) {
    mesh.points.push(world.toX(point.x), world.toY(point.y), z1);
  }

  const topBase = baseIndex + sourcePoints.length;
  for (let index = 0; index < sourcePoints.length - 1; index += 1) {
    mesh.triangles.push(
      3,
      baseIndex + index,
      baseIndex + index + 1,
      topBase + index + 1,
    );
    mesh.cellScalars.push(scalar);
    mesh.triangles.push(
      3,
      baseIndex + index,
      topBase + index + 1,
      topBase + index,
    );
    mesh.cellScalars.push(scalar);
  }
}

type TSegmentationKind = "prism" | "ribbon" | "sphere";

interface ISegmentationItem {
  annotation: IAnnotation;
  kind: TSegmentationKind;
  // Source-pixel coordinates: polygon vertices (prism), polyline vertices
  // (ribbon), or a single center (sphere).
  planarPoints: { x: number; y: number }[];
}

function classifyAnnotation(
  annotation: IAnnotation,
  skippedByShape: Record<string, number>,
): ISegmentationItem | null {
  switch (annotation.shape) {
    case AnnotationShape.Polygon:
    case AnnotationShape.Rectangle: {
      const polygon = normalizedPolygon(annotation.coordinates);
      if (polygon.length >= 3) {
        return { annotation, kind: "prism", planarPoints: polygon };
      }
      break;
    }
    case AnnotationShape.Line: {
      const line = finitePoints(annotation.coordinates);
      if (line.length >= 2) {
        return { annotation, kind: "ribbon", planarPoints: line };
      }
      break;
    }
    case AnnotationShape.Point: {
      const center = finitePoints(annotation.coordinates);
      if (center.length >= 1) {
        return { annotation, kind: "sphere", planarPoints: [center[0]] };
      }
      break;
    }
    default:
      skippedByShape[annotation.shape] =
        (skippedByShape[annotation.shape] ?? 0) + 1;
      return null;
  }
  skippedByShape.empty = (skippedByShape.empty ?? 0) + 1;
  return null;
}

function buildSurfacePolyData(mesh: ISurfaceMesh): VtkPolyData {
  const polyData = vtkPolyData.newInstance();
  const points = vtkPoints.newInstance({ empty: true });
  points.setData(new Float32Array(mesh.points), 3);
  polyData.setPoints(points);
  polyData.setPolys(
    vtkCellArray.newInstance({ values: new Uint32Array(mesh.triangles) }),
  );
  if (mesh.cellScalars.length > 0) {
    polyData.getCellData().setScalars(
      vtkDataArray.newInstance({
        name: "annotationScalar",
        numberOfComponents: 1,
        values: new Float32Array(mesh.cellScalars),
      }),
    );
  }
  return polyData;
}

function buildPointsPolyData(
  coordinates: number[],
  scalars: number[],
): VtkPolyData {
  const polyData = vtkPolyData.newInstance();
  const points = vtkPoints.newInstance({ empty: true });
  points.setData(new Float32Array(coordinates), 3);
  polyData.setPoints(points);
  const numberOfPoints = scalars.length;
  const verts = new Uint32Array(numberOfPoints * 2);
  for (let index = 0; index < numberOfPoints; index += 1) {
    verts[index * 2] = 1;
    verts[index * 2 + 1] = index;
  }
  polyData.setVerts(vtkCellArray.newInstance({ values: verts }));
  if (numberOfPoints > 0) {
    polyData.getPointData().setScalars(
      vtkDataArray.newInstance({
        name: "annotationScalar",
        numberOfComponents: 1,
        values: new Float32Array(scalars),
      }),
    );
  }
  return polyData;
}

export function annotationsTo3D(
  options: IAnnotationsTo3DOptions,
): IAnnotationsTo3DResult {
  const axis = options.axis ?? "z";
  const currentZ = options.currentZ ?? 0;
  // Keep annotations in the current field of view; the depth axis spans all of
  // its values, while the other (fixed) axis must match the current index.
  const relevantAnnotations = options.annotations.filter(
    (annotation) =>
      annotation.location.XY === options.currentXY &&
      (axis === "z"
        ? annotation.location.Time === options.currentTime
        : annotation.location.Z === currentZ),
  );

  const pointRadius = suggestedPointRadius(options.geometry);
  const skippedByShape: Record<string, number> = {};
  const items = relevantAnnotations.flatMap((annotation) => {
    const item = classifyAnnotation(annotation, skippedByShape);
    return item ? [item] : [];
  });

  if (Object.keys(skippedByShape).length > 0) {
    logWarning("Skipped unsupported 3D annotation shapes", skippedByShape);
  }

  const propertyScalars = items.map(({ annotation }) => {
    const value = getValueFromObjectAndPath(
      options.propertyValues[annotation.id] ?? {},
      options.propertyPath,
    );
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  });
  const canUsePropertyScalars =
    options.colorMode === "property" &&
    options.propertyPath.length > 0 &&
    propertyScalars.length > 0 &&
    propertyScalars.every((value) => value !== null);
  const neutralPropertyScalars =
    options.colorMode === "property" && !canUsePropertyScalars;

  const tagToScalar = new Map<string, number>();
  const world = makeWorldTransform(options.geometry);
  const surfaceMesh: ISurfaceMesh = {
    points: [],
    triangles: [],
    cellScalars: [],
  };
  const spherePoints: number[] = [];
  const sphereScalars: number[] = [];
  let usedAnnotationCount = 0;
  let minScalar = Number.POSITIVE_INFINITY;
  let maxScalar = Number.NEGATIVE_INFINITY;

  // When the volume depth was subsampled, original depth index d maps to the
  // (possibly fractional) voxel position d / depthStride, keeping the
  // annotation at its true physical depth.
  const depthStride = options.geometry.depthStride ?? 1;
  items.forEach((item, index) => {
    const originalDepth =
      axis === "z" ? item.annotation.location.Z : item.annotation.location.Time;
    const depthIndex = originalDepth / depthStride;
    if (depthIndex < 0 || depthIndex >= options.geometry.dimensions[2]) {
      skippedByShape.outOfBoundsDepth =
        (skippedByShape.outOfBoundsDepth ?? 0) + 1;
      return;
    }

    let scalar = 0;
    if (canUsePropertyScalars) {
      scalar = propertyScalars[index] ?? 0;
    } else if (!neutralPropertyScalars) {
      const tag = item.annotation.tags[0] ?? "untagged";
      if (!tagToScalar.has(tag)) {
        tagToScalar.set(tag, tagToScalar.size);
      }
      scalar = tagToScalar.get(tag) ?? 0;
    }
    minScalar = Math.min(minScalar, scalar);
    maxScalar = Math.max(maxScalar, scalar);

    switch (item.kind) {
      case "prism":
        addPrism(item.planarPoints, depthIndex, scalar, world, surfaceMesh);
        break;
      case "ribbon":
        addRibbon(item.planarPoints, depthIndex, scalar, world, surfaceMesh);
        break;
      case "sphere": {
        const center = item.planarPoints[0];
        spherePoints.push(
          world.toX(center.x),
          world.toY(center.y),
          world.zCenter(depthIndex),
        );
        sphereScalars.push(scalar);
        break;
      }
    }
    usedAnnotationCount += 1;
  });

  const surfacePolyData = buildSurfacePolyData(surfaceMesh);
  const pointsPolyData = buildPointsPolyData(spherePoints, sphereScalars);

  if (usedAnnotationCount === 0) {
    return {
      surfacePolyData,
      pointsPolyData,
      pointRadius,
      lookupTable: neutralLookupTable(),
      scalarRange: [0, 1],
      usedCount: 0,
      skippedByShape,
    };
  }

  const scalarRange: [number, number] =
    minScalar === maxScalar
      ? [minScalar, minScalar + 1]
      : [minScalar, maxScalar];
  const tagColors = Array.from(tagToScalar.values()).map(
    (tagIndex) => tagPalette[tagIndex % tagPalette.length],
  );
  const lookupTable = canUsePropertyScalars
    ? makeLookupTable(
        [
          [0.2, 0.55, 0.95],
          [0.96, 0.9, 0.34],
          [0.92, 0.22, 0.32],
        ],
        scalarRange,
      )
    : neutralPropertyScalars
      ? neutralLookupTable()
      : makeLookupTable(tagColors.length ? tagColors : [[0.74, 0.74, 0.7]], [
          0,
          Math.max(tagColors.length - 1, 1),
        ]);

  return {
    surfacePolyData,
    pointsPolyData,
    pointRadius,
    lookupTable,
    scalarRange,
    usedCount: usedAnnotationCount,
    skippedByShape,
  };
}
