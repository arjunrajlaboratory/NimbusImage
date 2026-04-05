# NimbusImage Server REST API Endpoints

**Source**: `UPennContrast/devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/`

All endpoints are served under `/api/v1/` by the Girder server. The `annotation_client` Python package wraps a subset of these — many endpoints (projects, export, history, sharing, bulk operations) have **no Python client wrapper** yet.

## Endpoint Coverage: What's Wrapped vs What's Not

| API Group | Endpoints | Python Client Coverage |
|-----------|-----------|----------------------|
| Annotations (`/upenn_annotation`) | 10 | Mostly covered in `UPennContrastAnnotationClient` |
| Connections (`/annotation_connection`) | 9 | Mostly covered |
| Properties (`/annotation_property`) | 7 | Partially covered (`create`, `getById`) |
| Property Values (`/annotation_property_values`) | 6 | Mostly covered |
| Collections (`/upenn_collection`) | 7 | **Not wrapped** |
| Dataset Views (`/dataset_view`) | 11 | Partially covered (find, create) |
| Projects (`/project`) | 14 | **Not wrapped** |
| Export (`/export`) | 2 | **Not wrapped** |
| History (`/history`) | 3 | **Not wrapped** |
| Worker Interfaces (`/worker_interface`) | 4 | Wrapped in `UPennContrastWorkerPreviewClient` |
| Worker Previews (`/worker_preview`) | 4 | Wrapped in `UPennContrastWorkerPreviewClient` |
| User Colors (`/user_colors`) | 2 | **Not wrapped** |
| User Assetstore (`/user_assetstore`) | 2 | **Not wrapped** |
| Resource Batch (`/resource`) | 1 | **Not wrapped** |

---

## 1. Annotations (`/upenn_annotation`)

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/upenn_annotation` | Create single annotation |
| `POST` | `/upenn_annotation/multiple` | Create multiple annotations |
| `GET` | `/upenn_annotation` | Find annotations (`?datasetId=`, `&shape=`, `&tags=`, `&limit=`, `&offset=`, `&afterId=`) |
| `GET` | `/upenn_annotation/{id}` | Get annotation by ID |
| `GET` | `/upenn_annotation/count` | Count annotations (`?datasetId=`, `&shape=`, `&tags=`) |
| `PUT` | `/upenn_annotation/{id}` | Update single annotation |
| `PUT` | `/upenn_annotation/multiple` | Update multiple annotations |
| `DELETE` | `/upenn_annotation/{id}` | Delete single annotation |
| `DELETE` | `/upenn_annotation/multiple` | Delete multiple annotations (body: array of IDs) |
| `POST` | `/upenn_annotation/compute` | Trigger worker computation (`?datasetId=`, body: tool config) |

**Note**: The `tags` query parameter accepts a JSON-encoded array. The `count` endpoint returns `{"count": N}`.

## 2. Connections (`/annotation_connection`)

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/annotation_connection` | Create connection |
| `POST` | `/annotation_connection/multiple` | Create multiple connections |
| `GET` | `/annotation_connection` | Find connections (`?datasetId=`, `&parentId=`, `&childId=`, `&nodeAnnotationId=`) |
| `GET` | `/annotation_connection/{id}` | Get connection by ID |
| `GET` | `/annotation_connection/count` | Count connections (`?datasetId=`) |
| `PUT` | `/annotation_connection/{id}` | Update connection |
| `DELETE` | `/annotation_connection/{id}` | Delete connection |
| `DELETE` | `/annotation_connection/multiple` | Delete multiple connections |
| `POST` | `/annotation_connection/connectToNearest` | Auto-connect annotations to nearest neighbors |

