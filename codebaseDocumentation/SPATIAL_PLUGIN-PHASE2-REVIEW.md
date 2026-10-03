# Spatial plugin Phase 2 — review findings

Self-review round on the Phase 2 diff (`xenium-phase0`, 2026-09-02). Feature record:
`SPATIAL_PLUGIN.md` "Phase 2".

| # | Severity | Location | Summary | Status |
|---|---|---|---|---|
| 1 | Medium | `models/annotation.py` `colorByProperty` | Provider values are keyed by id string, the membership guard by ObjectId; the map emptied and the endpoint answered "No values found" | fixed — keys converted at the boundary; *"testColorByVirtualPath"* |
| 2 | Medium | `upenncontrast_spatial/__init__.py` | The differential job's table was stored on the job document but Girder's job model whitelists fields, so `GET job/{id}` dropped it | fixed — `Job().exposeFields(READ, {"spatialResult"})`; asserted through `Job().filter` in *"testDifferentialRanksAndSchedules"* |
| 3 | Medium | `api/spatial.py` `differential` | First version put every matched row index in the job kwargs (up to 709K ints in one Mongo document) | fixed — the validated filter objects ride in the job; rows resolve inside `run` |
| 4 | Low | `properties.ts` | Reusing `uniquePropertyPaths` for the computed-path union would have truncated the list at the displayed-column cap | fixed — uncapped `dedupePropertyPaths` |
| 5 | Low | `properties.ts` `fetchAllPropertyValues` | Below the stub threshold the wholesale value map comes from the find endpoint, which knows nothing about virtual paths | fixed — `fetchVirtualPropertyValues` merges them from the batch endpoint; *"adds live columns: shown, listed among computed paths, and fetched below the stub threshold"* |
| 6 | Low | `PropertyChipStrip.test.ts` | Mock of `@/store/properties` lacked the new named exports `propertyEntries.ts` imports | fixed |
| 7 | Low | `differential.py` | Welch t on raw counts; Wilcoxon/Mann-Whitney initially deferred | superseded — the branch now implements the optional Mann-Whitney method and exposes it in the API, client, and dialog |
| 8 | Low | CSV export / list sort | Virtual columns export empty and cannot sort | by-design for this phase — documented in the genes dialog's mode hint and `SPATIAL_PLUGIN.md`; the stored copy covers both |
| 9 | Nit | Girder local jobs | `createLocalJob(asynchronous=True)` sometimes ran inside the request (score 43 s, differential 14 s observed live) | noted — Girder's local-job daemon behavior, not this plugin's; the clients poll either way |

Blast-radius notes:
- *"`_propertyStats` took a selector; now also the matching ids."* Only `summarize` calls it; the fallback `stats is None` path now fills every stored path with the empty record (before: an early return of empties), same result.
- *"`listPage` returned a cursor; now a list when a virtual path is requested."* `_streamJsonArray` iterates either; `listPosition`/count are untouched.
- *"Property filters could only be stored paths; now virtual ones resolve to id clauses."* `dropNoOpPropertyFilters` runs before `resolveProviderFilters`, so an inactive virtual filter never reaches the provider; `narrowsPopulation` counts the resulting `gateMatchClauses`, so the spatial `aggregate` still narrows correctly.

| R2 | Nit | `DifferentialExpressionDialog.vue`, `api/spatial.py`, `nimbusimage/README.md`, `SPATIAL_PLUGIN.md` | Round 2: strings still said "Welch t-test" after `method=wilcoxon` was added. | fixed. |
