import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AnnotationShape, IAnnotationBase } from "@/store/model";
import {
  GeoJsonParseError,
  batchAnnotationBases,
  geoJsonClassName,
  geoJsonExportAnnotationIds,
  parseGeoJson,
  parseGeoJsonText,
  summarizeGeoJsonImport,
  toAnnotationBases,
} from "@/utils/geojson";

function feature(geometry: unknown, properties: unknown = {}) {
  return { type: "Feature", geometry, properties };
}

function collection(...features: unknown[]) {
  return { type: "FeatureCollection", features };
}

const square = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];
const squareVertices = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe("parseGeoJson input forms", () => {
  it("accepts a FeatureCollection", () => {
    const result = parseGeoJson(
      collection(
        feature({ type: "Point", coordinates: [1, 2] }),
        feature({ type: "Point", coordinates: [3, 4] }),
      ),
    );
    expect(result.featureCount).toBe(2);
    expect(result.annotations.map((a) => a.coordinates)).toEqual([
      [{ x: 1, y: 2 }],
      [{ x: 3, y: 4 }],
    ]);
  });

  it("accepts a single Feature", () => {
    const result = parseGeoJson(
      feature({ type: "Point", coordinates: [1, 2] }, { name: "A" }),
    );
    expect(result.featureCount).toBe(1);
    expect(result.annotations[0].tags).toEqual(["A"]);
  });

  it("accepts a bare Geometry", () => {
    const result = parseGeoJson({ type: "Polygon", coordinates: [square] });
    expect(result.annotations).toEqual([
      {
        shape: AnnotationShape.Polygon,
        coordinates: squareVertices,
        tags: [],
        className: null,
      },
    ]);
  });
});

describe("parseGeoJson geometry types", () => {
  it("Polygon keeps the outer ring and drops the closing vertex", () => {
    const [annotation] = parseGeoJson(
      feature({ type: "Polygon", coordinates: [square] }),
    ).annotations;
    expect(annotation.shape).toBe(AnnotationShape.Polygon);
    expect(annotation.coordinates).toEqual(squareVertices);
  });

  it("Polygon with an already-open ring keeps every vertex", () => {
    const [annotation] = parseGeoJson(
      feature({ type: "Polygon", coordinates: [square.slice(0, 4)] }),
    ).annotations;
    expect(annotation.coordinates).toEqual(squareVertices);
  });

  it("Polygon holes are skipped and counted", () => {
    const hole = [
      [2, 2],
      [4, 2],
      [4, 4],
      [2, 2],
    ];
    const result = parseGeoJson(
      feature({ type: "Polygon", coordinates: [square, hole, hole] }),
    );
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0].coordinates).toEqual(squareVertices);
    expect(result.holesSkipped).toBe(2);
  });

  it("MultiPolygon yields one polygon per part and counts their holes", () => {
    const hole = [
      [2, 2],
      [4, 2],
      [4, 4],
      [2, 2],
    ];
    const shifted = square.map(([x, y]) => [x + 100, y]);
    const result = parseGeoJson(
      feature(
        { type: "MultiPolygon", coordinates: [[square, hole], [shifted]] },
        { classification: { name: "Tumor" } },
      ),
    );
    expect(result.annotations).toHaveLength(2);
    expect(result.annotations[1].coordinates[0]).toEqual({ x: 100, y: 0 });
    expect(result.annotations.every((a) => a.tags[0] === "Tumor")).toBe(true);
    expect(result.holesSkipped).toBe(1);
  });

  it("LineString becomes a line", () => {
    const [annotation] = parseGeoJson(
      feature({
        type: "LineString",
        coordinates: [
          [0, 0],
          [5, 5],
        ],
      }),
    ).annotations;
    expect(annotation.shape).toBe(AnnotationShape.Line);
    expect(annotation.coordinates).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ]);
  });

  it("MultiLineString yields one line per part", () => {
    const result = parseGeoJson(
      feature({
        type: "MultiLineString",
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
          [
            [2, 2],
            [3, 3],
            [4, 4],
          ],
        ],
      }),
    );
    expect(result.annotations.map((a) => a.shape)).toEqual([
      AnnotationShape.Line,
      AnnotationShape.Line,
    ]);
    expect(result.annotations[1].coordinates).toHaveLength(3);
  });

  it("Point becomes a point; MultiPoint one point per position", () => {
    const result = parseGeoJson(
      collection(
        feature({ type: "Point", coordinates: [1, 2] }),
        feature({
          type: "MultiPoint",
          coordinates: [
            [3, 4],
            [5, 6],
          ],
        }),
      ),
    );
    expect(result.annotations.map((a) => a.coordinates)).toEqual([
      [{ x: 1, y: 2 }],
      [{ x: 3, y: 4 }],
      [{ x: 5, y: 6 }],
    ]);
    expect(
      result.annotations.every((a) => a.shape === AnnotationShape.Point),
    ).toBe(true);
  });

  it("drops z from 3-D coordinates", () => {
    const result = parseGeoJson(
      collection(
        feature({ type: "Point", coordinates: [1, 2, 7] }),
        feature({
          type: "Polygon",
          coordinates: [
            [
              [0, 0, 1],
              [4, 0, 1],
              [4, 4, 1],
              [0, 0, 1],
            ],
          ],
        }),
      ),
    );
    expect(result.annotations[0].coordinates).toEqual([{ x: 1, y: 2 }]);
    expect(result.annotations[1].coordinates).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
    ]);
  });

  it("counts unsupported, missing and malformed geometries as skipped", () => {
    const result = parseGeoJson(
      collection(
        feature({ type: "GeometryCollection", geometries: [] }),
        feature(null),
        { type: "NotAFeature" },
        feature({ type: "Point", coordinates: ["a", 2] }),
        feature({ type: "LineString", coordinates: [[0, 0]] }),
        // Two distinct vertices plus the closing one: not a polygon.
        feature({
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        }),
        feature({ type: "MultiPolygon", coordinates: [] }),
        feature({ type: "Point", coordinates: [1, 1] }),
      ),
    );
    expect(result.featureCount).toBe(8);
    expect(result.annotations).toHaveLength(1);
    expect(result.skipped).toEqual({
      GeometryCollection: 1,
      "no geometry": 2,
      "invalid Point": 1,
      "invalid LineString": 1,
      "invalid Polygon": 1,
      "invalid MultiPolygon": 1,
    });
  });
});

