# Server-Side Analysis Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make analysis-panel gates work above 50,000 objects by resolving gate polygons server-side (Phase 1), rendering server-binned heatmaps with shape-drawn gates above the cap (Phase 2), and sending gate definitions instead of id lists to the list endpoints (Phase 3).

**Architecture:** Gates become pure per-annotation predicates (spec: `codebaseDocumentation/SERVER_GATING.md`). A numpy-backed helper module in the Girder plugin resolves polygons over projected Mongo scans; the client routes over-cap resolution through a new endpoint keyed by revision counters instead of population hashes. Cross-language parity is pinned by a committed JSON fixture generated from the TS reference implementation.

**Tech Stack:** Girder 5 plugin (Python, numpy, pytest/tox), Vue 3 + Vuex frontend (TypeScript, vitest), Plotly heatmap + shape drawing.

## Global Constraints

- Spec is authoritative: `codebaseDocumentation/SERVER_GATING.md`. ANALYSIS_PANEL.md invariants all hold.
- Backend: API/model layering (RestException only at API boundary; ValueError in models/helpers); all queries through model methods or `_aggregate`; `exc=True`; no `except Exception`; flake8 79-col.
- Frontend: sequence-guard token claimed as first statement of refresh actions; failure returns `null` never `{}`; no id-list serialization in signatures; no display work while palette hidden; `pnpm tsc` and `pnpm lint:ci` clean.
- New constants: `MAX_ANALYSIS_PLOTS = 100`, `MAX_GATE_VERTICES = 10_000`, `MAX_GATE_CATEGORIES = 10_000`, `MAX_HISTOGRAM_BINS = 512`, `MAX_HISTOGRAM_ID_CONSTRAINT = 50_000`.
- Parity fixture path (shared by both suites): `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/fixtures/analysis_gating_parity.json`.
- Backend tests: `cd devops/girder/plugins/AnnotationPlugin && tox`. Frontend: `pnpm test`. Commit after each green task.

---

### Task 1: Unknown-category exclusion + deterministic appended-category order (client)

**Files:**
- Modify: `src/utils/analysisGating.ts` (resolveGateIds, buildPlotSeries buildAxis)
- Test: `src/utils/__tests__/analysisGating.test.ts`

**Interfaces:**
- Produces: `resolveGateIds(series, gate)` now excludes points whose categorical index ≥ the gate's pinned-category count for that axis. `buildPlotSeries` appends unknown categories sorted by label then key (was: encounter order).

- [ ] **Step 1: Write failing tests**

```ts
describe("unknown-category gate exclusion", () => {
  it("excludes annotations whose category is not in the gate's pinned order", () => {
    // Gate pinned when only category A existed; polygon spans x in [-0.5, 1.5]
    // so it would cover appended index 1 under the old semantics.
    const annotations = [
      makeStub("a1", { tags: ["A"] }),
      makeStub("b1", { tags: ["B"] }), // unknown to the gate
    ];
    const gate: IAnalysisGate = {
      categoryKeyVersion: 1,
      vertices: [
        { x: -0.5, y: -1 }, { x: 1.5, y: -1 },
        { x: 1.5, y: 1 }, { x: -0.5, y: 1 },
      ],
      xCategories: [encodeAnalysisCategoryKey(["A"])],
      yCategories: null,
    };
    const series = buildPlotSeries({
      annotations, values: valuesWithYZero(annotations),
      xAxis: { type: "categorical", key: "tags" },
      yAxis: { type: "property", path: ["p", "v"] },
      channelName: (c) => `Channel ${c}`,
      xCategoryOrder: gate.xCategories, yCategoryOrder: null,
    });
    expect(resolveGateIds(series, gate)).toEqual(["a1"]);
  });
  it("appends unknown categories sorted by label, not encounter order", () => {
    // pinned ["B"]; population encounters D then C; expect [B, C, D]
  });
});
```

- [ ] **Step 2: Run to verify failure** (`pnpm vitest run src/utils/__tests__/analysisGating.test.ts`)
- [ ] **Step 3: Implement.** In `resolveGateIds`, add per-axis pinned counts from the gate; skip point `i` when `series.xCategories !== null && gate.xCategories !== null && Math.round(series.x[i]) >= gate.xCategories.length` (same for y). In `buildAxis`, after collecting unknown keys under a pinned order, sort just the appended slice with the existing label-then-key comparator.
- [ ] **Step 4: Full gating tests pass** — including existing tests; any that pinned encounter-order appending get updated to the new documented semantics (cite spec section in the test comment).
- [ ] **Step 5: Commit** `feat: unknown-to-gate categories are outside the gate`

