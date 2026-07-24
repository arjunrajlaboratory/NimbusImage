# Review Findings: stub-mode click-to-list navigation (anchorId)

Branch: `claude/annotation-click-navigation-3ikbfj` — Codex fix reviewed by Claude
(/branch-review) on 2026-07-17. Feature: clicking an annotation in the image
viewer navigates the server-mode (stub) annotation list to the page containing
that annotation, via a new `anchorId` option on `POST /upenn_annotation/list`.

## Finding 1: `?? query.offset` fallback masks a stale backend

- **Severity:** Medium — Frontend compensating for backend
- **Location:** `src/store/AnnotationsAPI.ts` (`fetchAnnotationListPage` offset mapping)
- **Problem:** The `?? query.offset` branch only fires against a backend that
  doesn't return `offset` (an outdated one). Against a stale backend an anchor
  request would resolve `offset: 0` and navigate to page 1 — recreating the
  original bug instead of no-op'ing.
- **Fix:** `offset: response.data.offset` with no fallback.
- **Status:** fixed (working tree, 2026-07-17)

## Finding 2: non-`_id` sorts pay a full filtered-set window walk per click

- **Severity:** Low — Performance
- **Location:** `server/models/annotation.py` (`listPosition` window path)
- **Problem:** `$setWindowFields` sorts the entire filtered set (lookup join
  included for property sorts) on every click for field/property-sorted lists —
  on exactly the 100K+ datasets that trigger stub mode.
- **Fix:** Fetch the anchor's normalized sort value inside the filtered set,
  then count rows sorting strictly before it with a single `$expr` match
  (no sort, no window, no disk spill). `$ifNull` normalization keeps
  missing==null equivalence identical to `$sort` semantics; property sorts
  compare `(_hasSortValue, _sortValue, _id)` explicitly.
- **Equivalence guard:** `assertAnchorPagesSelfConsistent` test helper — for
  every annotation, the anchor page must be page-aligned, contain the anchor,
  and equal the plain offset-paged request at the returned offset. Exercised
  over desc sorts, `_id` ties, missing `name` values, property sorts with and
  without values, and property filters. All new tests were verified to pass
  against the window implementation BEFORE the swap.
- **Status:** fixed (working tree, 2026-07-17)

## Finding 3: `fetchPageContaining` duplicates `fetchPage` scaffolding

- **Severity:** Nit — Code duplication
- **Location:** `src/store/annotationListServer.ts`
- **Problem:** Both actions rebuild the same query object (filters, sort,
  propertyPaths, limit).
- **Fix:** Shared query-base getter spread by both actions.
- **Status:** fixed (working tree, 2026-07-17)

## Finding 4: user pagination clicks dropped while an anchor page mounts

- **Severity:** Nit — UX / pattern
- **Location:** `src/components/AnnotationBrowser/AnnotationList.vue`
  (`suppressServerOptions` in `onServerOptions`)
- **Problem:** While the boolean suppression is active (fetch + row-mount wait,
  worst case ~1.5 s), a genuine user pagination click is silently swallowed —
  the suppression can't tell it apart from Vuetify's stale options echo.
- **Fix:** Snapshot the pre-navigation options when navigation starts. Drop
  only an options event equal to the snapshot (the stale echo); any other
  event is user intent — cancel the navigation and process it normally.
  (Options matching the store state are still absorbed first, so a
  post-navigation reconcile echo of the NEW options stays a no-op.)
- **Status:** fixed (working tree, 2026-07-17)

## Live verification (2026-07-17, Xenium 708,983-annotation dataset)

Girder image rebuilt (not restarted — plugin is baked in). Verified in a
foreground browser tab against stub mode (`stubOnlyMode: true`, total 708983):

- **Backend anchor resolution:** `_id`-sort anchor at true offset 500000 →
  returned offset 500000 in 0.27 s; `location.XY`-sort anchor at true offset
  400000 → returned offset 400000, page-aligned, contains anchor, 1.9 s (range
  count, no full-set sort). Cross-checked the anchor page equals the plain
  offset-paged request.
- **Injected-hover navigation (Finding 1/2/3 path):** setting
  `hoveredAnnotationId` to the offset-500000 anchor moved the list page 1 →
  50001; DOM footer read "500001-500010 of 708983"; anchor row highlighted and
  scrolled to top.
- **Real click (full chain):** clicking an annotation dot set
  `hoveredAnnotationId` and navigated the list page 1 → 29335; anchor present in
  rendered rows (position 0) with a `tr.is-hovered` highlight in the DOM.
- **Normal pagination (Finding 4 regression):** real-click "next" advanced
  50001 → 50002; clearing the hover did not spuriously navigate.

Gates: flake8 clean; 305 backend tests pass; 2651 frontend tests pass; `pnpm
tsc` and `pnpm lint:ci` clean.

**Not committed** — awaiting user sign-off.
