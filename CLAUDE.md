# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NimbusImage is a web-based image visualization and annotation platform for analyzing large multidimensional scientific images. The application consists of a Vue 2 frontend with Vuetify UI components and a Girder-based backend for data management and storage.

**Key Technologies:**
- Frontend: Vue 2.7, TypeScript, Vuetify 2, Vuex with vuex-module-decorators
- Backend: Girder (Python), MongoDB, Docker
- Build: Vite, pnpm
- Image Processing: ITK/WebAssembly, ONNX Runtime (SAM models)
- Worker System: Girder Worker with Docker containers

## Development Commands

### Initial Setup
```bash
# Install dependencies
pnpm install

# Compile C++ code to WebAssembly (required before first run)
pnpm emscripten-build

# Start backend services (MongoDB, Girder, workers)
docker compose build
docker compose up -d

# Start frontend development server
pnpm run dev
```

Access the application at `http://localhost:5173` (frontend) and `http://localhost:8080` (Girder backend).

### Common Development Tasks
```bash
# Type checking
pnpm tsc

# Linting
pnpm lint
pnpm lint:fix
pnpm lint:ci  # CI mode with zero warnings

# Testing
pnpm test

# Production build
pnpm build

# Preview production build
pnpm run serve  # Serves on http://localhost:4173
```

### Building WebAssembly Components
```bash
# Release build (default)
pnpm emscripten-build

# Debug build with symbols
pnpm emscripten-build:debug
```

## Architecture

### Frontend Structure

**State Management (Vuex):**
- `src/store/index.ts` - Main store module with primary application state
- `src/store/annotation.ts` - Annotation data and operations
- `src/store/properties.ts` - Computed annotation properties
- `src/store/GirderAPI.ts` - API client for backend communication
- `src/store/AnnotationsAPI.ts` - Annotation-specific API endpoints
- `src/store/PropertiesAPI.ts` - Property computation API endpoints
- `src/store/ChatAPI.ts` - Chat/LLM integration API
- `src/store/girderResources.ts` - Resource caching and management

All store modules use `vuex-module-decorators` with `@Module`, `@Mutation`, and `@Action` decorators.

**Core Data Models (`src/store/model.ts`):**
- `IDataset` - Represents an image dataset with frames and metadata
- `IDatasetConfiguration` - Layer configuration, tools, scales
- `IDatasetView` - User-specific view state (contrast, location)
- `IDisplayLayer` - Individual layer with channel, color, contrast
- `IToolConfiguration` - Tool definitions from templates

**Component Organization:**
- `src/components/` - Reusable UI components
- `src/views/` - Route-level page components
- `src/tools/` - Tool creation and configuration UI
- `src/layout/` - App layout components
- `src/utils/` - Utility functions

**Key Components:**
- `ImageViewer.vue` - Main canvas rendering with GeoJS
- `AnnotationViewer.vue` - Annotation interaction handling
- `DisplayLayers.vue` - Layer visibility and configuration
- `AnnotationBrowser/` - Annotation filtering and export

### Tool System

Tools are defined in `public/config/templates.json` and created dynamically:

1. **Template Definition** - JSON schema defines tool type, interface elements, and metadata
2. **Tool Configuration** - `src/tools/creation/` handles UI for tool creation
3. **Tool Execution** - `AnnotationViewer.vue` implements tool interaction logic

See `TOOLS.md` for detailed documentation on adding new tools.

**Tool Types:**
- `annotation` - Manual annotation tools
- `snap` - Snap-to tools (e.g., circle-to-dot)
- `connection` - Create connections between annotations
- `tagging` - Tag annotations by clicking
- `samAnnotation` - Segment Anything Model integration
- `worker` - Backend worker computation tools

### Backend Integration

**Girder Client:**
- Authentication and user management
- RESTful API via `RestClient` from `@girder/components`
- Proxied through `girderRestProxy` for consistent token handling