describe("parseGeoJson tags", () => {
  it("prefers properties.classification.name", () => {
    expect(
      geoJsonClassName({ classification: { name: "Tumor" }, name: "t1" }),
    ).toBe("Tumor");
  });

  it("falls back to classification.names, then properties.name", () => {
    expect(
      geoJsonClassName({ classification: { names: ["Tumor", "Positive"] } }),
    ).toBe("Tumor: Positive");
    expect(
      geoJsonClassName({ classification: { name: " " }, name: "t1" }),
    ).toBe("t1");
    expect(geoJsonClassName({ name: "Region 3" })).toBe("Region 3");
  });

  it("returns null without a usable name", () => {
    expect(geoJsonClassName(null)).toBeNull();
    expect(geoJsonClassName({})).toBeNull();
    expect(geoJsonClassName({ name: 5, classification: "x" })).toBeNull();
  });

  it("keeps properties.tags and adds the class name once", () => {
    const [annotation] = parseGeoJson(
      feature(
        { type: "Point", coordinates: [0, 0] },
        { tags: ["Tumor", "region", 4], classification: { name: "Tumor" } },
      ),
    ).annotations;
    expect(annotation.tags).toEqual(["Tumor", "region"]);
    expect(annotation.className).toBe("Tumor");
  });
});

describe("parseGeoJson invalid input", () => {
  it.each([
    [null, /Not a GeoJSON object/],
    [[1, 2], /Not a GeoJSON object/],
    ["text", /Not a GeoJSON object/],
    [{}, /has no type/],
    [{ type: "Topology" }, /Unsupported GeoJSON type "Topology"/],
    [{ type: "FeatureCollection" }, /no features array/],
    [{ type: "FeatureCollection", features: {} }, /no features array/],
  ])("rejects %j", (input, message) => {
    expect(() => parseGeoJson(input)).toThrow(GeoJsonParseError);
    expect(() => parseGeoJson(input)).toThrow(message);
  });

  it("reports a JSON syntax error", () => {
    expect(() => parseGeoJsonText("{nope")).toThrow(/not valid JSON/);
  });

  it("caps the feature count before walking the collection", () => {
    const point = feature({ type: "Point", coordinates: [0, 0] });
    expect(() =>
      parseGeoJson(collection(point, point, point), { maxAnnotations: 2 }),
    ).toThrow(/more than 2 annotations/);
  });

  it("caps annotations produced by multi-part geometries", () => {
    const multi = feature({
      type: "MultiPoint",
      coordinates: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
    });
    expect(() => parseGeoJson(multi, { maxAnnotations: 2 })).toThrow(
      /more than 2 annotations/,
    );
    expect(parseGeoJson(multi, { maxAnnotations: 3 }).annotations).toHaveLength(
      3,
    );
  });
});

describe("summarizeGeoJsonImport", () => {
  it("counts per shape and class, and out-of-bounds annotations", () => {
    const { annotations } = parseGeoJson(
      collection(
        feature(
          { type: "Polygon", coordinates: [square] },
          { classification: { name: "Tumor" } },
        ),
        feature(
          { type: "Point", coordinates: [11, 5] },
          { classification: { name: "Tumor" } },
        ),
        feature({ type: "Point", coordinates: [-1, 5] }),
      ),
    );
    expect(
      summarizeGeoJsonImport(annotations, { width: 10, height: 10 }),
    ).toEqual({
      byShape: { polygon: 1, point: 2 },
      byClass: { Tumor: 2, "": 1 },
      outOfBounds: 2,
    });
    expect(summarizeGeoJsonImport(annotations, null).outOfBounds).toBe(0);
  });
});