### Task 2: Cross-language parity fixture (TS reference side)

**Files:**
- Create: `src/utils/__tests__/analysisGatingParity.test.ts`
- Create: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/fixtures/analysis_gating_parity.json`

**Interfaces:**
- Produces: fixture JSON `{ jitterCases: [{id, salt, expected}], gateCases: [{name, annotations, values, plots: [{xAxis, yAxis, gate}], expected: {plotIndex: string[]}}] }`. Regeneration: `UPDATE_PARITY_FIXTURE=1 pnpm vitest run src/utils/__tests__/analysisGatingParity.test.ts` rewrites the file from the TS implementation; without the env var the test asserts against the committed file.

- [ ] **Step 1: Write the test** (reads fixture with `fs.readFileSync(new URL(...))`, asserts `jitterFromId(id, salt) === expected` exactly and `resolveGateIds(buildPlotSeries(...), gate)` equals expected id arrays; when `process.env.UPDATE_PARITY_FIXTURE` is set, recompute and write instead).
- [ ] **Step 2: Generate fixture** with the env var; inspect it (≥20 jitter cases incl. 24-char hex ids and one astral-plane string; gate cases per spec list: property×property, property×categorical, categorical×categorical, missing values, astral tag, duplicate labels, box gate, <3 vertices, strip-slicing polygon, unknown-category exclusion).
- [ ] **Step 3: Re-run without env var → passes.** Commit fixture + test: `test: analysis gating parity fixture (TS reference)`

### Task 3: Backend gating maths — `server/helpers/analysis.py`

**Files:**
- Create: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/helpers/analysis.py`
- Test: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/test_analysis_gating.py`
- Modify: `devops/girder/plugins/AnnotationPlugin/setup.py` (add `"numpy"` to install_requires)

**Interfaces:**
- Produces (all pure, ValueError on domain errors, no girder imports):
  - `jitter_from_id(annotation_id: str, salt: int) -> float`
  - `jitter_from_ids(ids: list[str], salt: int) -> np.ndarray` (float64)
  - `encode_category_key(raw) -> str` and `utf16_sort_key(s: str)`
  - `categorical_raw_identity(doc: dict, key: str)` — doc has `tags/shape/channel/location`
  - `points_in_polygon(xs: np.ndarray, ys: np.ndarray, vertices: list[dict]) -> np.ndarray[bool]` (even-odd, vectorized, <3 vertices → all False)
  - `axis_coordinates(docs: list[dict], values_by_id: dict[str, dict], axis: dict, categories: list[str] | None, salt: int) -> np.ndarray` (NaN = no value / unknown category)
  - `resolve_gate_ids(docs, values_by_id, plot: dict) -> list[str]`

Core implementations (verbatim spec semantics):

```python
X_JITTER_SALT = 17
Y_JITTER_SALT = 31

def jitter_from_id(annotation_id, salt):
    h = salt & 0xFFFFFFFF
    for ch in annotation_id:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return ((h % 1000) / 1000 - 0.5) * 0.56

def jitter_from_ids(ids, salt):
    if not ids:
        return np.empty(0, dtype=np.float64)
    length = max(len(i) for i in ids)
    codes = np.zeros((len(ids), length), dtype=np.uint32)
    mask = np.zeros((len(ids), length), dtype=bool)
    for row, annotation_id in enumerate(ids):
        codes[row, : len(annotation_id)] = [ord(c) for c in annotation_id]
        mask[row, : len(annotation_id)] = True
    h = np.full(len(ids), salt, dtype=np.uint32)
    for col in range(length):
        step = h * np.uint32(31) + codes[:, col]
        h = np.where(mask[:, col], step, h)
    return ((h % 1000) / 1000.0 - 0.5) * 0.56

def points_in_polygon(xs, ys, vertices):
    inside = np.zeros(len(xs), dtype=bool)
    n = len(vertices)
    if n < 3:
        return inside
    j = n - 1
    for i in range(n):
        xi, yi = vertices[i]["x"], vertices[i]["y"]
        xj, yj = vertices[j]["x"], vertices[j]["y"]
        crosses = (yi > ys) != (yj > ys)
        with np.errstate(divide="ignore", invalid="ignore"):
            xint = (xj - xi) * (ys - yi) / (yj - yi) + xi
        inside ^= crosses & (xs < xint)
        j = i
    return inside