## 3. Properties (`/annotation_property`)

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/annotation_property` | List all properties (user has access to) |
| `GET` | `/annotation_property/{id}` | Get property by ID |
| `GET` | `/annotation_property/count` | Count properties (`?configurationId=`) |
| `POST` | `/annotation_property` | **Create a new property definition** |
| `PUT` | `/annotation_property/{id}` | Update property |
| `DELETE` | `/annotation_property/{id}` | Delete property |
| `POST` | `/annotation_property/{id}/compute` | Trigger property computation (`?datasetId=`) |

### Property creation body:
```json
{
    "image": "properties/blob_intensity:latest",
    "name": "Blob Intensity",
    "shape": "polygon",
    "tags": {"exclusive": false, "tags": ["nucleus"]},
    "workerInterface": {"Channel": 1}
}
```

## 4. Property Values (`/annotation_property_values`)

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/annotation_property_values` | Add values for one annotation (`?annotationId=&datasetId=`) |
| `POST` | `/annotation_property_values/multiple` | Add values for multiple annotations (body: array of entries) |
| `GET` | `/annotation_property_values` | Find values (`?datasetId=`, `&annotationId=`) |
| `GET` | `/annotation_property_values/count` | Count values (`?datasetId=`) |
| `GET` | `/annotation_property_values/histogram` | Get histogram (`?propertyPath=&datasetId=&buckets=`) |
| `DELETE` | `/annotation_property_values` | Delete all values for a property in a dataset (`?propertyId=&datasetId=`) |

### Multiple property values body:
```json
[
    {
        "datasetId": "...",
        "annotationId": "...",
        "values": {"propertyId": {"MeanIntensity": 42.5, "MaxIntensity": 100.0}}
    }
]
```

## 5. Collections / Configurations (`/upenn_collection`)

**Not currently wrapped in any Python client.**

Collections in NimbusImage represent **configurations** — saved views with layer settings, property selections, etc.

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/upenn_collection` | Create collection (`?folderId=&name=&reuseExisting=`, form: `metadata`) |
| `GET` | `/upenn_collection` | Find collections (`?folderId=`) |
| `GET` | `/upenn_collection/{id}` | Get collection by ID |
| `POST` | `/upenn_collection/by_folders` | Bulk find by folder IDs (body: `{"folderIds": [...]}`) |
| `PUT` | `/upenn_collection/{id}` | Update name/description |
| `PUT` | `/upenn_collection/{id}/metadata` | Set metadata fields (null to delete) |
| `DELETE` | `/upenn_collection/{id}` | Delete collection |

## 6. Dataset Views (`/dataset_view`)

Dataset views link datasets to configurations. They control what the user sees when they open a dataset.

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/dataset_view` | Create/update dataset view |
| `GET` | `/dataset_view` | Find views (`?datasetId=`, `&configurationId=`) |
| `GET` | `/dataset_view/{id}` | Get view by ID |
| `POST` | `/dataset_view/bulk_find` | Bulk find (body: `{"datasetIds": [], "configurationIds": []}`) |
| `POST` | `/dataset_view/map` | Map dataset↔config IDs with optional names |
| `PUT` | `/dataset_view/{id}` | Update view |
| `DELETE` | `/dataset_view/{id}` | Delete view |
| `POST` | `/dataset_view/share` | Share views with user (`userMailOrUsername`, `accessType`: -1/0/1) |
| `POST` | `/dataset_view/set_public` | Set public status (`?datasetId=&public=`) |
| `GET` | `/dataset_view/access/{datasetId}` | Get access list for dataset |
| `GET` | `/dataset_view/configuration_access/{configurationId}` | Get access list for config |

## 7. Projects (`/project`)

**Not currently wrapped in any Python client.**

Projects group datasets and configurations for export/sharing.

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/project` | Create project (`?name=&description=`) |
| `GET` | `/project` | List projects (`?creatorId=&status=`) |
| `GET` | `/project/{id}` | Get project by ID |
| `PUT` | `/project/{id}` | Update name/description |
| `PUT` | `/project/{id}/metadata` | Update publication metadata |
| `PUT` | `/project/{id}/status` | Set status (draft/exporting/exported) |
| `POST` | `/project/{id}/dataset` | Add dataset to project |
| `DELETE` | `/project/{id}/dataset/{datasetId}` | Remove dataset from project |
| `POST` | `/project/{id}/collection` | Add collection/config to project |
| `DELETE` | `/project/{id}/collection/{collectionId}` | Remove collection from project |
| `POST` | `/project/{id}/share` | Share project with user |
| `POST` | `/project/{id}/set_public` | Make project public/private |
| `GET` | `/project/{id}/access` | Get project access list |
| `DELETE` | `/project/{id}` | Delete project |

## 8. Export (`/export`)

**Not currently wrapped in any Python client.**

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/export/json` | Export as JSON (`?datasetId=&configurationId=&includeAnnotations=&includeConnections=&includeProperties=&includePropertyValues=`) |
| `POST` | `/export/csv` | Export as CSV (body: `{datasetId, propertyPaths, annotationIds, delimiter, undefinedValue}`) |

