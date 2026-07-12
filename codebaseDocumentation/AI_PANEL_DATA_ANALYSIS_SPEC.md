# AI Panel — Agentic Data Analysis (Design Spec)

> **Status: implemented and live-verified** on branch
> `claude/ai-panel-data-analysis`, forked from the AI-panel branch
> (`claude/ai-panel-interface-spec-9k6gsv`, PR #1231). Supersedes the
> standalone analysis panel of PR #1221
> (`claude/analysis-panel-agents-mgi32d`), which should be closed once this
> lands.
>
> **Implemented (commits on this branch):** phase 1 — `src/agent/analysis.ts`
> stat helpers + `src/agent/plotRegistry.ts` + `plotly.js-dist-min` dep;
> phases 2-3 — five new executors and the extended `get_property_values` in
> `src/agent/executors.ts`, the tool schemas + "Analyzing data" prompt
> section in the `girder-claude-chat` data files, `kind:"plot"` transcript
> items with `AiPanelPlot.vue` (lazy Plotly), and IndexedDB plot
> persistence. `pnpm tsc` / `lint:ci` clean; 189 `src/agent` + `src/store`
> tests pass.
>
> **Follow-up fixes on this branch** (from live testing):
> - **Live-set intersection** (§2, §5.1) — analysis excludes property values
>   orphaned by deleted annotations; backend cleanup gap filed as
>   [issue #1243](https://github.com/arjunrajlaboratory/NimbusImage/issues/1243).
> - **Hydration guard** — fixed a pre-existing race in `aiPanel.ts` where
>   clearing the conversation during the post-reload IndexedDB hydration could
>   strand the `hydrating` send-guard and silently block all sends (dedicated
>   `hydrationGeneration` counter + regression test).
>
> **Live-verified** against dataset `69f4eb65aaba948c2d7b9b24`: histogram,
> scatter (colorByTag → per-tag WebGL traces), box (groupByTag), and query
> restriction all render inline and read back correct stats. Stats matched
> MongoDB ground truth for the 2,618 live nuclei (Area mean 367.9, std 106.6,
> range 25-975); after the live-set fix the unrestricted scatter shows 2,618
> points (was 5,237 = 2,618 nuclei + 2,619 orphaned values). Confirmed the
> raw-data invariant on the wire (plot tool_results ~23 KB, no raw value
> arrays), conversation + full plot data persisted and re-rendered across
> reload, a mixed analysis→`set_annotation_filter` turn with working revert,
> and that the production build code-splits Plotly into its own 4.6 MB lazy
> chunk.
>
> Companion docs: `AI_PANEL_SPEC.md` (panel architecture),
> `AI_PANEL_REVIEW.md` (review tracker).

## 1. Goal

Let the Nimbus AI panel answer *data* questions about computed annotation
property values — "plot intensity vs area colored by tag and summarize the
correlation", "is the spot-count distribution bimodal?", "compare nucleus
area across my tags" — by giving the existing agent:

1. **Richer statistics** (std, median, quartiles) than today's
   `get_property_values` count/mean/min/max.
2. **Inspection tools** (histogram buckets, sample rows) so it looks at the
   data before drawing conclusions.
3. **Plot-creation tools** (scatter, histogram, box) whose output renders as
   interactive Plotly charts inline in the panel transcript.

PR #1221 built this as a *separate* panel with a *server-side* agent loop.
That PR is used here as inspiration only — its tool semantics, caps, and
Plotly rendering carry over; its architecture does not.

## 2. Why build on the AI panel (and what changes vs PR #1221)

PR #1221 ran the whole agent loop in the Girder plugin because it predated
the panel's frontend loop. On this branch the loop already runs in the
browser (`src/store/aiPanel.ts`), the backend is a stateless relay
(`POST /claude_agent`), and — decisively — **the frontend already holds all
per-annotation property values in memory**:

- `propertyStore.propertyValues` (`src/store/properties.ts:74`) — the full
  `{annotationId → nested values}` map, fetched via the paged
  `annotation_property_values` endpoint (uncapped, `markRaw`).
- `propertyStore.computedPropertyPaths` — every computed value path.
- `annotationStore.annotations` — tags/shape per annotation (for grouping).
- `queryAnnotations` + `validateAnnotationQuery` in
  `src/agent/executors.ts` — the shared annotation-query resolver every
  targeting tool already uses.

So the analysis tools become **plain frontend executors** — no new backend
endpoints, no second agent loop, no new access-control or rate-limiting
surface. The `/claude_agent` relay, gating, transcript, persistence and
per-user rate limits are reused as-is.

**The PR #1221 invariant is preserved**: raw values never enter the model's
context. Plot executors assemble the full Plotly trace arrays *client-side*
and register them in a panel-local plot registry; the model receives only
`{plotId, title, pointCount}` as the tool result. Statistics/histogram
tools return aggregates.

What this buys over #1221's separate panel:

- **One conversation.** Analysis interleaves with interface control:
  "compute area on the nuclei, plot it, then filter the viewer to the top
  decile and color them red" is a single agent turn mixing
  `compute_property`, `create_histogram_plot`, `set_annotation_filter`,
  and `color_annotations`.
- **Query-based restriction for free.** Every analysis tool accepts the
  same `query` object (`tags`/`shape`/`channel`/`currentFrameOnly`/`ids`)
  as `list_annotations`, so "plot intensity of just the spot-tagged
  annotations on this frame" needs no new machinery. #1221 only had
  `color_by_tag`.
- **Existing safety rails**: dataset-identity checks per tool call,
  stop/cancel, conversation persistence, user-change clearing.

Known ceiling (inherited, not added): the analysis operates on the
browser-held annotation/value set, same as the whole app. Server-side
aggregation (the #1221 approach) becomes relevant only if datasets outgrow
frontend memory — see `AI_PANEL_SPEC.md` §4.1. The tool *semantics* here
are chosen to survive that migration (aggregates in, aggregates out).

Scope of "the annotations": analysis is restricted to annotations that
currently exist (the live in-memory set), not to every property-value document.
The two can diverge — the backend leaves property values orphaned after
annotation deletion (issue #1243) — and analysis must reflect real objects, so
the tools intersect with the live set (§5.1). A query narrows within that set;
no query means all live annotations.

## 3. Data flow

```
User: "plot intensity vs area colored by tag"
  └─ aiPanel.sendUserMessage → POST /claude_agent (unchanged relay)
       └─ model calls get_property_values → executor summarizes from
          propertyStore.propertyValues → stats JSON back to model
       └─ model calls create_scatter_plot {xPropertyPath, yPropertyPath,
          colorByTag, title}
            └─ executor: fetchPropertyValues() → resolve paths per
               annotation → group by first tag → build Plotly traces
            └─ plotRegistry.register(plot)          [data stays here]
            └─ tool result to model: {plotId, title, pointCount}
            └─ transcript item {kind: "plot", plotId} → AiPanelPlot.vue
               lazy-imports plotly.js-dist-min and renders the chart
       └─ model writes a short markdown summary referencing plot titles
```

## 4. Tool surface

Six changes to `agent_tools.json` + `src/agent/executors.ts`: one extended
tool, five new. All are **read-only w.r.t. stored data** (plots are panel
state, not dataset state) → **none are gated**, none join
`VIEW_STATE_TOOLS` (revert doesn't remove plots).

Conventions (match the existing surface, not #1221): camelCase input
fields; property paths are **arrays of segments** (`["propId", "subId"]`),
exactly the `propertyPath` arrays that `get_property_values` returns and
`set_annotation_filter.propertyFilters` consumes — the model already knows
this currency. Every numeric result is rounded to 6 significant digits.

### 4.1 Extend `get_property_values` (existing)

Add to each per-path stats entry: `std` (population-of-sample stdev, 0 for
n=1), `median`, `p25`, `p75` (inclusive quantiles on the sorted array), all
rounded. Keep existing fields (`propertyId`, `property`, `path`,
`propertyPath`, `count`, `mean`, `min`, `max` — round `mean`/`min`/`max`
too). The single pass in `executors.ts:1422` gains one sort per path;
arrays are in-memory, this is fine. Update the tool description: "…summary
statistics (count, mean, std, min, max, median, p25, p75)…".

### 4.2 `get_property_histogram` (new)

Binned distribution of one property path, computed client-side with
uniform bins over `[min, max]`.

```jsonc
{
  "name": "get_property_histogram",
  "description": "Get a binned histogram (min, max, count per bucket) for one numeric property value path across annotations, optionally restricted by a query (same shape as list_annotations). Use this to inspect the distribution shape (skew, modality, outliers) of a property before deciding what to plot or conclude. Read-only.",
  "input_schema": {
    "type": "object",
    "properties": {
      "propertyPath": {
        "type": "array", "items": { "type": "string" },
        "description": "Property value path segments, as returned by get_property_values' propertyPath."
      },
      "buckets": {
        "type": "integer", "minimum": 1, "maximum": 200,
        "description": "Number of buckets (default 50, max 200)."
      },
      "query": { "type": "object", "description": "Annotation filter (same fields as list_annotations' query)." }
    },
    "required": ["propertyPath"],
    "additionalProperties": false
  }
}
```

Result: `{ buckets: [{min, max, count}, …], totalCount }`. Empty/all
non-numeric values → `ToolExecutionError` ("no numeric values for path …;
see get_property_values for available paths") so the model can recover.
Constant-valued data (min == max) → single bucket.

### 4.3 `get_sample_values` (new)

```jsonc
{
  "name": "get_sample_values",
  "description": "Get up to n sample rows (annotation id, tags, plus the value for each requested property path) so you can eyeball raw data before drawing conclusions. Rows are sampled evenly across the dataset, not the first n. Read-only; default 20 rows, max 100.",
  "input_schema": {
    "type": "object",
    "properties": {
      "propertyPaths": {
        "type": "array",
        "items": { "type": "array", "items": { "type": "string" } },
        "description": "Property value paths (each an array of segments)."
      },
      "n": { "type": "integer", "minimum": 1, "maximum": 100 },
      "query": { "type": "object", "description": "Annotation filter (same fields as list_annotations' query)." }
    },
    "required": ["propertyPaths"],
    "additionalProperties": false
  }
}
```

Result rows: `{annotationId, tags, "<dotted.path>": value|null}`. Sampling
= every k-th matching annotation id (deterministic `downsample` helper).

### 4.4 `create_scatter_plot` (new)

```jsonc
{
  "name": "create_scatter_plot",
  "description": "Create an interactive scatter plot of one property against another, rendered inline in the panel. Annotations missing a numeric value on either axis are dropped. Optionally color points by each annotation's first tag, and/or restrict annotations with a query. Returns a plotId and point count — the raw points are never sent back to you, they render directly for the user. Refer to the plot by its title in your reply.",
  "input_schema": {
    "type": "object",
    "properties": {
      "xPropertyPath": { "type": "array", "items": { "type": "string" } },
      "yPropertyPath": { "type": "array", "items": { "type": "string" } },
      "title": { "type": "string" },
      "xLabel": { "type": "string", "description": "Optional x-axis label; defaults to the property's full name." },
      "yLabel": { "type": "string" },
      "colorByTag": { "type": "boolean", "description": "One trace per first-tag (untagged grouped together)." },
      "query": { "type": "object", "description": "Annotation filter (same fields as list_annotations' query)." }
    },
    "required": ["xPropertyPath", "yPropertyPath", "title"],
    "additionalProperties": false
  }
}
```

Executor: intersect annotations having numeric values on both paths;
downsample to `MAX_PLOT_POINTS` (50 000) with "(downsampled)" appended to
the title; traces are `scattergl`, `mode: "markers"`,
`marker: {size: 5, opacity: 0.7}`. Result:
`{plotId, title, pointCount, downsampled}`.
Zero overlapping points → `ToolExecutionError` naming both paths' counts.

### 4.5 `create_histogram_plot` (new)

Same binning as `get_property_histogram` (default 50, max 200 buckets),
rendered as a Plotly `bar` trace with bin centers/widths (`bargap: 0`).
Inputs: `propertyPath` (required), `title` (required), `buckets`, `xLabel`,
`query`. Result: `{plotId, title, bucketCount}`.

### 4.6 `create_box_plot` (new)

Inputs: `propertyPaths` (array of paths, required), `title` (required),
`groupByTag` (boolean — valid only with exactly one path: one box per
first-tag), `query`. Each trace's values downsampled to `MAX_BOX_POINTS`
(20 000); trace names are the property full name (or tag). Result:
`{plotId, title, traceCount}`.

### 4.7 Axis-label defaulting

When `xLabel`/`yLabel` is omitted, default to
`propertyStore.getFullNameFromPath(path)` (falls back to the dotted path
if unnamed) — this is what users see elsewhere in the app.

## 5. Frontend design

### 5.1 New module: `src/agent/analysis.ts`

Pure helpers, unit-testable without the store (ports of #1221's Python
helpers):

```typescript
export const MAX_PLOT_POINTS = 50000;
export const MAX_BOX_POINTS = 20000;
export const MAX_HISTOGRAM_BUCKETS = 200;
export const MAX_SAMPLE_ROWS = 100;
export const SIGNIFICANT_DIGITS = 6;

export function roundSignificant(value: number | null): number | null;
// Every-k-th deterministic downsample; returns [items, wasDownsampled].
export function downsample<T>(items: T[], limit: number): [T[], boolean];
// Walk path segments through a nested values object; number | null.
// (typeof === "number" && !isNaN — no boolean hazard in JS.)
export function resolvePathValue(values: any, path: string[]): number | null;
export function computeStats(values: number[]): IPathStats; // mean/std/median/p25/p75/min/max/count
export function uniformHistogram(values: number[], buckets: number): IHistogramBucket[];
```

Plus a `collectPathValues(path, allowedIds)` helper in `executors.ts`
(needs the stores): returns `[annotationId, number][]` by walking a set of
annotation ids and reading `propertyStore.propertyValues[id]`. **It iterates
the query's matches when a query was given (`queryAnnotations`, already
restricted to live annotations), else every id in the live annotation set
(`liveAnnotationIdSet()` = `annotationStore.annotations` ids) — never the raw
`propertyValues` keys.** This matters: property-value documents can outlive
their annotation (a backend cleanup gap leaves values orphaned after
deletion — tracked in
[issue #1243](https://github.com/arjunrajlaboratory/NimbusImage/issues/1243)),
so iterating `propertyValues` directly would count deleted annotations and add
a spurious "untagged" group to tag-grouped plots. The extended
`get_property_values`, `get_property_histogram`, and all three plot tools go
through `collectPathValues`; `get_sample_values` applies the same live-set
intersection inline. Each analysis executor starts with
`await propertyStore.fetchPropertyValues()` — the precedent set by the existing
`get_property_values` executor, and what makes "compute then plot" turns see
fresh values.

### 5.2 New module: `src/agent/plotRegistry.ts`

Plot data must not live in Vuex (large arrays, no reactivity wanted — same
reasoning as `wireMessages`) and executors must not import the aiPanel
store (circular import). A tiny module both sides import:

```typescript
export interface IAgentPlot {
  id: string;          // "plot-<n>", monotonically increasing
  title: string;
  data: unknown[];     // Plotly traces
  layout: Record<string, unknown>; // titles/axis labels only; theming applied at render
}
export function registerPlot(plot: Omit<IAgentPlot, "id">): IAgentPlot;
export function getPlot(id: string): IAgentPlot | undefined;
export function listPlots(): IAgentPlot[];       // for persistence
export function restorePlots(plots: IAgentPlot[]): void; // hydration; keeps id counter ahead
export function clearPlots(): void;
```

### 5.3 Wiring plots into the transcript

- `IToolExecutionResult` (`src/agent/executors.ts`) gains
  `plots?: IAgentPlot[]` alongside the existing `images` channel. Plot
  executors register with `registerPlot` and return the created plot there.
- `aiPanel.executeToolUse` pushes, after the tool card, one
  `{kind: "plot", plotId, text: title}` item per returned plot.
  `IAgentPanelItem` gains `kind: "plot"` and optional `plotId`.
- `clearConversation` calls `clearPlots()`.

### 5.4 New component: `src/components/AiPanelPlot.vue`

Props: `plotId: string`. Direct adaptation of #1221's `AnalysisPlot.vue`:

- Looks up `getPlot(plotId)`; if missing (pruned from persistence), renders
  a muted placeholder: *"This plot wasn't saved — ask the assistant to
  recreate it."*
- Lazy `import("plotly.js-dist-min")` inside the render call so Plotly
  (~1 MB gzipped) never lands in the main bundle; module-level cache;
  handle the CJS interop (`module.default ?? module`).
- Layout: `autosize`, height 300, tight margins, transparent
  paper/plot background, font color from
  `theme.current.value.colors["on-surface"]`, then spread the registered
  plot's own layout. Config `{responsive: true, displaylogo: false}`.
- Render once on mount (registry entries are immutable — no deep watch,
  unlike #1221). `Plotly.purge` on unmount.
- Errors → `logError` + placeholder text, never a crash in the transcript.

`AiPanel.vue` template gains one branch:
`<ai-panel-plot v-else-if="item.kind === 'plot'" :plot-id="item.plotId!" />`
styled `align-self: stretch`. Panel dimensions unchanged (plots ~470 px
wide is fine for v1); a click-to-enlarge `v-dialog` is optional polish.

### 5.5 Persistence (`src/agent/conversationStore.ts`)

`IStoredAgentConversation` gains `plots?: IAgentPlot[]`. On save
(`aiPanel.sendUserMessage` finally-block), include `listPlots()` subject
to caps; on hydrate (`handleAuthenticatedUserChange`), `restorePlots`.
Caps, applied at save time:

- Keep only plots referenced by a current item, newest-first, max
  `MAX_STORED_PLOTS = 12`.
- Skip any single plot whose `JSON.stringify` length exceeds 3 000 000
  chars (a 50k-point scatter is ≈1.5 M — fits; a many-trace monster
  doesn't).

Dropped plots simply hit the `AiPanelPlot` placeholder after reload —
never an error. The wire conversation is unaffected (tool results only
ever contained `{plotId, …}`), so `pruneOldScreenshots` needs no changes.

### 5.6 `describeAgentToolCall` entries

Human-readable one-liners (guarding all field access, as the function
requires): `get_property_histogram` → `Read histogram of <dotted path>`;
`get_sample_values` → `Read N sample values`; `create_scatter_plot` →
`Create scatter plot "<title>"`; likewise histogram/box. Tool-card
`detail` via `toolResultDetail`: add a `pointCount` case ("12,340
points").

### 5.7 Dependency

`plotly.js-dist-min ^3.6.0` (dependencies) + the one-line ambient module
declaration `src/plotly-dist-min.d.ts` (both exactly as in PR #1221).
`dompurify`/`marked` are already on this branch via
`utils/renderMarkdown.ts` — no change.

## 6. Backend changes

**No Python changes.** Two data files in
`devops/girder/plugins/girder-claude-chat/girder_claude_chat/`:

1. `agent_tools.json` — the five new tool definitions + the updated
   `get_property_values` description (§4).
2. `agent_system_prompt.txt` — add one "Analyzing data" section after the
   "Reading data efficiently" section:

   ```
   Analyzing data:
   - For data-analysis requests ("plot X vs Y", "how is X distributed",
     "compare X across tags"), inspect before you conclude: use
     get_property_values (statistics) and get_property_histogram; use
     get_sample_values if you need to eyeball raw rows.
   - Then create plots with create_scatter_plot / create_histogram_plot /
     create_box_plot — they render as interactive charts in the panel, so
     favor creating a plot over describing one. Typically 1-3 plots.
     All plot tools accept the same query filter as list_annotations,
     so plot exactly the subset the user asked about.
   - Property paths for all analysis tools are the propertyPath arrays
     returned by get_property_values.
   - Refer to plots by their title in your summary, and finish with a
     concise quantitative summary. If a property is missing or
     non-numeric, say so rather than fabricating results.
   ```

**Deployment note:** the plugin is baked into the Girder image — after
editing either file, `docker compose build girder && docker compose up -d`
(a restart is not enough) before live testing.

## 7. Explicitly out of scope (v1)

- **Server-side aggregation endpoints** — the browser already holds the
  values; revisit only when datasets outgrow frontend memory
  (`AI_PANEL_SPEC.md` §4.1).
- **A separate analysis panel / endpoint** — PR #1221's
  `claude_analysis` endpoint, `AnalysisPanel.vue`, `AnalysisAPI.ts` are
  superseded; that PR gets closed, not merged.
- **Other plot types** (violin, heatmap, line/time-series) — the plumbing
  (registry → AiPanelPlot) makes each a small executor + schema addition
  later. Time-series over T using annotation location is the most likely
  next ask.
- **Plot export** (PNG/CSV download) — Plotly's modebar already gives
  camera-icon PNG export for free; nothing custom.
- **Derived/computed columns** (ratios, log transforms) — that's the
  code-execution tier (Option B in `AI_PANEL_SPEC.md` §5), not curated
  tools.

## 8. Implementation plan (subagent-sized tasks)

Sequential phases; each leaves `pnpm tsc && pnpm lint:ci && pnpm test`
green. Suggested delegation in brackets — anything touching
`executors.ts`/`aiPanel.ts` semantics should be Sonnet-or-better; pure
ports and tests can go lower.

**Phase 1 — helpers + registry (no behavior change).** [sonnet, or haiku
with review] Create `src/agent/analysis.ts` (§5.1) and
`src/agent/plotRegistry.ts` (§5.2) with unit tests
(`analysis.test.ts`, `plotRegistry.test.ts`): stats vs hand-computed
values (incl. n=1, empty), downsample determinism and size bound,
histogram edge cases (constant values, single bucket, empty), rounding.
Add the `plotly.js-dist-min` dependency + `src/plotly-dist-min.d.ts`
(`pnpm install` to update the lockfile).

**Phase 2 — executors + tool definitions.** [sonnet] In
`src/agent/executors.ts`: `collectPathValues` helper; extend
`get_property_values` stats; add the five executors (§4) returning
`plots` in `IToolExecutionResult`; extend `describeAgentToolCall` and
export types. Update `agent_tools.json` and `agent_system_prompt.txt`
(§6). Extend `executors.test.ts` following its existing mock patterns
(reactive store mocks — see the AnnotationViewer-harness notes): stats
correctness through the executor, query restriction via `queryAnnotations`,
error paths (unknown path, zero numeric values, `groupByTag` with two
paths), downsampling trigger, plot registration side-effect.

**Phase 3 — panel UI + persistence.** [sonnet] `AiPanelPlot.vue` (§5.4);
`AiPanel.vue` plot branch; `aiPanel.ts` (`kind: "plot"` items, push plots
from `executeToolUse`, `clearPlots` on clear, save/hydrate plots per
§5.5); `conversationStore.ts` record field. Unit-test the persistence
caps (drop-beyond-12, oversize skip) in `conversationStore.test.ts`.

**Phase 4 — live verification.** [main session — browser tools] Rebuild
the girder container (§6 note). On
`http://localhost:5173/#/datasetView/69f4eb85aaba948c2d7b9da5/view`:

1. If the dataset has no computed properties yet, drive the agent's own
   `create_property`/`compute_property` flow first — that's the intended
   end-to-end story.
2. "How is <property> distributed?" → expect stats + histogram tool calls,
   an inline histogram plot, and a summary that matches the numbers.
3. "Plot <propA> vs <propB> colored by tag" → scatter with per-tag traces,
   correct axis labels, legend; hover works; model reply references the
   plot title and does not enumerate raw values (check the wire request in
   devtools network tab: tool_result for the plot is just the small JSON).
4. "Compare <property> across tags" → box plot.
5. Restriction: "…only for the spot-tagged annotations" → point count in
   the tool card matches the tag count from `get_annotation_summary`.
6. Reload the page → conversation restores, plots re-render from
   IndexedDB (and a >12-plots session shows placeholders for the oldest).
7. Clear conversation → plots gone; switch user → gone.
8. Mixed turn: "plot area, then filter the viewer to annotations with area
   above the median and color them red" — analysis + interface tools
   cooperating in one turn.

Also verify the Plotly chunk is absent from the initial bundle
(`pnpm build` output / network tab: plotly chunk loads only when the first
plot renders).

## 9. Resolved decisions & open questions

**Resolved during implementation:**

- **Tag grouping uses the first tag only** (kept — #1221 behavior, bounds the
  trace count). A multi-tag annotation appears once, under its first tag. An
  explicit `groupByTags: string[]` (one trace per listed tag, membership-based,
  annotations may repeat) stays a later schema-compatible addition if this
  proves confusing; not doing it now.
- **Orphaned property values are excluded** (§2 "Scope", §5.1). Live testing
  surfaced a spurious "untagged" group in tag-grouped plots: property-value
  documents for deleted annotations that the backend never cleaned up
  (~2,619 of 5,237 on the test dataset). Fixed client-side by intersecting with
  the live annotation set; the backend data-hygiene bug is filed as
  [issue #1243](https://github.com/arjunrajlaboratory/NimbusImage/issues/1243)
  and is independent of this feature.

**Still open:**

1. **Should plot tools auto-refresh values?** They call
   `fetchPropertyValues()` per call (matching `get_property_values`);
   on very large datasets several calls per turn re-download the value
   pages. If this shows up in practice, add a per-turn fetch memo in the
   executor context rather than changing tool semantics.
2. **Correlation/regression tool?** A `get_correlation` (Pearson/Spearman
   for two paths) would ground "summarize the correlation" numerically
   instead of the model estimating from a plot it cannot see. Cheap to add
   in `analysis.ts`; deferred to keep v1 minimal — the stats tools already
   prevent outright fabrication.