```

Note `ord(c)` vs `charCodeAt`: Python iterates code points; JS iterates UTF-16 units. `jitter_from_id`/`jitter_from_ids` must expand astral code points to surrogate pairs first (`s.encode("utf-16-le")` → uint16 pairs) — annotation ids are hex so this only matters for parity-fixture completeness. NaN coordinates never pass `xs < xint` (NaN comparisons are False) — assert in tests.

- [ ] **Step 1: Write failing tests** — jitter parity against the fixture (`json.load`, `assert value == expected` exact float equality); polygon even-odd cases; NaN exclusion; unknown-category NaN; `resolve_gate_ids` against every fixture gate case.
- [ ] **Step 2: Run** `tox -- test/test_analysis_gating.py` → import error.
- [ ] **Step 3: Implement module**; `axis_coordinates` for property axes walks `values_by_id[id]` through the path, keeps `isinstance(v, (int, float)) and math.isfinite(v)` and rejects `bool`; categorical axes build `{key: index}` from the pinned list and add jitter.
- [ ] **Step 4: Tests + flake8 pass.**
- [ ] **Step 5: Add `"numpy"` to setup.py install_requires. Commit** `feat(backend): pure analysis gating maths with TS parity`

### Task 4: Backend endpoint — `POST /upenn_annotation/analysis/gate_ids`

**Files:**
- Modify: `server/helpers/validation.py` (new constants + `validateAnalysisAxis`, `validateAnalysisGate`, `validateGatePlots`)
- Modify: `server/models/annotation.py` (new method `resolveAnalysisGates(self, datasetId, plots)`)
- Modify: `server/api/annotation.py` (route + handler)
- Test: `test/test_analysis_gating.py` (endpoint section)

**Interfaces:**
- Produces: `Annotation.resolveAnalysisGates(datasetId: ObjectId, plots: list[dict]) -> dict[str, list[str]]`. Route `self.route("POST", ("analysis", "gate_ids"), self.analysisGateIds)`.

Handler shape (API layer):

```python
@access.public(scope=TokenScope.DATA_READ)
@describeRoute(
    Description("Resolve analysis gate polygons to annotation ids.")
    .notes("Pure per-annotation predicates; see SERVER_GATING.md.")
)
def analysisGateIds(self, params):
    body = requireObjectBody(self.getBodyJson())
    datasetId = requireObjectId(body.get("datasetId"), "datasetId")
    Folder().load(
        datasetId, user=self.getCurrentUser(),
        level=AccessType.READ, exc=True,
    )
    plots = validateGatePlots(body.get("plots"))
    return {
        "gateIds": self._annotationModel.resolveAnalysisGates(
            datasetId, plots
        )
    }
