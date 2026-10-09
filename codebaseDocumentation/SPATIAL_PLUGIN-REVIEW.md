# Spatial plugin — review findings

Tracker for the `/branch-review` round on the Phase 1 work (`xenium-phase0`, 2026-09-02).
Feature record: `SPATIAL_PLUGIN.md`.

| # | Severity | Location | Summary | Status |
|---|---|---|---|---|
| 1 | Medium | `api/spatial.py` `column` | A dense gene returned hundreds of thousands of pairs through Python lists and the default JSON encoder on a public endpoint | fixed — orjson serializes the numpy arrays directly (`OPT_SERIALIZE_NUMPY`), body returned as bytes |
| 2 | Medium | `api/spatial.py` `get` | Every `GET spatial/{id}` ran `listIds` over the whole dataset for `liveAnnotations` (~1.5 s at 700K) although the frontend only needs to know a table exists | fixed — opt-in `verify` param; `ds.spatial.info(verify=True)`; `ISpatialInfo.liveAnnotations` optional |
| 3 | Low | `api/spatial.py` `_filtersNarrow` | Mirrored the annotation model's private `_hasAnnotationFieldFilters` field list across plugins | fixed — public `Annotation.narrowsPopulation(filters)` on the annotation model, used by the spatial API |
| 4 | Low | `store.py` `rowsForAnnotationIds` | An empty store indexed into an empty sorted array | fixed — returns -1 for every id; covered by *"testRowsForAnnotationIdsHandlesMissingAndEmpty"* |
| 5 | Nit | `xenium_build_spatial_store.py` | Redundant `sys.path` insert for a sibling import | fixed |
| 6 | Nit | repo | `AnnotationPlugin/build/` left behind by installing the sibling plugin in tox | fixed — removed and ignored (`devops/girder/plugins/*/build/`) |
| 7 | Low | `materialize.py` `run` | `except Exception` at the job entry point | by-design — a local job must record ERROR status for any failure and re-raise; same shape as `zenodo_job.run` |
| 8 | Low | `api/spatial.py` `_materializedProperty` | Requires WRITE on every configuration of the dataset | by-design — registering a property edits each configuration; the 400 says so |

Blast-radius notes:
- *"`liveAnnotations` was always present; now only with `verify`."* Frontend never read it (`hasTable` only needs a non-null answer); the Python docstring and `SPATIAL_PLUGIN.md` updated; the plugin test asserts the key is absent without `verify`.
- *"`column` returned a dict; now bytes with an explicit content type."* Girder returns bytes verbatim; `SpatialAPI` is untouched because the wire shape is identical.
