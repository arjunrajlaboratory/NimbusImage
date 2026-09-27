# Annotation import and export

Everything lives in the data import/export menu (`src/components/DataIOMenu.vue`):

| Entry | Direction | Where it runs | Code |
|---|---|---|---|
| Import from JSON | in | server (`POST annotation_import`); properties are created client-side | `AnnotationImport.vue`, `utils/annotationImport.ts` |
| Import GeoJSON… | in | parsed in the browser, created through `POST upenn_annotation/multiple` | `GeoJsonImportDialog.vue`, `utils/geojson.ts`, `utils/annotationImport.ts` |
| Export to JSON | out | server (`GET export/json`) | `AnnotationExport.vue`, `store/ExportAPI.ts` |
| Export CSV | out | server (`POST export/csv`); client-side preview below 1,000 rows | `AnnotationCSVDialog.vue`, `store/ExportAPI.ts` |
| Export GeoJSON | out | server (`POST export/geojson`) | `DataIOMenu.vue`, `store/ExportAPI.ts`, `server/api/export.py` |

Every export runs on the server. In stub mode the client holds only a fraction of a large dataset's annotations (ANNOTATION-STUBS.md), so a client-side export would silently drop the rest.

## GeoJSON

This is for bringing pathology region layers in (QuPath exports, 10x's `*_annotation.geojson`) and sending annotations out to QuPath and other GIS-style tools.

**Coordinates** are this image's pixels, origin at the top-left, y pointing down. That is QuPath's convention. Neither direction reprojects anything. A file in microns shows up in the import preview's out-of-bounds warning, because at least one of its coordinates falls outside `[0, width] x [0, height]`.

### Import (client-side parse)

`parseGeoJson` in `src/utils/geojson.ts` is a pure function. It accepts a FeatureCollection, a single Feature, or a bare Geometry.

| GeoJSON | Annotations |
|---|---|
| Polygon | 1 polygon: outer ring only, closing duplicate vertex dropped. Holes are skipped and counted. |
| MultiPolygon | 1 polygon per part (holes skipped) |
| LineString | 1 line |
| MultiLineString | 1 line per part |
| Point | 1 point |
| MultiPoint | 1 point per position |
| anything else, a missing geometry, malformed or too few coordinates | none; counted in `skipped` by reason |

- **z is dropped.** Third coordinates are ignored, because the annotation's z-slice comes from its location.
- **Tags** are `properties.tags` (NimbusImage's own export), then the class name, then the dialog's extra tag (default `region`), deduplicated. The class name is `properties.classification.name`. If that is missing, QuPath's `classification.names` joined with `": "` is used, then `properties.name`.
- **Location and channel.** Annotations go at the current XY/Z/time. The channel is the chosen layer's (default: the first layer).
- **Cap.** `MAX_GEOJSON_IMPORT_ANNOTATIONS` (100K) annotations. The parser throws before walking a collection with more features than that, and again if multi-part geometries push the output past it.
- **Creation.** `importGeoJsonAnnotations` sends batches bounded by both annotation count (5,000) and vertex count (250K), so detailed polygons cannot build one huge body.
  - It is all or nothing. If a batch fails, everything already created is removed in one batch delete, and then the error is shown in the dialog.
  - Afterwards it calls `annotationStore.fetchAnnotations()`, as the JSON import does.
  - Each batch is its own undo step.

### Export (server-side)

`POST export/geojson` takes the body `{datasetId, annotationIds?, filename?}` and streams a FeatureCollection with orjson (`streamJsonArray` in `server/helpers/serialization.py`).

- **`annotationIds` has three states.** Absent means all annotations. A list means exactly those. An empty list means none, and returns an empty collection without a query.
- **Checks.** READ access on the dataset. Every id is converted at the boundary, so a bad id is a 400, never a failure mid-stream. The id count is capped by `MAX_ANNOTATION_IDS` (`validateAnnotationIdCount`), as in the CSV export.
- **Features.** `annotationToGeoJsonFeature` builds each one:
  - Geometry: polygon and rectangle become Polygon (ring closed), line becomes LineString, point becomes Point. Coordinates are `[x, y]`.
  - `id` is the annotation id.
  - `properties` is `{objectType: "annotation", name, tags, classification: {name: <first tag>}}`. `classification` is present only when the annotation has tags.
  - An annotation with too few vertices for a valid geometry is left out.
- **Menu scope.** The menu entry mirrors Export CSV's scopes (`geoJsonExportAnnotationIds`): the selection if there is one, else the active filter's set, else everything (the field is omitted). The file downloads as `<dataset>-annotations.geojson`.

**Round trip:** after export and re-import, polygons, lines, points, and tags all come back the same, because `properties.tags` carries every tag. The losses are:
- a rectangle comes back as a polygon;
- `name` is not re-imported;
- the location and channel are whatever the importer picks.

## Regression checklist

Each line names the tests that hold it (frontend: `src/utils/geojson.test.ts` unless noted; backend: `test/test_export.py` `TestGeoJsonExport`).

**GeoJSON import**
- Polygon uses the outer ring only, the closing vertex is dropped, and holes are counted: *"Polygon keeps the outer ring and drops the closing vertex"*, *"Polygon holes are skipped and counted"*.
- Multi-part geometries yield one annotation per part: *"MultiPolygon yields one polygon per part and counts their holes"*, *"MultiLineString yields one line per part"*, *"Point becomes a point; MultiPoint one point per position"*.
- 3-D coordinates lose z: *"drops z from 3-D coordinates"*.
- Unsupported, missing, and malformed geometries are counted, never thrown: *"counts unsupported, missing and malformed geometries as skipped"*.
- Class-name fallbacks and tag dedup: *"falls back to classification.names, then properties.name"*, *"keeps properties.tags and adds the class name once"*.
- Invalid input gets a clear message: *"reports a JSON syntax error"*, *"rejects %j"*.
- The 100K cap applies to both features and output annotations: *"caps the feature count before walking the collection"*, *"caps annotations produced by multi-part geometries"*.
- Batches are bounded by count and vertices: *"bounds batches by vertex count, never leaving a batch empty"*.
- A failed batch rolls back the earlier ones (`src/utils/annotationImport.test.ts`): *"rolls back the created batches when a later batch fails"*.
- The import applies the current location, the chosen layer's channel, and the extra tag (`GeoJsonImportDialog.test.ts`): *"imports at the current location with the chosen layer's channel"*.
- The dialog stays open on failure: *"keeps the dialog open with the error when the import fails"*.
- The preview flags out-of-bounds coordinates: *"previews shapes, classes, skips, holes and out-of-bounds"*.

**GeoJSON export**
- Rings are closed exactly once and shapes map to geometry types: *"testPolygonRingIsClosed"*, *"testAlreadyClosedRingIsNotClosedTwice"*, *"testShapesMapToGeometryTypes"*.
- `classification` appears only when the annotation is tagged, and degenerate annotations are skipped: *"testClassificationOnlyWhenTagged"*, *"testDegenerateAnnotationsAreSkipped"*.
- `annotationIds` keeps its three states end to end: *"testEndpointPreservesExactAnnotationSubset"*, *"omits annotationIds for everything, keeps an empty subset"* (`ExportAPI.test.ts`), *"exports the filtered subset, including an empty one"*, *"a selection wins over the filter"*.
- Malformed input is a 400, the id count is capped, and READ access is required: *"testEndpointRejectsMalformedInput"*, *"testEndpointCapsAnnotationIdCount"*, *"testEndpointRequiresReadAccess"*.
- The endpoint streams exactly `annotationToGeoJsonFeature` of each stored annotation: *"testEndpointStreamsFeatureCollection"*.

**Round trip**
- Export then import yields the same shapes, coordinates, and tags:
  - *"testFeaturesMatchRoundTripFixture"* pins the export of `test/fixtures/geojson_round_trip.json`.
  - *"re-imports the exported annotations with the same shapes and tags"* parses the same fixture back.
- Python is the reference for the export half. To change the format, regenerate with `UPDATE_GEOJSON_FIXTURE=1` on the pytest run; the TS test must then still pass.
