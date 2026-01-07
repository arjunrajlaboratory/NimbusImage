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
- `test_export.py` - JSON export endpoint tests
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
