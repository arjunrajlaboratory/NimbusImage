# Unroll navigation (#1280) — follow-up review findings

Review of `fix/issue-1280-unroll-navigation` after the round 3 fixes.

| # | Severity | Location | Summary | Status |
|---|---|---|---|---|
| 1 | Low | `src/__tests__/regressionChecklist.test.ts` | Per-root probes searched the combined source set, so another root could satisfy a broken root | fixed (this commit) |
| 2 | Nit | `src/utils/__tests__/annotationNavigation.test.ts` | The unroll test preamble incorrectly said Time filtering always relaxes | fixed (this commit) |

## Finding 1 — verified real

`allTestSources()` included the regression-checklist test itself, which contains
every `knownTest` literal. As a result, each per-root assertion could pass even
if its root matcher found no files. Test sources are now cached and checked per
configured root, and a regression test proves a deliberately broken backend
matcher cannot resolve its probe from another root. The combined source set used
for checklist citations is built from those independently scanned roots.

## Finding 2 — verified real

The preamble contradicted the paired tests and implementation below it: an
unrolled Time axis relaxes the time window only when the timelapse overlay is
off. With the overlay on, its visible window remains authoritative. The comment
now states both modes explicitly.

## Pattern sweep

- Other `knownTest` checks use the same corrected per-root helper; checklist
  citation resolution still intentionally searches the combined owned sources.
- The feature documentation and production navigation comments already describe
  the overlay-dependent Time rule correctly. The stale test preamble was the
  only unconditional wording in the branch.