**API Structure:**
- Base API: `GirderAPI.ts` handles datasets, configurations, items, files
- Annotations: `AnnotationsAPI.ts` manages annotation CRUD operations
- Properties: `PropertiesAPI.ts` handles computed property values
- Workers: Job submission and monitoring via Girder Worker

**Caching Strategy:**
- Image tiles cached with LRU policy
- Histograms cached per-layer for performance
- Resource metadata cached in `girderResources` module

**API Endpoint Reference:**

Plugin endpoints are registered in `__init__.py` (lines 159-173). Endpoint names differ from what you might expect:

| REST Path | Source File | Notes |
|-----------|-------------|-------|
| `/api/v1/upenn_annotation` | `server/api/annotation.py` | NOT `/annotation` |
| `/api/v1/upenn_collection` | `server/api/collection.py` | NOT `/collection` |
| `/api/v1/annotation_connection` | `server/api/connections.py` | Connections between annotations |
| `/api/v1/annotation_property_values` | `server/api/propertyValues.py` | Computed property data |
| `/api/v1/annotation_property` | `server/api/property.py` | Property definitions |
| `/api/v1/worker_interface` | `server/api/workerInterfaces.py` | Docker worker registration |
| `/api/v1/worker_preview` | `server/api/workerPreviews.py` | Worker preview images |
| `/api/v1/dataset_view` | `server/api/datasetView.py` | Per-user view state |
| `/api/v1/history` | `server/api/history.py` | Undo/redo history |
| `/api/v1/user_assetstore` | `server/api/user_assetstore.py` | Per-user storage |
| `/api/v1/user_colors` | `server/api/user_colors.py` | User color preferences |
| `/api/v1/export` | `server/api/export.py` | JSON/CSV export |
| `/api/v1/project` | `server/api/project.py` | Project management |
| `/api/v1/resource` | `server/api/resource.py` | Custom resource search |

All source files under `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/`. Swagger UI at `http://localhost:8080/api/v1#!/`.

### Image Rendering Pipeline

1. **Layer Resolution** - Determine which frames to display based on layer configuration (xy, z, time indices)
2. **Histogram Computation** - Fetch or compute intensity histograms for contrast adjustment
3. **Tile URL Generation** - Construct tile URLs with contrast, color, and style parameters
4. **GeoJS Rendering** - Render tiles with WebGL compositing

**Layer Modes:**
- `single` - One visible layer at a time
- `multiple` - Multiple layers with blending
- `unroll` - Display multiple frames in grid layout

**Slice Types:**
- `current` - Display current frame
- `max-merge` - Maximum intensity projection across frames
- `offset` - Display frame at offset from current

## Development Guidelines

### State Management Patterns

**Syncing with Backend:**
When modifying configuration, use the sync pattern:
```typescript
@Action
async updateSomething(value: any) {
  this.setSomethingImpl(value);  // Mutation
  await this.syncConfiguration('keyName');  // Sync to backend
}
```

**DatasetView vs Configuration:**
- `Configuration` - Shared settings (layers, tools, scales)
- `DatasetView` - User-specific settings (contrast overrides, last location)

Use `saveContrastInConfiguration` for shared changes, `saveContrastInView` for personal overrides.

### Working with Annotations

**Annotation Structure:**
- Stored in Girder backend as JSON documents
- Cached in `src/store/annotation.ts` module
- Indexed by annotation ID and layer

**Common Operations:**
```typescript
// Create annotation
await annotationStore.addAnnotationForFrame({ annotationData, frame });

// Update annotation
await annotationStore.updateAnnotation({ id, changes });

// Delete annotation
await annotationStore.deleteAnnotation(annotationId);

// Filter annotations
const filtered = annotationStore.filteredAnnotations;
```

### Adding Tools

1. Define tool template in `public/config/templates.json`
2. Add type to `TToolType` in `src/store/model.ts`
3. Implement interaction logic in `AnnotationViewer.vue`:
   - `refreshAnnotationMode()` - Set cursor mode and handlers
   - `handleAnnotationChange()` - Process new annotations
