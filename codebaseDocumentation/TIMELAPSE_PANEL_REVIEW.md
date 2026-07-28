# Timelapse Panel Review

Branch: `feature/timelapse-panel`
Base: `master`

## Finding 1 — Scope-dependent track color identity

- **Severity:** Medium
- **Location:** `src/components/AnnotationBrowser/ConnectionList.vue:346`
- **Summary:** Scoped track rows and the displayed timelapse subset can choose
  different minimum member ids for the same dataset-wide track, so the list
  swatch can disagree with the rendered line and change when scope changes.
- **Status:** fixed — working tree, uncommitted
- **Implementation constraint:** Derive identity from the current
  `annotationConnections` array. Do not add persistent track entities. Reuse
  one cached global connected-component analysis for track count, list
  swatches, and viewer colors so scope changes and time scrubbing do not repeat
  the global traversal.
- **GitHub thread:** [PR #1288 discussion](https://github.com/arjunrajlaboratory/NimbusImage/pull/1288#discussion_r3661945090)

## Finding 2 — Select track includes dangling endpoint ids

- **Severity:** Medium
- **Location:** `src/components/AnnotationBrowser/ConnectionList.vue:362`
- **Summary:** Selecting a track copies every endpoint id, including endpoints
  that no longer resolve to an annotation or stub.
- **Status:** open — not selected for this pass

## Finding 3 — Icon-only color controls need accessible names

- **Severity:** Low
- **Location:** `src/components/TimelapsePanel.vue`
- **Summary:** Track-color controls must expose accessible names independently
  of their tooltips.
- **Status:** open — not selected for this pass
