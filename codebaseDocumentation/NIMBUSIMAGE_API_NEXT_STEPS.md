# NimbusImage Python API — Next Steps

## Context

The `nimbusimage` Python API package is implemented on branch `feature/nimbusimage-python-api` at `nimbusimage/` in the repo root. 217 unit tests passing. The package is functional and e2e tested against the live backend.

**Key docs to read first:**
- Design spec: `codebaseDocumentation/NIMBUSIMAGE_API.md`
- Testing guide: `nimbusimage/TESTING.md`
- Memory: auto-loaded `project_nimbusimage_api.md`

## Completed Tasks

### Task 1: Migrate dataclasses to Pydantic (DONE)

All 6 model classes migrated to Pydantic `BaseModel` with field aliases, `to_dict()`/`from_dict()` wrappers preserved. 198→217 tests.

### Task 2: Set up MkDocs with auto-generated API docs (DONE)

MkDocs Material + mkdocstrings[python] configured. GitHub Actions workflow deploys to Pages on push to master. 17 API reference pages + getting-started guide.

### Task 3: Merge ConfigAccessor into CollectionAccessor (DONE)

`ds.config` → `ds.collections`. `config.py` deleted. Methods renamed: `get_collection()` → `get()`, `list_collections()` → `list()`.

### Task 4: Worker discovery and execution (DONE)

- `client.list_workers()` — discover available Docker worker images
- `client.get_worker_interface(image)` — fetch parameter schema
- `ds.annotations.compute()` — run annotation worker, returns `Job`
- `ds.properties.compute()` — run property worker, returns `Job`
- `Job` class with `wait()`, `refresh()`, `status`, `log`

### Task 5: E2E testing (DONE)

All major features e2e tested against live backend:

| Feature | Result |
|---------|--------|
| Image retrieval (single, crop, all channels, z-stack) | PASS |
| get_composite (float64, uint8) | PASS |
| Annotation worker (random_squares) | PASS |
| Property worker (blob_metrics) | PASS |
| Export (JSON, filtered, CSV, CSV to file) | PASS |
| History (create → undo → redo) | PASS |
| Sharing (set_public toggle) | PASS |
| Connections (create, get, list, delete, bulk) | PASS |
| connect_to_nearest | PASS |
| Geometry methods (polygon, point, centroid, mask, from_polygon, from_mask) | PASS |
| Connection update | FAIL — backend bug [#1087](https://github.com/arjunrajlaboratory/NimbusImage/issues/1087) |

### Bugs found and fixed during e2e testing

- `get_worker_interface`: response IS the interface dict directly, not wrapped in `{"interface": ...}`
- `list_datasets`: was using broken `resource/search` by name prefix; now uses `dataset_view` endpoint
- `connectTo` default: must be `{"tags": []}` not `None` or `{}` (WorkerClient crashes on `connectTo['tags']`)
- `connectToNearest` URL: backend route is `/connectTo` not `/connectToNearest`
- Property compute `id` vs `_id`: worker reads `params.get("id")` but `to_dict()` serializes as `_id`; now remaps

## Remaining work

### Not yet implemented

- **Dataset upload** — needs backend refactoring (frontend logic for folder creation, metadata, large image detection)
- **Snapshots** — read works today, create/restore needs backend endpoints
- **Batch frame fetch** — needs new backend endpoint for multi-frame download
- **Bulk annotation update** — waiting on fix for [#780](https://github.com/arjunrajlaboratory/NimbusImage/issues/780)
- **Collection create/update/delete** — currently read-only
- **Dataset view create/update** — `list_views()` works but no write operations

### Known backend bugs

- **Connection update 500**: `PUT /annotation_connection/:id` — param name mismatch in handler ([#1087](https://github.com/arjunrajlaboratory/NimbusImage/issues/1087))

### Technical debt

- `id` vs `_id` inconsistency: server stores `_id` (MongoDB), frontend sends `id`, WorkerClient reads `id`. The `properties.compute()` method remaps `_id` → `id` as a workaround. Should be harmonized across the stack.
