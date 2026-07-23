# Annotation Browser Configuration Review

Tracker for review feedback on PR #1266.

## P2 — Hydrated histogram ranges are overwritten

- **Location:** `src/components/AnnotationBrowser/AnnotationProperties/PropertyFilterHistogram.vue`
- **Summary:** A restored filter is initially treated as though it still uses the
  histogram defaults, so the asynchronous histogram load can replace its saved
  range.
- **Status:** fixed

## P2 — Chat-created filters are omitted from configuration persistence

- **Location:** `src/utils/annotationBrowserConfig.ts`
- **Summary:** Filters without a visible Annotation Browser row are not serialized.
- **Status:** by-design — chat-created filters are session-only; only filters with
  a visible Annotation Browser row belong in configuration metadata.

## Simplification — Filter rows should own their filters

- **Location:** `src/store/filters.ts`,
  `src/components/AnnotationBrowser/AnnotationProperties/PropertyFilterHistogram.vue`,
  `src/store/index.ts`
- **Summary:** Removing a row currently leaves a disabled orphan filter through a
  component unmount hook. Re-enable and transition guards then compensate for that
  lifecycle mutation. Remove the filter with its row in the store instead, and
  simplify the resulting save/transition flow.
- **Status:** fixed
