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
import {
  IPlanarPoint,
  alignRingToReference,
  resampleClosedContour,
} from "@/utils/contourLoft";
import { computeLoftChains } from "@/utils/loftChainsWorkerClient";
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
  // Loft same-tag polygons that overlap in xy on adjacent depth slices into
  // continuous surfaces instead of per-slice prisms. Defaults to false.
  loftSurfaces?: boolean;
  // Minimum xy overlap — as a fraction of the smaller polygon's area, in
  // [0, 1] — for two annotations on adjacent slices to count as the same
  // object. 0 (the default) connects any positive overlap.
  loftOverlapFraction?: number;
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

// World µm per source-image pixel in x and y.
function sourcePixelSpacing(geometry: VolumeGeometry): [number, number] {
  const [spacingX, spacingY] = geometry.spacing;
  const [fetchedWidth, fetchedHeight] = geometry.dimensions;
  const [sourceWidth, sourceHeight] = geometry.sourceSize;
  return [
    spacingX * (fetchedWidth / sourceWidth),
    spacingY * (fetchedHeight / sourceHeight),
  ];
}

// Converts source-image pixel coordinates and depth indices to world µm.
interface IWorldTransform {
  toX(x: number): number;
  toY(y: number): number;
  zCenter(depthIndex: number): number;
}

function makeWorldTransform(geometry: VolumeGeometry): IWorldTransform {
  const spacingZ = geometry.spacing[2];
  const [originX, originY, originZ] = geometry.origin;
  const [sourceSpacingX, sourceSpacingY] = sourcePixelSpacing(geometry);
  return {
    toX: (x) => originX + x * sourceSpacingX,
    toY: (y) => originY + y * sourceSpacingY,
    zCenter: (depthIndex) => originZ + depthIndex * spacingZ,
  };
}

