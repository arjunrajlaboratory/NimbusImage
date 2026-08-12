# API Endpoints Reference

Complete curl examples for each plugin endpoint. All examples assume `$TOKEN` is set (see SKILL.md Authentication section).

## upenn_annotation

```bash
# List annotations for a dataset
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/upenn_annotation?datasetId=$DATASET_ID"

# Get annotation by ID
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/upenn_annotation/$ANNOTATION_ID"

# Create a single annotation
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "tags": ["test"],
    "shape": "point",
    "channel": 0,
    "location": {"Time": 0, "Z": 0, "XY": 0},
    "coordinates": [{"x": 100, "y": 200, "z": 0}],
    "datasetId": "DATASET_ID"
  }' "http://localhost:8080/api/v1/upenn_annotation"

# Create multiple annotations (batch)
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '[
    {"tags": ["test"], "shape": "point", "channel": 0, "location": {"Time": 0, "Z": 0, "XY": 0}, "coordinates": [{"x": 100, "y": 200, "z": 0}], "datasetId": "DATASET_ID"},
    {"tags": ["test"], "shape": "point", "channel": 0, "location": {"Time": 0, "Z": 0, "XY": 0}, "coordinates": [{"x": 150, "y": 250, "z": 0}], "datasetId": "DATASET_ID"}
  ]' "http://localhost:8080/api/v1/upenn_annotation/multiple"

# Delete a single annotation
curl -s -X DELETE -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/upenn_annotation/$ANNOTATION_ID"

# Delete multiple annotations (batch)
curl -s -X DELETE -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"ids": ["ID1", "ID2", "ID3"]}' \
  "http://localhost:8080/api/v1/upenn_annotation/multiple"
```

## annotation_connection

```bash
# List connections for a dataset
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/annotation_connection?datasetId=$DATASET_ID"

# Create a connection between two annotations
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "parentId": "PARENT_ANNOTATION_ID",
    "childId": "CHILD_ANNOTATION_ID",
    "datasetId": "DATASET_ID",
    "tags": ["connection-tag"]
  }' "http://localhost:8080/api/v1/annotation_connection"

# Connect to nearest annotation
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "childId": "CHILD_ANNOTATION_ID",
    "datasetId": "DATASET_ID",
    "tags": ["parent-tag"],
    "connectionTags": ["connection-tag"]
  }' "http://localhost:8080/api/v1/annotation_connection/connect_to_nearest"

# Create multiple connections (batch)
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '[
    {"parentId": "P1", "childId": "C1", "datasetId": "DATASET_ID", "tags": ["tag"]},
    {"parentId": "P2", "childId": "C2", "datasetId": "DATASET_ID", "tags": ["tag"]}
  ]' "http://localhost:8080/api/v1/annotation_connection/multiple"

# Delete a connection
curl -s -X DELETE -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/annotation_connection/$CONNECTION_ID"

# Delete multiple connections (batch)
curl -s -X DELETE -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"ids": ["ID1", "ID2"]}' \
  "http://localhost:8080/api/v1/annotation_connection/multiple"
```

## upenn_collection (Configurations)

```bash
# List collections/configs for a dataset
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/upenn_collection?datasetId=$DATASET_ID"

# Get collection by ID
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/upenn_collection/$COLLECTION_ID"

# Find collections by folder IDs
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"folderIds": ["FOLDER_ID_1", "FOLDER_ID_2"]}' \
  "http://localhost:8080/api/v1/upenn_collection/findByFolders"

# Create a collection
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "Test Config",
    "datasetId": "DATASET_ID",
    "meta": {}
  }' "http://localhost:8080/api/v1/upenn_collection"

# Update collection metadata
curl -s -X PUT -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"meta": {"key": "value"}}' \
  "http://localhost:8080/api/v1/upenn_collection/$COLLECTION_ID/metadata"
```

## dataset (multi-source configuration)

Turns a folder of uploaded image files into a configured dataset — the REST
equivalent of the frontend's MultiSourceConfiguration screen. The folder must
already be a dataset (`meta.subtype == "contrastDataset"`) with the image
items uploaded into it.

```bash
# Discover what the configuration would be, writing nothing.
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"dryRun": true}' \
  "http://localhost:8080/api/v1/dataset/$DATASET_ID/multi_source"

# Configure for real (transcode defaults to true unless every file is .nd2)
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"transcode": false}' \
  "http://localhost:8080/api/v1/dataset/$DATASET_ID/multi_source"
```

Body fields (all optional): `assignments`, `transcode`, `splitRGBBands`
(default `true`), `enableCompositing` (default `false`), `createView`
(default `true`), `dryRun`.

`createView` also builds the collection and dataset view the web UI needs,
with the same default layers the UI would create. Leave it on unless you are
creating your own — without a view the dataset cannot be opened in the
browser and does not appear in listings that enumerate views.

**Start with `dryRun`.** It returns the computed `config`, `variables`,
`assignments`, `dimensionLabels`, plus `validationError` — `null` when the
configuration is valid, otherwise the same message the UI would show. A real
run turns that message into a 400, so the dry run is the only way to see the
`variables` list you need in order to fix it.

