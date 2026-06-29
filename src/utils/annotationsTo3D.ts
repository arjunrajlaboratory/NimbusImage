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
  polyData: VtkPolyData;
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
    table[offset + 3] = 190;
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

function normalizedPolygon(points: IAnnotation["coordinates"]) {
  const result = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: point.x, y: point.y }));
  const first = result[0];
  const last = result.at(-1);
  if (first && last && first.x === last.x && first.y === last.y) {
    result.pop();
  }
  return result;
}

function addPrism(
  sourcePoints: { x: number; y: number }[],
  depthIndex: number,
  scalar: number,
  geometry: VolumeGeometry,
  points: number[],
  triangles: number[],
  cellScalars: number[],
) {
  const [spacingX, spacingY, spacingZ] = geometry.spacing;
  const [originX, originY, originZ] = geometry.origin;
  const [fetchedWidth, fetchedHeight] = geometry.dimensions;
  const [sourceWidth, sourceHeight] = geometry.sourceSize;
  const sourceSpacingX = spacingX * (fetchedWidth / sourceWidth);
  const sourceSpacingY = spacingY * (fetchedHeight / sourceHeight);
  const z0 = originZ + depthIndex * spacingZ - spacingZ / 2;
  const z1 = z0 + spacingZ;
  const baseIndex = points.length / 3;

  for (const point of sourcePoints) {
    points.push(originX + point.x * sourceSpacingX);
    points.push(originY + point.y * sourceSpacingY);
    points.push(z0);
  }
  for (const point of sourcePoints) {
    points.push(originX + point.x * sourceSpacingX);
    points.push(originY + point.y * sourceSpacingY);
    points.push(z1);
  }

  const addTriangle = (a: number, b: number, c: number) => {
    triangles.push(3, a, b, c);
    cellScalars.push(scalar);
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

function buildEmptyResult(): IAnnotationsTo3DResult {
  const polyData = vtkPolyData.newInstance();
  const points = vtkPoints.newInstance({ empty: true });
  points.setData(new Float32Array(), 3);
  polyData.setPoints(points);
  polyData.setPolys(vtkCellArray.newInstance({ values: new Uint32Array() }));
  return {
    polyData,
    lookupTable: neutralLookupTable(),
    scalarRange: [0, 1],
    usedCount: 0,
    skippedByShape: {},
  };
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
  if (relevantAnnotations.length === 0) {
    return buildEmptyResult();
  }

  const skippedByShape: Record<string, number> = {};
  const polygons = relevantAnnotations.flatMap((annotation) => {
    if (annotation.shape !== AnnotationShape.Polygon) {
      skippedByShape[annotation.shape] =
        (skippedByShape[annotation.shape] ?? 0) + 1;
      return [];
    }
    const polygon = normalizedPolygon(annotation.coordinates);
    if (polygon.length < 3) {
      skippedByShape.empty = (skippedByShape.empty ?? 0) + 1;
      return [];
    }
    return [{ annotation, polygon }];
  });

  if (Object.keys(skippedByShape).length > 0) {
    logWarning("Skipped unsupported 3D annotation shapes", skippedByShape);
  }

  if (polygons.length === 0) {
    return { ...buildEmptyResult(), skippedByShape };
  }

  const propertyScalars = polygons.map(({ annotation }) => {
    const value = getValueFromObjectAndPath(
      options.propertyValues[annotation.id] ?? {},
      options.propertyPath,
    );
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  });
  const canUsePropertyScalars =
    options.colorMode === "property" &&
    options.propertyPath.length > 0 &&
    propertyScalars.every((value) => value !== null);
  const neutralPropertyScalars =
    options.colorMode === "property" && !canUsePropertyScalars;

  const tagToScalar = new Map<string, number>();
  const points: number[] = [];
  const triangles: number[] = [];
  const cellScalars: number[] = [];
  let usedAnnotationCount = 0;
  let minScalar = Number.POSITIVE_INFINITY;
  let maxScalar = Number.NEGATIVE_INFINITY;

  // When the volume depth was subsampled, original depth index d maps to the
  // (possibly fractional) voxel position d / depthStride, keeping the prism at
  // its true physical depth.
  const depthStride = options.geometry.depthStride ?? 1;
  polygons.forEach(({ annotation, polygon }, index) => {
    const originalDepth =
      axis === "z" ? annotation.location.Z : annotation.location.Time;
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
      const tag = annotation.tags[0] ?? "untagged";
      if (!tagToScalar.has(tag)) {
        tagToScalar.set(tag, tagToScalar.size);
      }
      scalar = tagToScalar.get(tag) ?? 0;
    }
    minScalar = Math.min(minScalar, scalar);
    maxScalar = Math.max(maxScalar, scalar);
    addPrism(
      polygon,
      depthIndex,
      scalar,
      options.geometry,
      points,
      triangles,
      cellScalars,
    );
    usedAnnotationCount += 1;
  });

  if (cellScalars.length === 0) {
    return { ...buildEmptyResult(), skippedByShape };
  }

  const polyData = vtkPolyData.newInstance();
  const vtkPointArray = vtkPoints.newInstance({ empty: true });
  vtkPointArray.setData(new Float32Array(points), 3);
  polyData.setPoints(vtkPointArray);
  polyData.setPolys(
    vtkCellArray.newInstance({ values: new Uint32Array(triangles) }),
  );
  polyData.getCellData().setScalars(
    vtkDataArray.newInstance({
      name: "annotationScalar",
      numberOfComponents: 1,
      values: new Float32Array(cellScalars),
    }),
  );

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
    polyData,
    lookupTable,
    scalarRange,
    usedCount: usedAnnotationCount,
    skippedByShape,
  };
}
