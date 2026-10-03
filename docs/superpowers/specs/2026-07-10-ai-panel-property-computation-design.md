# AI Panel property computation — Design

**Date:** 2026-07-10
**Branch:** `claude/ai-panel-interface-spec-9k6gsv`

## Problem

The AI panel can create/select/run tools but cannot compute annotation
**properties** (measurements: intensity, morphology, …). The model can already
*discover* property workers (`list_workers` returns `isPropertyWorker`, and
`get_worker_interface` reads params) but has no way to define, compute, or read
properties.

## Decisions (confirmed with user)

- **Scope:** full — define + compute + list property definitions, **and** read
  computed values.
- **Gating:** `create_property` + `compute_property` gated (config mutation /
  compute job); `list_properties` + `get_property_values` read-only.

## Domain facts

- `IAnnotationPropertyConfiguration = { name, image (property worker), tags:
  {tags, exclusive}, shape (AnnotationShape), workerInterface (params) }`.
- `propertyStore.createProperty(config)` creates the property document **and**
  auto-registers it with the collection (`setProperties` →
  `updateConfigurationProperties` sync) — one call does both.
- `propertyStore.computeProperty({ property, errorInfo })` runs a Girder job
  (like `run_worker`); values populate `propertyStore.propertyValues` async.
- `propertyStore.propertyValues[annotationId]` is nested; `computedPropertyPaths`
  enumerates full paths (path[0] = propertyId).

## Four tools (all in `src/agent/executors.ts`)

1. **`list_properties`** (read-only): map `propertyStore.properties` to
   `{ id, name, image, shape, tags, computed }` (computed = any
   `computedPropertyPaths` entry starts with the property id).
2. **`create_property`** (gated): validate `propertyWorkerImage` is a property
   worker (`workerImageList[image].isPropertyWorker`), resolve params, build the
   config, call `createProperty`. Returns `{ propertyId, name, image, shape }`.
3. **`compute_property`** (gated): look up the property by id, call
   `computeProperty`. Fire-and-report (job) — returns `{ started: true }`.
4. **`get_property_values`** (read-only): `fetchPropertyValues`, then aggregate
   **summary stats** (count/mean/min/max) per computed path, optionally filtered
   to one `propertyId` and/or an annotation `query`. No raw per-annotation dump
   (same context-budget principle as the `list_annotations` guardrail).

## Reuse

The worker-interface parameter resolution (fetch interface, reject unknown
override keys, merge overrides/saved/defaults via `getDefault`) was inline in
`run_worker`; extracted to `resolveWorkerInterfaceValues(image, overrides,
saved?)` and shared by `run_worker` and `create_property`.

## Surfacing

Schema entries in `agent_tools.json`; `describeAgentToolCall` cards; a
system-prompt paragraph describing the measure-X-on-Ys flow.

## Testing

Executor tests: gating; `list_properties` shape + computed flag;
`create_property` config construction + non-property-worker rejection;
`compute_property` by id + unknown-id rejection; `get_property_values` stats +
annotation-query filtering.

## Deploy note

Schema + prompt ship in the plugin package → needs a girder rebuild to go live.

## Out of scope

- Deleting properties; editing an existing property definition.
- Per-annotation value listing (only summary stats).
- Waiting for the compute job to finish inside the tool call (fire-and-report,
  like `run_worker`).
