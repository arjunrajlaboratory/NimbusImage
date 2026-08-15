# Property UX branch review

Branch: `property-ux-mockups`
Base: `master`
Review scope: branch diff, focused unit tests, full frontend gates, and live UI
inspection on the large local dataset.

## Findings

### F1 — Compute all issues one API request per property

- Severity: medium
- Location: `src/components/AnnotationBrowser/AnnotationProperties/ComputeAllStatus.vue`
- Summary: the local-dataset “Compute all” action loops through properties and
  submits one HTTP request/job at a time from the client. Large property sets
  amplify request overhead and permit partial client-side submission.
- Status: fixed in two stacked PRs. The frontend PR consolidates Compute-all
  into one store action (`propertyStore.computeProperties`) with full
  lifecycle guarantees while still submitting per property, so it deploys
  without a Girder rebuild. This backend PR adds
  `POST /annotation_property/compute` — which validates all input, checks
  dataset WRITE access, and batch-loads READ-accessible properties with one
  permission-aware query before scheduling — and switches the client to a
  single request.

### F2 — Property-value menus and bulk visibility are unbounded

- Severity: medium
- Location: `src/components/AnnotationBrowser/PropertyChipStrip.vue`,
  `src/components/AnnotationBrowser/MeasurementsTab.vue`, and
  `src/store/properties.ts`
- Summary: every discovered value is rendered, while Show all / Hide all call
  the singular toggle once per path. Each toggle scans and replaces the full
  displayed-path array, and Show all can create an impractical number of table
  columns.
- Status: fixed — this remediation commit. A store-level 100-column invariant
  now applies to hydration, singular toggles, and batch updates; Show all / Hide
  all issue one mutation/save; both value surfaces use `VVirtualScroll`; and
  the UI explains when the limit is reached.

### F3 — Compute failures can strand a property in the running state

- Severity: medium
- Location: `src/store/properties.ts` and `src/utils/propertyCompute.ts`
- Summary: submission failures, responses without a job id, and post-job
  refresh failures do not share a guaranteed cleanup path. The helper also
  discards the returned promise, permitting unhandled rejections.
- Status: fixed — this remediation commit. Singular and local batch compute
  share a non-rejecting completion finalizer. Submission, missing-job, job-
  tracking, worker-failure, and value/histogram-refresh failures all surface an
  error and clear both progress systems in a guaranteed terminal path.

### F4 — Measurement controls lack complete keyboard and accessible-name support

- Severity: low
- Location: `src/components/AnnotationBrowser/MeasurementsTab.vue` and the
  symmetric checklist in `src/components/AnnotationBrowser/PropertyChipStrip.vue`
- Summary: clickable group headers are non-semantic divs, checklist controls
  have no accessible names, and a running Run button replaces its only text
  with an unlabeled spinner.
- Status: fixed — this remediation commit. Measurement expansion uses native
  buttons with `aria-expanded`; checkbox inputs receive state-aware labels;
  and Run keeps a stable accessible name, disabled state, and `aria-busy`
  while its visible content is a spinner.

### F5 — Compute entry points have drifted

- Severity: low
- Location: `src/components/AnnotationBrowser/AnnotationProperties/Property.vue`
  and `src/components/AnnotationBrowser/AnnotationProperties/PropertyCreation.vue`
- Summary: the new shared status/error helper is used by the Measurements tab
  and Compute all, but older property compute entry points still reproduce the
  setup directly.
- Status: fixed — this remediation commit. Measurements, the legacy property
  Run button, and compute-on-create all use `computePropertyWithStatus`; only
  the deliberately distinct batch/pipeline store paths call compute actions
  directly.

## Decisions

- Displayed property columns are capped at 100. This is a UI safety boundary,
  not a backend data limit; users can filter and choose a different subset.
- One batch-compute request accepts at most 100 properties. The endpoint still
  creates one worker job per property, but it validates access and submits the
  group through one HTTP request.

## Regression checklist

Tests are added as each finding is resolved; every completed item must name the
test that holds the invariant.

### Compute submission and lifecycle

- [x] Compute all goes through one store action with a bounded per-run set —
      _"computeUncomputedProperties submits the group through one store action"_
      and _"submits at most 100 properties so the client matches the server
      limit"_.
- [x] Compute all uses one client request and the batch endpoint permission-
      checks properties without looped loads —
      _"submits every property in one request"_,
      _"testComputeMultipleSubmitsAllPropertiesInOneRequest"_,
      _"testComputeMultipleValidatesEveryPropertyBeforeSubmitting"_, and
      _"testComputeRequiresDatasetWriteAccess"_.
- [x] Submission, missing-job, worker-failure, and refresh-failure paths always
      clear running/progress state and surface an error —
      _"cleans up and surfaces an API submission failure"_,
      _"cleans up and surfaces a response without a job id"_,
      _"cleans up and surfaces job tracking failures"_,
      _"cleans up and surfaces post-job refresh failures"_,
      _"surfaces worker failure when job completes unsuccessfully"_,
      _"cleans up batch state when the batch API rejects"_,
      _"cleans up batch state when the server omits a job"_, and
      _"returns the store promise so callers can observe completion"_.
- [x] Every non-batch UI entry point goes through the shared compute helper —
      _"compute uses the shared status-aware helper"_ and
      _"createProperty toggles visibility and computes upon creation"_.

### Property-column cost

- [x] Bulk show/hide performs one store update/save and never exceeds the
      100-column ceiling —
      _"shows many paths with one mutation/save and caps the result at 100"_,
      _"hides a group with one save instead of one toggle per path"_, and
      _"clamps over-limit paths restored from configuration"_, and
      _"rejects a singular addition when the column limit is already full"_.
- [x] Large property-value lists render through a bounded/virtualized surface —
      _"renders multi-value menus with virtual scrolling"_ and
      _"renders expanded property values with virtual scrolling"_.

### Accessibility

- [x] Measurement groups are keyboard-expandable, checkboxes have accessible
      names, and running buttons retain a stable accessible name —
      _"uses a semantic expand button with aria-expanded state"_,
      _"gives value checkboxes descriptive accessible names"_,
      _"keeps a stable accessible name and disables Run while computing"_, and
      _"gives every value checkbox a descriptive accessible name"_.

## Verification

- `pnpm tsc --pretty false`
- `pnpm lint:ci`
- `pnpm test --run --reporter=dot --silent=passed-only` — 207 files and 3,676
  tests passed.
- `pnpm build` — passed with the repository's existing dynamic-import and
  large-chunk warnings.
- Full backend `tox` — 530 tests passed; the final property/task-focused rerun
  after the last backend edits passed 24 tests.
- Targeted backend `flake8` on the property API, model, and tests.
- Rebuilt and restarted Girder; an authenticated empty batch request to
  `/annotation_property/compute` returned `[]` and created no jobs.
- Hard-reloaded the 708,983-object local dataset after the backend rebuild.
  Keyboard expansion, both virtualized property-value surfaces, named
  checkboxes, and named Run buttons passed live inspection with no console
  errors.