```

Model method: collect the union of property paths and the set of categorical keys across plots; run at most two projected reads via `self._aggregate` — annotation collection `{"datasetId": datasetId}` projecting `_id` + needed categorical fields (always `_id`, even for pure property plots, to anchor existence — this is what excludes orphan PV docs); PV collection `{"datasetId": datasetId}` projecting `annotationId` + `values.<path>` per path. Build `values_by_id`, call `helpers.analysis.resolve_gate_ids` per plot.

- [ ] **Step 1: Failing endpoint tests** — happy path (fixture-style data via `AnnotationPropertyValues().appendValues`), per-plot independence, orphan PV doc excluded, empty gate → `[]`, <3 vertices → `[]`, 403 private folder, 404 bad dataset, and one 400 per validator branch (non-list plots, too many plots, bad axis type, bad categorical key, non-numeric vertex, boolean vertex, missing categories on categorical axis, non-null categories on property axis, wrong categoryKeyVersion, oversized vertices list).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement validators (validation.py), model method, route + handler.**
- [ ] **Step 4: tox green (incl. existing suites) + flake8.**
- [ ] **Step 5: Commit** `feat(backend): analysis gate_ids endpoint`

### Task 5: `annotation.contentRevision` (client)

**Files:**
- Modify: `src/store/annotation.ts`
- Test: existing annotation store test file (or `src/store/annotation.test.ts` section)

**Interfaces:**
- Produces: `annotationStore.contentRevision: number`, bumped by one private mutation `bumpContentRevision()` called from every mutation that changes annotation content or membership: `setAnnotations`, `setStubsFromServer`, `setAnnotation`, `setAnnotationsAtIndices`, the add/create commit mutation(s), the delete mutation(s), and tag-update paths. Grep `@Mutation` in annotation.ts and enumerate; the test asserts each named path bumps.

- [ ] **Step 1: Failing test** (drive each mutation with minimal payloads; assert revision strictly increases; assert unrelated mutations — hover, selection — do NOT bump).
- [ ] **Step 2–4: Implement, green, tsc.**
- [ ] **Step 5: Commit** `feat: annotation contentRevision counter`

### Task 6: API client — `fetchAnalysisGateIds`

**Files:**
- Modify: `src/store/AnnotationsAPI.ts`
- Modify: `src/store/model.ts` (request/response types `IAnalysisGatePlotRequest`, `IAnalysisGateIdsResponse`)
- Test: `src/store/__tests__/annotationsAPI.test.ts`

**Interfaces:**
- Produces:

```ts
async fetchAnalysisGateIds(
  datasetId: string,
  plots: IAnalysisGatePlotRequest[],
): Promise<{ [plotId: string]: string[] } | null> {
  if (plots.length === 0) {
    return {};
  }
  try {
    const response = await this.client.post(
      "upenn_annotation/analysis/gate_ids",
      { datasetId, plots },
    );
    return response.data.gateIds as { [plotId: string]: string[] };
  } catch (error) {
    logError("Failed to resolve analysis gates server-side:", error);
    return null; // failure ≠ empty — callers keep same-input state
  }
}
```

- [ ] Steps: failing test (posts body, maps response, returns `null` on rejection, `{}` short-circuit without request) → implement → green → commit `feat: AnnotationsAPI.fetchAnalysisGateIds`.

### Task 7: filters store — server resolution branch above the cap

**Files:**
- Modify: `src/store/filters.ts` (`analysisInputSignature`, `refreshAnalysis`, small helper `serverGatePlotsPayload(plots)`)
- Modify: `src/views/datasetView/Viewer.vue` (300 ms debounce for the server-mode signature; below-cap immediate as today)
- Test: `src/store/filters.test.ts` / `src/store/__tests__/filters.test.ts`, `src/views/datasetView/Viewer.test.ts`

**Interfaces:**
- Consumes: Task 5 `contentRevision`, Task 6 `fetchAnalysisGateIds`, existing `analysisRefreshScope`, `analysisGateGuard`, `setAnalysisGateIds`, `setAnalysisGateDataSignature`.
- Produces: over-cap `analysisInputSignature` = `` `server|${datasetId}|${JSON.stringify(gatePayload)}|${properties.propertyValuesRevision}|${annotation.contentRevision}` `` where `gatePayload` covers `resolutionPlots`' id, axes, and full gate (vertices + categories). `refreshAnalysis` over-cap path: claim token (already first statement) → scope → if no drawn `resolutionPlots`, `clearAnalysisDerivedState()` → compute server signature; if `analysisGateDataSignature !== serverSignature`, drop all gate ids before awaiting → `fetchAnalysisGateIds` → if guard current: `null` → keep same-input ids (retry semantics), else `setAnalysisGateIds(result)` + `setAnalysisGateDataSignature(serverSignature)`.

- [ ] **Step 1: Failing store tests:**
  - over-cap signature ignores filter/population changes; changes when a vertex moves, when contentRevision bumps, when propertyValuesRevision bumps
  - over-cap refresh posts only drawn (and, hidden, enabled) gates; commits pure ids
  - failed fetch after changed inputs leaves gates unresolved; failed identical retry keeps ids
  - stale response (older token) discarded
  - below-cap path byte-identical behavior (existing tests keep passing)
- [ ] **Step 2–4: Implement, green, tsc.**
- [ ] **Step 5: Viewer debounce** — replace the bare watcher callback with a wrapper: server-mode signatures (`startsWith("server|")`) go through `debounce(refresh, 300)`; others call through immediately; test with fake timers.
- [ ] **Step 6: Commit** `feat: server-side gate resolution above the analysis cap`

### Task 8: Panel copy + live verification (Phase 1 close-out)

**Files:**
- Modify: `src/components/AnalysisPanel.vue` (over-cap notice: gates still apply; drawing arrives with heatmaps)
- Modify: `codebaseDocumentation/SERVER_GATING.md` (status), `codebaseDocumentation/ANALYSIS_PANEL.md` (pointer to spec; cap section note)

- [ ] Banner copy + test snapshot update; `pnpm tsc && pnpm lint:ci && pnpm test`; backend `tox`.
- [ ] **Live check (in-browser skill, Xenium 708,983):** persisted gate applies on fresh load; Objects tab + viewer narrow; export respects gate; network-kill during refresh leaves gate intact. Rebuild girder image first (`docker compose build girder && docker compose up -d girder`).
- [ ] Commit `feat: phase 1 — gates apply above the plot cap`.

### Task 9: Backend histogram — helper + `POST /upenn_annotation/analysis/histogram2d`

**Files:**
- Modify: `server/helpers/analysis.py` (`histogram2d(docs, values_by_id, request) -> dict`)
- Modify: `server/helpers/validation.py` (`validateHistogramRequest`, `MAX_HISTOGRAM_BINS`)
- Modify: `server/models/annotation.py` (`analysisHistogram(self, datasetId, spec)` — applies `filters` via the existing list match stages, then upstream gates as predicates, then bins)
- Modify: `server/api/annotation.py` (route `("analysis", "histogram2d")`)
- Test: `test/test_analysis_gating.py`

**Interfaces:**
- Consumes: Task 3 helpers; existing `_annotationDrivenStages` / `validateListInputs` for the `filters` body member.
- Produces: response `{counts, xEdges, yEdges, xCategories, yCategories, inputCount, plottedCount, gateCount}` per spec. Numeric bins: `np.histogram2d` with edges from finite min/max (degenerate → single bin `[v, v]`); categorical: one bin per key at integer index, pinned order extended with unknown keys sorted by encoded key (server-side order rule per spec).

- [ ] Failing tests: numeric×numeric counts + edges; categorical bins & ordering; upstream gate narrows counts; filters narrow counts; `gateCount` matches Phase 1 resolution ∩ input; bins clamped; validation 400s; access 403. → implement → green → commit `feat(backend): analysis histogram2d endpoint`.

### Task 10: shapeToGate + heatmap rendering (client Phase 2)

**Files:**
- Modify: `src/utils/analysisGating.ts` (`shapeToGate(shape, series-or-axes-meta): IAnalysisGate | null` — parses `path` `M/L/Z` SVG strings and `rect` `x0/x1/y0/y1`)
- Modify: `src/store/PropertiesAPI.ts` or `src/store/AnnotationsAPI.ts` (`fetchAnalysisHistogram`) — lives in AnnotationsAPI (endpoint is on upenn_annotation)
- Modify: `src/components/AnalysisScatterPlot.vue` (over-cap heatmap mode: heatmap trace, `dragmode: "drawclosedpath"`, modebar `drawrect`/`eraseshape`, `plotly_relayout` shape capture → `shapeToGate` → `setAnalysisPlotGate`; persisted gate re-rendered as a layout shape; badge from `gateCount`)
- Modify: `src/components/AnalysisPanel.vue` (over-cap: render plots instead of the banner; per-plot histogram fetch — panel-open only, per-plot sequence guard, signature `[axes, bins, upstream gate defs, serializable filters, contentRevision, propertyValuesRevision]`; honesty banner listing inexpressible active filters: ROI, hidden-layers rule, id lists > 50,000)
- Test: `src/utils/__tests__/analysisGating.test.ts`, `src/components/AnalysisScatterPlot.test.ts`, `src/components/AnalysisPanel.test.ts`

- [ ] TDD each: `shapeToGate` parse cases (closed path, unclosed path returns closed polygon, rect, malformed → null); panel fetches only when visible; guard discards stale; banner enumerates skipped filters; heatmap render invoked with counts; drawing commits a gate and clears the drawn shape. → tsc/lint/tests → commit `feat: heatmap display and shape-drawn gates above the cap`.

### Task 11: Phase 2 live verification

- [ ] In-browser on Xenium: open panel above cap → heatmaps; draw closed path → gate chip count appears; viewer narrows; second plot chains; disable/enable gate; theme toggle. GIF-record the draw-gate flow. Commit doc updates (`SERVER_GATING.md` status, regression checklist entries).

### Task 12: Phase 3 backend — gate definitions in list filters

**Files:**
- Modify: `server/helpers/validation.py` (`validateListInputs` accepts optional `analysisGates`, validated with Task 4's validators)
- Modify: `server/models/annotation.py` (`listIds`/`listPage`/`listCount`: when `filters["analysisGates"]` present, resolve each once per request via `resolveAnalysisGates` internals and append `{"_id": {"$in": ids}}` match stages; PV-driven shortcut path must treat gate presence as an annotation-field filter — update `_hasAnnotationFieldFilters`)
- Test: `test/test_server_list.py` additions

- [ ] Failing tests: list/ids/count with a gate definition AND a property filter compose; zero-match gate → zero rows (not 400); gate + idConstraints AND correctly; invalid gate in filters → 400. → implement → tox green → commit `feat(backend): analysis gates as list filter terms`.

### Task 13: Phase 3 frontend — definitions replace id lists

**Files:**
- Modify: `src/store/model.ts` (`IAnnotationListFilters.analysisGates?`)
- Modify: `src/store/annotationListServer.ts` (`buildListFilters`: `analysisGates` input becomes definitions from `filters.analysisPlots` — enabled+drawn+resolved plots' `{xAxis, yAxis, gate}`; stop pushing gate id lists into `idConstraints`)
- Modify: `src/store/filters.ts` (new getter `activeAnalysisGateDefinitions`; new getter `hasEmptyResolvedGate`)
- Modify: `src/utils/annotationListFilters.ts` (`filtersMatchNothing` unchanged for idConstraints; `AnnotationsAPI` short-circuit additionally consults a `matchesNothing` flag passed in the filters build — implement as `buildListFilters` emitting `idConstraints: [[]]`-equivalent sentinel is FORBIDDEN; instead `annotationListServer.queryMatchesNothing` ORs `filters.hasEmptyResolvedGate`)
- Modify: `src/components/AnnotationBrowser/AnnotationList.vue` (refetch watcher: replace `analysisGateSignature` id-hash with definition JSON + `propertyValuesRevision` + `contentRevision`)
- Test: `src/store/__tests__/annotationListServer.test.ts`, `src/store/filters.test.ts`, `src/components/AnnotationBrowser/AnnotationList.test.ts`

- [ ] Failing tests: `buildListFilters` output contains definitions and no gate id constraint; selection/id filters untouched; `queryMatchesNothing` true when any resolved gate is empty (page fetch answers locally with zero rows); watcher refires on vertex change and on revision bumps, not on frame scrub; `currentFiltersSignature` stable across population changes. → implement → green → tsc/lint → commit `feat: send gate definitions to the server list`.

### Task 14: Final sweep

- [ ] Full: `pnpm tsc`, `pnpm lint:ci`, `pnpm test` (mind the `.tox` spec-globbing false-failure note — run before tox or use the documented filter), `tox`.
- [ ] Docs: SERVER_GATING.md status → implemented; regression checklist items all name their tests; ANALYSIS_PANEL.md cross-references; skills: if `nimbus-backend`/`nimbus-geojs` learned anything, edit `.claude/skills/` and run `python3 plugins/nimbusimage/scripts/sync_skills.py --write && ... --check`.
- [ ] Live end-to-end pass above and below the cap (both regimes, fresh loads).
- [ ] Push branch; open PR against `analysis-panel-scatter-gating` (stacked on #1298).

## Self-Review

- **Spec coverage:** pure predicate + unknown-category rule (T1–T4); jitter/category parity + fixture (T2, T3); Phase 1 endpoint + validation + access (T4); client signature/guard/debounce/contentRevision (T5–T7); Phase 2 endpoint + heatmap + honesty banner + badge (T9–T11); Phase 3 definitions + match-none short-circuit + watcher re-point (T12–T13); limits table (T3/T4/T9 validators); test strategy incl. live checks (T8, T11, T14). Gap check: `setup.py` numpy (T3 step 5) ✓; ANALYSIS_PANEL.md invariants each land in a named test ✓.
- **Type consistency:** `fetchAnalysisGateIds` returns `{[plotId]: string[]} | null` (T6) and T7 consumes exactly that; `IAnalysisGatePlotRequest` defined T6, reused T13's `analysisGates` entries; `contentRevision` named identically in T5/T7/T10/T13.
- **Placeholders:** none — every code step names exact behavior or contains the code.