4. Add UI components in `src/tools/` if needed

### WebAssembly Integration

ITK-based image processing compiled to WASM:
- Source: `itk/` directory
- Build output: `itk/emscripten-build/`
- Usage: `src/utils/itk.ts` and `src/pipelines/computePipeline.ts`

Rebuild after modifying C++ code with `pnpm emscripten-build`.

### Worker System

Workers run in Docker containers via Girder Worker:
- Worker images defined in tool templates
- Jobs tracked in `src/store/jobs.ts`
- Progress monitoring via SSE events

### Girder Job Status Codes

The `girder_jobs` plugin defines these status constants (used by both backend `JobStatus` and frontend `jobStates`):

| Value | Constant | Meaning |
|-------|----------|---------|
| 0 | `INACTIVE` | Not yet scheduled |
| 1 | `QUEUED` | Waiting to run |
| 2 | `RUNNING` | Currently executing |
| 3 | `SUCCESS` | Completed successfully |
| 4 | `ERROR` | Failed |
| 5 | `CANCELED` | Cancelled |

**Warning:** Status 3 means **SUCCESS**, not "running". This differs from some other job systems. Backend: `from girder_jobs.constants import JobStatus`. Frontend: `src/store/jobConstants.ts`.

**Local Jobs:** For CPU-bound tasks that run inside the Girder process (not via Girder Worker), use `createLocalJob`:
```python
from girder_jobs.models.job import Job as JobModel
job = JobModel().createLocalJob(
    module='my.module',  # Must have a run(job) function
    title='My Job',
    type='my_job_type',
    user=user,
    kwargs={'key': 'value'},
    asynchronous=True,
)
JobModel().scheduleJob(job)
```

## Code Review Guidelines

### Avoid Looped Database Calls (Frontend AND Backend)

Never iterate and make individual database or API calls in a loop. This applies to **both** frontend API calls and backend database queries. Use batch/aggregated operations instead.

**Bad - Looped frontend calls:**
```typescript
// DON'T DO THIS
for (const annotation of annotations) {
  await api.createAnnotation(annotation);
}

for (const id of annotationIds) {
  await api.deleteAnnotation(id);
}
```

**Good - Batch frontend calls:**
```typescript
// USE BATCH ENDPOINTS
await api.createMultipleAnnotations(annotations);
await api.deleteMultipleAnnotations(annotationIds);
```

**Bad - Looped backend DB queries:**
```python
# DON'T DO THIS - N individual queries
for id in annotation_ids:
    doc = AnnotationModel().load(id, user=user, level=AccessType.WRITE)
    # ... process doc

for folder_id in folder_ids:
    folder = Folder().load(folder_id, user=user, level=AccessType.READ)
```

**Good - Batch backend DB queries:**
```python
# USE $in queries for bulk loading
docs = list(AnnotationModel().find({
    '_id': {'$in': [ObjectId(id) for id in annotation_ids]}
}))

# Then check access on the loaded documents, or use findWithPermissions
folders = list(Folder().find({
    '_id': {'$in': [ObjectId(id) for id in folder_ids]}
}))
```

When you need access-checked bulk loads and no batch method exists, implement one rather than looping.

**Available batch frontend endpoints** (see `annotation_client/annotations.py`):
- `createMultipleAnnotations(annotations)` - Create annotations in bulk
- `deleteMultipleAnnotations(annotationIds)` - Delete annotations in bulk
- `createMultipleConnections(connections)` - Create connections in bulk
- `deleteMultipleConnections(connectionIds)` - Delete connections in bulk
- `addMultipleAnnotationPropertyValues(entries)` - Add property values in bulk (auto-batches at 10K)

### Avoid Unnecessary Temporary Variables

Don't create intermediate variables that are only used once immediately after assignment.