The common failure is `"Not all variables are assigned"`: filenames and file
metadata together produced more variables than the four dimensions' defaults
fill. Read `variables` from the dry run and assign the leftover one:

```bash
# dryRun said: Filename variable 1 (source=filename, guess=C, size=2) unassigned
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"assignments": {"XY": {"source": "filename", "guess": "C"}},
       "transcode": false}' \
  "http://localhost:8080/api/v1/dataset/$DATASET_ID/multi_source"
```

Each `assignments` entry is `{"source", "guess"}` copied from a variable in the
dry run (or `null` to leave a dimension unassigned); omitted dimensions keep
their default. `source` is `filename`, `file`, or `images`.

Other 400s: `"Source images use different pixel types (…)"` (all sources must
share a `dtype`), an item with zero files, an item with more than one file, and
`"Filenames do not have a consistent number of parts…"` — e.g. `a.tif` in a
folder of `b_x_0.tif` / `b_x_1.tif`, where the token that distinguishes the
files is missing from one name. The web UI cannot configure such a folder
either (its parser throws), so this is a refusal rather than a divergence.
A second call on a configured folder returns 409.

On success the response has `itemId` (the new `multi-source2.json`), `jobId`
(the transcode job, or `null`), `collectionId` / `viewId` (or `null` with
`createView: false`), the config, and `compositing` — whether compositing was
actually applied, which needs a single source with ND2 frame metadata and
collapses XY to one position when it happens.

**`jobId` is yours to check.** The response returns once the transcode is
queued. If that job later fails, the dataset stays configured with a broken
image and re-running returns 409 (the configuration item exists) — recover by
deleting that item, or start from a new dataset. Caches are **not** warmed —
the frontend additionally calls `tile_frames`, `cache_maxmerge` and
`histogram` after configuring, so the first open is slower than via the UI.

## dataset_view

```bash
# List views for a dataset
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/dataset_view?datasetId=$DATASET_ID"

# Get view by ID
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/dataset_view/$VIEW_ID"

# Create a view
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "datasetId": "DATASET_ID",
    "configurationId": "CONFIG_ID"
  }' "http://localhost:8080/api/v1/dataset_view"

# Share a view with another user
curl -s -X PUT -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"userId": "USER_ID", "level": 0}' \
  "http://localhost:8080/api/v1/dataset_view/$VIEW_ID/access"

# Make a view public
curl -s -X PUT -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"public": true}' \
  "http://localhost:8080/api/v1/dataset_view/$VIEW_ID/set_public"
```

## annotation_property

```bash
# List property definitions for a dataset
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/annotation_property?datasetId=$DATASET_ID"

# Create a property definition
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "Area",
    "image": "properties/area:latest",
    "datasetId": "DATASET_ID",
    "tags": {"tags": ["cell"], "exclusive": false},
    "shape": "polygon",
    "independentVariables": []
  }' "http://localhost:8080/api/v1/annotation_property"

# Compute property for entire dataset
curl -s -X POST -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/annotation_property/$PROPERTY_ID/compute?datasetId=$DATASET_ID"
```

## annotation_property_values

```bash
# Get property values
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/annotation_property_values?propertyId=$PROPERTY_ID&datasetId=$DATASET_ID"

# Add multiple property values (batch)
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "values": [
      {"annotationId": "ANN_ID", "propertyId": "PROP_ID", "values": {"Area": 1234.5}}
    ]
  }' "http://localhost:8080/api/v1/annotation_property_values/multiple"

# Get histogram for a property
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/annotation_property_values/histogram?propertyId=$PROPERTY_ID&datasetId=$DATASET_ID"
```

## project

```bash
# List all projects
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/project"

# Get project by ID
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/project/$PROJECT_ID"

# Create a project
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Test Project", "description": "For testing"}' \
  "http://localhost:8080/api/v1/project"

# Add a dataset to a project
curl -s -X PUT -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/project/$PROJECT_ID/dataset/$DATASET_ID"

# Add a collection/config to a project
curl -s -X PUT -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/project/$PROJECT_ID/collection/$COLLECTION_ID"
```

## export

```bash
# Export annotations as JSON
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/export/json?datasetId=$DATASET_ID" -o annotations.json

# Export annotations as CSV
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/export/csv?datasetId=$DATASET_ID" -o annotations.csv
```

## Girder Built-in Endpoints

These are Girder-provided, not plugin endpoints, but commonly needed:

```bash
# Get current user
curl -s -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/user/me"

# List users
curl -s -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/user"

# Get folder (dataset) by ID
curl -s -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/folder/$FOLDER_ID"

# List child folders
curl -s -H "Girder-Token: $TOKEN" \
  "http://localhost:8080/api/v1/folder?parentType=folder&parentId=$PARENT_ID"

# Get folder metadata
curl -s -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/folder/$FOLDER_ID"
# (metadata is in the .meta field of the response)

# Create a new user
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "login": "testuser",
    "email": "test@example.com",
    "firstName": "Test",
    "lastName": "User",
    "password": "testpass123"
  }' "http://localhost:8080/api/v1/user"
```