// Sphere radius for point annotations: a few source pixels across and at
// least most of a slice thickness, but never a large fraction of the volume.
function suggestedPointRadius(geometry: VolumeGeometry): number {
  const [spacingX, spacingY, spacingZ] = geometry.spacing;
  const [dimX, dimY, dimZ] = geometry.dimensions;
  const [sourceSpacingX, sourceSpacingY] = sourcePixelSpacing(geometry);
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
  sourcePoints: IPlanarPoint[],
  depthIndex: number,
  scalar: number,
  halfThickness: number,
  world: IWorldTransform,
  mesh: ISurfaceMesh,
) {
  const z0 = world.zCenter(depthIndex) - halfThickness;
  const z1 = world.zCenter(depthIndex) + halfThickness;
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
  sourcePoints: IPlanarPoint[],
  depthIndex: number,
  scalar: number,
  halfThickness: number,
  world: IWorldTransform,
  mesh: ISurfaceMesh,
) {
  const z0 = world.zCenter(depthIndex) - halfThickness;
  const z1 = world.zCenter(depthIndex) + halfThickness;
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

// A polygon annotation queued for surface emission, with its depth resolved.
interface IPrismEntry {
  polygon: IPlanarPoint[];
  // Depth in original slice indices (used to find adjacent slices).
  originalDepth: number;
  // Depth in (possibly subsampled) volume voxels (used to place geometry).
  depthIndex: number;
  scalar: number;
  tag: string;
}

// Resampled ring sizes for lofted surfaces: enough points to keep blob
// detail, bounded so huge SAM polygons don't explode the mesh.
const LOFT_MIN_RING_SIZE = 24;
const LOFT_MAX_RING_SIZE = 128;

// Lofts a chain of stacked polygons into one continuous closed surface:
// each contour is resampled to a shared ring size and aligned with the ring
// below it, consecutive rings are stitched with triangle bands, and skirt
// rings extend the first/last contours by half a slice so the surface spans
// the full slice thicknesses. Caps close the two ends.
function addLoftedChain(
  chain: IPrismEntry[],
  halfSliceThickness: number,
  world: IWorldTransform,
  mesh: ISurfaceMesh,
) {
  const ringSize = Math.min(
    LOFT_MAX_RING_SIZE,
    Math.max(LOFT_MIN_RING_SIZE, ...chain.map((entry) => entry.polygon.length)),
  );
  const rings: IPlanarPoint[][] = [];
  for (const entry of chain) {
    let ring = resampleClosedContour(entry.polygon, ringSize);
    if (rings.length > 0) {
      ring = alignRingToReference(ring, rings[rings.length - 1]);
    }
    rings.push(ring);
  }

  const pushRing = (ring: IPlanarPoint[], z: number) => {
    const baseIndex = mesh.points.length / 3;
    for (const point of ring) {
      mesh.points.push(world.toX(point.x), world.toY(point.y), z);
    }
    return baseIndex;
  };

  const lastIndex = chain.length - 1;
  const ringBases = [
    pushRing(rings[0], world.zCenter(chain[0].depthIndex) - halfSliceThickness),
    ...chain.map((entry, index) =>
      pushRing(rings[index], world.zCenter(entry.depthIndex)),
    ),
    pushRing(
      rings[lastIndex],
      world.zCenter(chain[lastIndex].depthIndex) + halfSliceThickness,
    ),
  ];

  for (let bandIndex = 0; bandIndex < ringBases.length - 1; bandIndex += 1) {
    const lowerBase = ringBases[bandIndex];
    const upperBase = ringBases[bandIndex + 1];
    // The bottom skirt band follows the first annotation's scalar, every
    // other band the annotation at its top ring.
    const scalar = chain[Math.min(bandIndex, lastIndex)].scalar;
    for (let index = 0; index < ringSize; index += 1) {
      const next = (index + 1) % ringSize;
      mesh.triangles.push(
        3,
        lowerBase + index,
        lowerBase + next,
        upperBase + next,
      );
      mesh.cellScalars.push(scalar);
      mesh.triangles.push(
        3,
        lowerBase + index,
        upperBase + next,
        upperBase + index,
      );
      mesh.cellScalars.push(scalar);
    }
  }

  const addCap = (ring: IPlanarPoint[], baseIndex: number, scalar: number) => {
    const flat: number[] = [];
    for (const point of ring) {
      flat.push(point.x, point.y);
    }
    const capIndices = earcut(flat);
    for (let index = 0; index < capIndices.length; index += 3) {
      mesh.triangles.push(
        3,
        baseIndex + capIndices[index],
        baseIndex + capIndices[index + 1],
        baseIndex + capIndices[index + 2],
      );
      mesh.cellScalars.push(scalar);
    }
  };
  addCap(rings[0], ringBases[0], chain[0].scalar);
  addCap(
    rings[lastIndex],
    ringBases[ringBases.length - 1],
    chain[lastIndex].scalar,
  );
}

type TSegmentationKind = "prism" | "ribbon" | "sphere";

interface ISegmentationItem {
  annotation: IAnnotation;
  kind: TSegmentationKind;
  // Source-pixel coordinates: polygon vertices (prism), polyline vertices
  // (ribbon), or a single center (sphere).
  planarPoints: IPlanarPoint[];
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

export async function annotationsTo3D(
  options: IAnnotationsTo3DOptions,
): Promise<IAnnotationsTo3DResult> {
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
  const prismEntries: IPrismEntry[] = [];
  let usedAnnotationCount = 0;
  let minScalar = Number.POSITIVE_INFINITY;
  let maxScalar = Number.NEGATIVE_INFINITY;

  // When the volume depth was subsampled, original depth index d maps to the
  // (possibly fractional) voxel position d / depthStride, keeping the
  // annotation at its true physical depth. All extrusions span one original
  // slice (half of it on each side of the slice center).
  const depthStride = options.geometry.depthStride ?? 1;
  const halfSliceThickness = options.geometry.spacing[2] / depthStride / 2;
  items.forEach((item, index) => {
    const originalDepth =
      axis === "z" ? item.annotation.location.Z : item.annotation.location.Time;
    const depthIndex = originalDepth / depthStride;
    if (depthIndex < 0 || depthIndex >= options.geometry.dimensions[2]) {
      skippedByShape.outOfBoundsDepth =
        (skippedByShape.outOfBoundsDepth ?? 0) + 1;
      return;
    }

    const tag = item.annotation.tags[0] ?? "untagged";
    let scalar = 0;
    if (canUsePropertyScalars) {
      scalar = propertyScalars[index] ?? 0;
    } else if (!neutralPropertyScalars) {
      if (!tagToScalar.has(tag)) {
        tagToScalar.set(tag, tagToScalar.size);
      }
      scalar = tagToScalar.get(tag) ?? 0;
    }
    minScalar = Math.min(minScalar, scalar);
    maxScalar = Math.max(maxScalar, scalar);

    switch (item.kind) {
      case "prism":
        // Queued rather than emitted: prisms may be lofted together below.
        prismEntries.push({
          polygon: item.planarPoints,
          originalDepth,
          depthIndex,
          scalar,
          tag,
        });
        break;
      case "ribbon":
        addRibbon(
          item.planarPoints,
          depthIndex,
          scalar,
          halfSliceThickness,
          world,
          surfaceMesh,
        );
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

  // Chain matching is the expensive part (pairwise polygon intersections);
  // it runs in a web worker where available (see loftChainsWorkerClient.ts).
  const chains = options.loftSurfaces
    ? (
        await computeLoftChains(
          prismEntries.map((entry) => ({
            polygon: entry.polygon,
            depth: entry.originalDepth,
            group: entry.tag,
          })),
          options.loftOverlapFraction ?? 0,
        )
      ).map((indices) => indices.map((index) => prismEntries[index]))
    : prismEntries.map((entry) => [entry]);
  for (const chain of chains) {
    if (chain.length === 1) {
      addPrism(
        chain[0].polygon,
        chain[0].depthIndex,
        chain[0].scalar,
        halfSliceThickness,
        world,
        surfaceMesh,
      );
    } else {
      addLoftedChain(chain, halfSliceThickness, world, surfaceMesh);
    }
  }

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
