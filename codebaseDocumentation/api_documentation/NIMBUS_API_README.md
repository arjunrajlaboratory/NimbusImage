# NimbusImage API Documentation

This directory contains comprehensive documentation for the NimbusImage Python API, intended to inform the design of a unified `ni` (nimbusimage) package.

## Documents

| File | Description |
|------|-------------|
| [01_overview.md](01_overview.md) | Architecture overview: current packages, how they relate, the case for unification |
| [02_connection_and_authentication.md](02_connection_and_authentication.md) | Connecting to Girder, authentication, listing datasets |
| [03_tile_client.md](03_tile_client.md) | Image access: frames, regions, metadata, multi-channel, subregions |
| [04_annotations.md](04_annotations.md) | Annotation CRUD: create, read, update, delete, bulk operations |
| [05_connections.md](05_connections.md) | Annotation connections: parent-child relationships, connect-to-nearest |
| [06_properties.md](06_properties.md) | Property values: computing, submitting, nested/multi-dimensional values |
| [07_annotation_utilities.md](07_annotation_utilities.md) | Utility functions: coordinate conversions, tag filtering, channel merging |
| [08_worker_client.md](08_worker_client.md) | WorkerClient: batch annotation creation, image stacking |
| [09_image_processing.md](09_image_processing.md) | Writing processed images back to Girder via large_image |
| [10_messaging.md](10_messaging.md) | Progress, warning, and error messaging from workers |
| [11_coordinate_conventions.md](11_coordinate_conventions.md) | Critical: pixel offsets, x/y swaps, numpy vs annotation coordinates |
| [12_interface_types.md](12_interface_types.md) | Worker interface parameter types and what they return |
| [13_usage_patterns.md](13_usage_patterns.md) | Common patterns from real workers and notebooks |
| [14_unified_api_design_notes.md](14_unified_api_design_notes.md) | Design notes for the future `ni` package |
| [15_server_rest_api.md](15_server_rest_api.md) | Complete server-side REST API: all 75+ endpoints from the Girder plugin, coverage gaps |
| [16_refactoring_plan.md](16_refactoring_plan.md) | Migration plan: test coverage gaps, phase 0 (tests first), phase 1 (wrapper), phase 2 (migrate) |
| [17_api_namespace_design.md](17_api_namespace_design.md) | Full namespace design: module tree, data classes, MCP tool mapping, skill pattern guide |

## Current Package Locations

| Package | Source Location |
|---------|----------------|
| `annotation_client` | `UPennContrast/devops/girder/annotation_client/annotation_client/` |
| `annotation_utilities` | `ImageAnalysisProject/annotation_utilities/annotation_utilities/` |
| `worker_client` | `ImageAnalysisProject/worker_client/worker_client/` |
