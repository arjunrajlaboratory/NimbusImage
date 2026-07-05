# Feature Documentation Index

Use this index to load relevant architecture docs when reviewing feature-specific changes.

## Feature Area -> Documentation Mapping

| If the branch touches... | Read this documentation |
|---|---|
| Sharing, access control, permissions UI | `codebaseDocumentation/SHARING.md` |
| Projects, Zenodo export, project metadata | `codebaseDocumentation/PROJECTS.md` |
| Combine annotations, polygon union | `codebaseDocumentation/COMBINE_ANNOTATIONS.md` |
| SAM tool, ONNX models, WebGPU inference | `codebaseDocumentation/SAM2_MIGRATION.md` |
| Batch annotation compute, worker batch | `codebaseDocumentation/BATCH_ANNOTATION_COMPUTE.md` |
| Batch property compute | `codebaseDocumentation/BATCH_PROPERTY_COMPUTE.md` |
| Annotation rendering / draw path / stubs / hydration / z-scrub perf | `codebaseDocumentation/ANNOTATION-STUBS.md`, `codebaseDocumentation/ANNOTATION_PERFORMANCE_OPTIMIZATIONS.md`, `codebaseDocumentation/ZSCRUB_FEATURE_REUSE.md`, `codebaseDocumentation/VIEWPORT-BOUND-BUDGET.md` |
| Component tests (`*.test.ts` under `src/components/`), watcher/draw/mock behavior | `codebaseDocumentation/FRONTEND_COMPONENT_TESTING.md` |

## File Pattern -> Feature Area Mapping

| Files changed | Feature area |
|---|---|
| `ShareDataset.vue`, `datasetView.py` share/access endpoints | Sharing |
| `projects.ts`, `ProjectsAPI.ts`, `project.py`, `Project*.vue` | Projects |
| `polygonUnion.ts`, `annotationEdit` tool code | Combine annotations |
| `samPipeline.ts`, `computePipeline.ts`, ONNX configs | SAM tool |
| `AnnotationWorkerMenu.vue`, `computeAnnotationsWithWorkerBatch` | Batch annotation |
| `AnnotationProperties.vue`, `computePropertyBatch` | Batch property |
| `AnnotationViewer.vue`, `ImageViewer.vue`, `utils/annotation.ts` draw/stub helpers | Annotation rendering |
| `*.test.ts` under `src/components/` (mounting components) | Component tests |

## Cross-Cutting Patterns

Some patterns appear in multiple features. When reviewing, check consistency:

- **Batch processing**: Both annotation and property batch use the same `onCancel` callback, promise capture, `BATCH_DATASET_LIMIT`, and progress patterns
- **Access control**: Sharing affects datasets, configurations, and views simultaneously
- **Store modules**: Projects, annotations, and properties all use `vuex-module-decorators` with the set-then-fetch pattern