**Bad:**
```typescript
const newAnnotations = await api.getAnnotations();
this.setAnnotations(newAnnotations);

const filtered = annotations.filter(a => a.tags.includes(tag));
return filtered;
```

**Good:**
```typescript
this.setAnnotations(await api.getAnnotations());

return annotations.filter(a => a.tags.includes(tag));
```

Exception: Keep temporaries when they improve readability for complex expressions or when the variable name documents intent.

### Backend Security and Access Control

When editing backend code, always maintain the existing security and access control patterns:

- Use `AccessType` levels consistently: `READ` (view), `WRITE` (edit), `ADMIN` (owner — can share, set public, delete)
- Note: `AccessType.ADMIN` on a document means **owner of that document**, not site-wide admin. `@access.admin` (the endpoint decorator) means site-wide Girder admin — these are different concepts.
- Check user permissions before data operations
- Validate that users have access to the dataset/resource being modified
- Never bypass access checks, even for "convenience"
- Follow existing patterns in the plugin for permission validation
- **Security enforcement belongs in the backend, not the frontend.** Don't add frontend login/permission checks as a substitute for proper backend access control. If the backend enforces access correctly, the frontend doesn't need to duplicate those checks.
- Consider permission escalation risks: e.g., if a user has WRITE access to a dataset, can they use that to grant themselves access to things the dataset owner didn't intend? Think through the access chain.
- For public-access endpoints that hit the database, consider rate limiting to prevent abuse by unauthenticated users.

### Flag Repeated Frontend Calls

When editing frontend code, identify patterns where multiple backend calls could be consolidated. Flag these for discussion:

```typescript
// FLAG THIS: Multiple calls that could be a single batch endpoint
await Promise.all(items.map(item => api.updateItem(item)));
// Could this be a batch endpoint on the backend?
```

When you see such patterns, note them and suggest whether a new batch endpoint should be created.

### Code Factorization

- Look for repeated code patterns that should be extracted into utility functions
- If you notice a pattern that looks like it should be handled by an existing package, mention it so we can search for appropriate libraries
- Prefer composition over duplication
- Extract common API patterns into reusable methods
- **Backend helpers**: When the same logic appears in multiple API files (e.g., loading a dataset and checking permissions), extract it to a shared helper in `server/helpers/` or `server/models/`. Don't copy-paste between API endpoints.
- **Frontend components**: When the same UI pattern appears 3+ times (e.g., similar form sections, similar list items), extract it into a reusable component
- **Reuse existing results**: If a function fetches data that was already fetched earlier in the call chain, pass it as a parameter instead of re-fetching. Avoid redundant database/API calls for data you already have.

### Code Organization and Placement

Place code in appropriate locations:

- **API methods** should live in their respective API files (`GirderAPI.ts`, `AnnotationsAPI.ts`, etc.), not in Vue components. Any `this.girderRest.get(...)` or `this.girderRest.post(...)` call in a Vue component should be moved to the appropriate API file.
- **Store state** should be organized into focused modules. `src/store/index.ts` is already large (2000+ lines); consider creating new store modules for distinct feature areas when implementing new categories of features.
- **Utility functions** shared across components should go in `src/utils/`. Search for existing utility functions before creating new ones.
- **Frontend should not compensate for backend issues.** Don't add frontend fallback logic to handle outdated backends or missing backend features. If the backend API is correct, the frontend should trust it. Double implementations (try new API, fall back to old API) create maintenance burdens.

**Bad:**
```typescript
// In a Vue component
async checkDatasetNameExists(name: string) {
  const response = await this.girderRest.get(`dataset/name/${name}`);
  return response.data.exists;
}
```

**Good:**
```typescript
// In GirderAPI.ts
async checkDatasetNameExists(name: string): Promise<boolean> {
  const response = await this.client.get(`dataset/name/${name}`);
  return response.data.exists;
}
```

### Naming Clarity

