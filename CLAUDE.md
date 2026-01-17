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

## Code Review Guidelines

### Avoid Looped Database Calls

Never iterate and make individual API calls in a loop. This hammers the backend and causes performance issues. Use batch/aggregated endpoints instead.

**Bad - Looped calls:**
```typescript
// DON'T DO THIS
for (const annotation of annotations) {
  await api.createAnnotation(annotation);
}

for (const id of annotationIds) {
  await api.deleteAnnotation(id);
}
```

**Good - Batch calls:**
```typescript
// USE BATCH ENDPOINTS
await api.createMultipleAnnotations(annotations);
await api.deleteMultipleAnnotations(annotationIds);
```

**Available batch endpoints** (see `annotation_client/annotations.py`):
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

- Use `AccessType` decorators consistently (`READ`, `WRITE`, `ADMIN`)
- Check user permissions before data operations
- Validate that users have access to the dataset/resource being modified
- Never bypass access checks, even for "convenience"
- Follow existing patterns in the plugin for permission validation

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

### Code Organization and Placement

Place code in appropriate locations:

- **API methods** should live in their respective API files (`GirderAPI.ts`, `AnnotationsAPI.ts`, etc.), not in Vue components
- **Store state** should be organized into focused modules. `src/store/index.ts` is already large (2000+ lines); consider creating new store modules for distinct feature areas when implementing new categories of features.
- **Utility functions** shared across components should go in `src/utils/`. Search for existing utility functions before creating new ones.

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

**Bad:**
```python
// Backend - redundant validation
if not is_valid_object_id(id):
    raise ValidationException("Invalid ID")
obj_id = ObjectId(id)  # This already throws on invalid ID
```

### Backend Python Patterns

When working with Girder/Python backend code:

- Use `exc=True` when loading models to automatically raise exceptions if not found, rather than manual null checks
- Be mindful of ObjectId conversions - some values are stored as strings in metadata but need conversion for queries

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

## Testing

### Frontend Tests
- Unit tests use Vitest
- Test files: `*.test.ts` alongside source
- Run with `pnpm test`

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

The backend uses flake8 for Python linting with a max line length of 88 characters:

```bash
# Install flake8 (macOS)
brew install flake8

# Run flake8 on backend code
flake8 devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation --max-line-length=88

# Run flake8 on a specific file
flake8 devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/export.py --max-line-length=88
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