### JSON export response structure:
```json
{
    "annotations": [...],
    "annotationConnections": [...],
    "annotationProperties": [...],
    "annotationPropertyValues": {"annotationId": {"propertyId": value}}
}
```

### CSV export body:
```json
{
    "datasetId": "...",
    "propertyPaths": [["propertyId", "subKey1"], ["propertyId2"]],
    "annotationIds": null,
    "undefinedValue": "",
    "delimiter": ",",
    "filename": "export.csv"
}
```

CSV columns: `Id, Channel, XY, Z, Time, Tags, Shape, Name, [property columns...]`
Note: XY/Z/Time are **1-indexed** in CSV export (different from 0-indexed in the API).

## 9. History / Undo-Redo (`/history`)

**Not currently wrapped in any Python client.**

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/history` | Get history entries (`?datasetId=`) |
| `PUT` | `/history/undo` | Undo last action (`?datasetId=`) |
| `PUT` | `/history/redo` | Redo last undone action (`?datasetId=`) |

## 10. Worker Interfaces (`/worker_interface`)

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/worker_interface` | Get interface for worker image (`?image=`) |
| `GET` | `/worker_interface/available` | List all available worker Docker images with labels |
| `POST` | `/worker_interface` | Save/update interface (`?image=`, body: interface JSON) |
| `POST` | `/worker_interface/request` | Request worker to refresh interface (`?image=`) |

## 11. Worker Previews (`/worker_preview`)

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/worker_preview` | Get cached preview (`?image=`) |
| `POST` | `/worker_preview` | Save preview (`?image=`, body: preview JSON) |
| `DELETE` | `/worker_preview` | Clear preview (`?image=`) |
| `POST` | `/worker_preview/request` | Request preview generation (`?image=&datasetId=`, body: params) |

## 12. User Colors (`/user_colors`)

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/user_colors` | Get color preferences |
| `PUT` | `/user_colors` | Save color preferences (body: `{"channelColors": {...}}`) |

## 13. User Assetstore (`/user_assetstore`)

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/user_assetstore` | List available assetstores |
| `PUT` | `/user_assetstore/{id}/move` | Move folder to assetstore (`?assetstoreId=`) |

## 14. Resource Batch (`/resource`)

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/resource/batch` | Bulk resolve resources (body: `{"folder": [ids], "item": [ids], ...}`) |

---

## Girder Core Endpoints Also Used

Beyond the NimbusImage plugin, workers also use these Girder core endpoints directly via `girder_client`:

| Endpoint | Used For |
|----------|---------|
| `GET /folder/{id}` | Get dataset folder metadata |
| `GET /item?folderId={id}&limit=0` | List items in a dataset folder |
| `GET /item/{id}/tiles` | Get tile metadata (large_image) |
| `GET /item/{id}/tiles/internal_metadata` | Get internal tile metadata |
| `GET /item/{id}/tiles/region` | Get image region as numpy array |
| `GET /item/{id}/tiles/fzxy/{frame}/0/0/0` | Get raw image for a frame |
| `PUT /item/{id}` | Update item metadata (with `metadata` param) |
| `POST /file` (via `uploadFileToFolder`) | Upload files to dataset folder |
| `POST /folder/{id}/list` (via `listFolder`) | List subfolders |

---

## Design Notes for `ni` Package

Many of these endpoints have no Python wrapper. The `ni` package should cover:

### Currently unwrapped, high-value for programmatic use:
- **Projects**: Create, manage, add/remove datasets, share, export
- **Export**: JSON and CSV export of entire datasets
- **Collections/Configurations**: Create/manage configurations, set layer settings
- **History**: Undo/redo support
- **Sharing**: Share datasets/projects with other users
- **Bulk operations**: `resource/batch`, `dataset_view/bulk_find`, `dataset_view/map`

### Example of what the `ni` package should enable:

```python
# Project management
project = client.create_project('My Analysis')
project.add_dataset(ds)
project.share('colleague@email.com', access='write')
project.set_public(True)

# Export
data = ds.export_json(include_properties=True)
ds.export_csv('output.csv', property_paths=[['blob_intensity', 'MeanIntensity']])

# Configuration management
config = ds.get_configuration()
config.layers  # layer settings
config.properties  # registered properties

# History
ds.undo()
ds.redo()
```