describe("toAnnotationBases", () => {
  const target = {
    datasetId: "ds1",
    location: { XY: 1, Z: 2, Time: 3 },
    channel: 4,
  };

  it("fills in location, channel and dataset, and appends the extra tag", () => {
    const { annotations } = parseGeoJson(
      feature(
        { type: "Point", coordinates: [1, 2] },
        { classification: { name: "Tumor" } },
      ),
    );
    expect(
      toAnnotationBases(annotations, { ...target, extraTag: " region " }),
    ).toEqual([
      {
        tags: ["Tumor", "region"],
        shape: AnnotationShape.Point,
        channel: 4,
        location: { XY: 1, Z: 2, Time: 3 },
        coordinates: [{ x: 1, y: 2 }],
        datasetId: "ds1",
        color: null,
      },
    ]);
  });

  it("adds no blank or duplicate extra tag", () => {
    const { annotations } = parseGeoJson(
      feature({ type: "Point", coordinates: [1, 2] }, { name: "region" }),
    );
    expect(toAnnotationBases(annotations, target)[0].tags).toEqual(["region"]);
    expect(
      toAnnotationBases(annotations, { ...target, extraTag: "region" })[0].tags,
    ).toEqual(["region"]);
    expect(
      toAnnotationBases(annotations, { ...target, extraTag: "  " })[0].tags,
    ).toEqual(["region"]);
  });
});

describe("batchAnnotationBases", () => {
  function base(vertices: number): IAnnotationBase {
    return {
      tags: [],
      shape: AnnotationShape.Polygon,
      channel: 0,
      location: { XY: 0, Z: 0, Time: 0 },
      coordinates: Array.from({ length: vertices }, (_, x) => ({ x, y: 0 })),
      datasetId: "ds1",
      color: null,
    };
  }

  it("bounds batches by annotation count", () => {
    const batches = batchAnnotationBases(
      Array.from({ length: 5 }, () => base(3)),
      { maxAnnotations: 2 },
    );
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  it("bounds batches by vertex count, never leaving a batch empty", () => {
    const batches = batchAnnotationBases(
      [base(4), base(4), base(10), base(1)],
      {
        maxVertices: 8,
      },
    );
    expect(batches.map((batch) => batch.length)).toEqual([2, 1, 1]);
  });

  it("returns no batches for no annotations", () => {
    expect(batchAnnotationBases([])).toEqual([]);
  });
});

describe("geoJsonExportAnnotationIds", () => {
  const stubs = ["a", "b", "c"].map((id) => ({ id })) as any[];

  it("exports everything without a filter or selection", () => {
    expect(
      geoJsonExportAnnotationIds({
        selectedIds: [],
        filteredAnnotations: stubs,
        annotationCount: 3,
      }),
    ).toBeUndefined();
  });

  it("exports the filtered subset, including an empty one", () => {
    expect(
      geoJsonExportAnnotationIds({
        selectedIds: [],
        filteredAnnotations: stubs.slice(0, 2),
        annotationCount: 3,
      }),
    ).toEqual(["a", "b"]);
    expect(
      geoJsonExportAnnotationIds({
        selectedIds: [],
        filteredAnnotations: [],
        annotationCount: 3,
      }),
    ).toEqual([]);
  });

  it("a selection wins over the filter", () => {
    expect(
      geoJsonExportAnnotationIds({
        selectedIds: ["c"],
        filteredAnnotations: stubs.slice(0, 2),
        annotationCount: 3,
      }),
    ).toEqual(["c"]);
  });

  it("selecting everything exports everything", () => {
    expect(
      geoJsonExportAnnotationIds({
        selectedIds: ["a", "b", "c"],
        filteredAnnotations: stubs,
        annotationCount: 3,
      }),
    ).toBeUndefined();
  });
});

// Export -> import round trip. The fixture's featureCollection is what the
// server export writes for its annotations (pinned by test_export.py
// TestGeoJsonExport.testFeaturesMatchRoundTripFixture); parsing it back must
// give the same geometry and tags. Rectangles come back as polygons, and an
// annotation too degenerate to export has no feature.
describe("GeoJSON export/import round trip", () => {
  const fixture = JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        "../../devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/fixtures/geojson_round_trip.json",
      ),
      "utf8",
    ),
  );

  it("re-imports the exported annotations with the same shapes and tags", () => {
    const exported = fixture.annotations.filter(
      (annotation: any) => annotation.tags[0] !== "Degenerate",
    );
    const result = parseGeoJson(fixture.featureCollection);
    expect(result.skipped).toEqual({});
    expect(result.holesSkipped).toBe(0);
    expect(
      result.annotations.map(({ shape, coordinates, tags }) => ({
        shape,
        coordinates,
        tags,
      })),
    ).toEqual(
      exported.map((annotation: any) => ({
        shape: annotation.shape,
        coordinates: annotation.coordinates.map(({ x, y }: any) => ({ x, y })),
        tags: annotation.tags,
      })),
    );
  });
});