Use clear, descriptive names that reflect current functionality:

- Rename functions when their signature changes (e.g., if a function no longer uses `params`, remove it from the name)
- Use specific variable names instead of generic ones (`propertyId` instead of `id` or `item`)
- Boolean variables should indicate their purpose: prefer `isPublicSelected` or `canBePublic` over ambiguous names like `makePublic`

**Bad:**
```typescript
function getPropertyFromParams(params: any) {  // params is no longer used
  return this.getPropertyById(this.currentPropertyId);
}

const id = request.params.id;  // Which ID? Be specific
```

**Good:**
```typescript
function getProperty() {
  return this.getPropertyById(this.currentPropertyId);
}

const propertyId = request.params.id;
```

### Avoid Redundant Checks and Code

Don't add checks or code that duplicate existing behavior:

- **Don't add validation** that will happen anyway (e.g., checking if an ID is valid before converting to ObjectId, when the conversion itself throws on invalid IDs)
- **Don't catch broad exceptions** like `except Exception`. This swallows errors you don't want to catch (KeyboardInterrupt, MemoryError, storage failures). Catch specific exception types only.

**Bad:**
```python
# Redundant validation
if not is_valid_object_id(id):
    raise ValidationException("Invalid ID")
obj_id = ObjectId(id)  # This already throws on invalid ID

# Overly broad exception handling
try:
    obj_id = ObjectId(string_id)
except Exception:
    raise ValidationException("Invalid ID")
```

**Good:**
```python
obj_id = ObjectId(string_id)  # Let it raise naturally

# If you must catch, be specific
try:
    obj_id = ObjectId(string_id)
except bson.errors.InvalidId:
    raise ValidationException("Invalid ID format")
```

### Backend: API Layer vs Model Layer Separation

The API layer (`server/api/*.py`) and model layer (`server/models/*.py`) have distinct responsibilities. Do not mix them.

**API layer** is responsible for:
- Input parsing and validation (converting request params to domain types)
- HTTP-specific concerns (`RestException` with status codes)
- Calling model methods with validated, clean data

**Model layer** is responsible for:
- Business logic and data operations
- Domain validation (raise `ValueError` or `ValidationException`, never `RestException`)
- Being abstract from any HTTP/API concerns

**Bad:**
```python
# In a model file - DON'T use RestException in models
class AnnotationModel(ProxiedModel):
    def update(self, annotation, body):
        if 'tags' not in body:
            raise RestException("tags is required", 400)  # Wrong!
```

**Good:**
```python
# In model - use domain errors
class AnnotationModel(ProxiedModel):
    def update(self, annotation, body):
        if 'tags' not in body:
            raise ValueError("tags is required")

# In API - handle HTTP concerns, convert inputs once at the top
class AnnotationResource(Resource):
    def update(self, body):
        # Convert/validate inputs at API boundary
        tags = [ObjectId(t) for t in body.get('tags', [])]
        # Pass clean data to model
        return self._model.update(annotation, tags=tags)
```

Input conversion (e.g., string to ObjectId, parsing JSON body fields) should happen **once at the top of the API method**, not deep in utility functions or models.

### Backend: Use Girder Model Methods, Not Raw PyMongo

Always use `Model().find()`, never `Model().collection.find()`. Girder's model methods add security features (authorized field filtering, query timeouts).

**Bad:**
```python
# Bypasses Girder's security
docs = list(MyModel().collection.find({'datasetId': dataset_id}))
```

**Good:**
```python
# Uses Girder's find with security features
docs = list(MyModel().find({'datasetId': dataset_id}))
```

**Exception:** Aggregation pipelines require `collection.aggregate()` since Girder's `find()` doesn't support them. This is the only acceptable use of `collection` directly.

### Backend Python Patterns

When working with Girder/Python backend code:

- Use `exc=True` when loading models to automatically raise exceptions if not found, rather than manual null checks
- Be mindful of ObjectId conversions - some values are stored as strings in metadata but need conversion for queries
- Use JSON Schema validation for structured input data (see example in `server/models/collection.py`)
- Use `list.copy()` instead of `list(mylist)` for copying lists — it's more readable
- Use dataclasses or structured dicts defined at the top of a file for complex field definitions, rather than inline string manipulation

**Bad:**
```python
prop = PropertyModel().load(property_id, user=user, level=AccessType.READ)
if prop is None:
    raise RestException("Property not found", 404)
```

**Good:**
```python
prop = PropertyModel().load(property_id, user=user, level=AccessType.READ, exc=True)
```

### Simplify Where Possible

Look for opportunities to simplify code:

- Replace verbose null checks with concise equivalents: `if (value === null || value === undefined)` can become `if (value == null)`
- Consider whether streaming/complex implementations are necessary for typical use cases
- Question whether custom implementations can be replaced with library functions (e.g., `orjson.dumps()` instead of manual JSON streaming)
- Before adding new functionality, ask: **is this change actually necessary?** Challenge assumptions about what needs to change. Unnecessary complexity is a liability.

## Testing

### Frontend Tests
- Unit tests use Vitest
- Test files: `*.test.ts` alongside source
- Run with `pnpm test`

### Backend Tests (Girder Plugin)
- Tests use pytest with Girder fixtures
- Test files: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/`
- Run with tox from the plugin directory:
```bash
cd devops/girder/plugins/AnnotationPlugin
tox        # Run all tests
tox -r     # Recreate environment (after dependency changes)
```

### Backend Tests (Girder Plugin)
The AnnotationPlugin has Python tests using pytest via tox:

```bash
# Navigate to the plugin directory
cd devops/girder/plugins/AnnotationPlugin

# Run all tests
tox

# Recreate tox environment (after dependency changes)
tox -r
```

**Test Structure:**
- Tests location: `upenncontrast_annotation/test/`
- `test_annotations.py` - Annotation model and API tests
- `test_connections.py` - Connection model and helper tests
- `test_export.py` - JSON and CSV export endpoint tests
- `conftest.py` - Pytest fixtures
- `girder_utilities.py` - Test helper for creating folders
- `upenn_testing_utilities.py` - Sample data generators

**Writing Backend Tests:**
```python
@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestMyFeature:
    def testSomething(self, admin):
        # admin fixture provides authenticated admin user
        folder = utilities.createFolder(admin, "name", datasetMetadata)
        # ... test logic
```

### Backend Linting

The backend uses flake8 for Python linting with the default max line length of 79 characters:

```bash
# Install flake8 (macOS)
brew install flake8

# Run flake8 on backend code (uses default 79 char limit)
flake8 devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation

# Run flake8 on a specific file
flake8 devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/export.py
```

Note: Linting is also run as part of tox tests, so `tox` will catch linting errors.

## Important Notes

- **Package Manager:** Project uses pnpm exclusively (enforced by preinstall script)
- **Default Credentials:** Admin user `admin` with password `password` - change in production
- **Port Configuration:** Frontend (5173), Girder (8080), MongoDB (27017)
- **Browser Support:** Chrome, Firefox, Safari; SAM tools require WebGPU (Chrome only)
- **Large Images:** Backend uses `large_image` plugin for tile serving

## LLM Integration

The chat system (`src/store/chat.ts`) integrates Claude for image analysis:
- Chat history stored in browser IndexedDB
- API key configured via `ANTHROPIC_API_KEY` environment variable
- Chat UI in `ChatComponent.vue`

## Allowed Tools

The following commands are pre-approved for Claude Code to run without confirmation:

```
# Docker commands for backend development
Bash(docker compose build:*)
Bash(docker compose:*)
Bash(curl:*)

# Testing
Bash(tox)
Bash(tox:*)

# Git operations
Bash(git add:*)
Bash(git commit:*)
Bash(git push:*)
```
