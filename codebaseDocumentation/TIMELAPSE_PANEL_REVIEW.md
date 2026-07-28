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
- **Status:** fixed — `resolvableTrackObjectIds` filters through
  `connectionListStore.resolveAnnotation`, and the menu's "Objects (N)" count
  reports the filtered total. Tests: *"excludes endpoints that no longer
  resolve"*, *"counts nothing selectable when every endpoint is dangling"*.

## Finding 3 — Icon-only color controls need accessible names

- **Severity:** Low
- **Location:** `src/components/TimelapsePanel.vue`
- **Summary:** Track-color controls must expose accessible names independently
  of their tooltips.
- **Status:** fixed — each of the three icon-only controls now carries an
  `aria-label` alongside its `v-tooltip`; a tooltip is a hover affordance and
  announces nothing for an icon-only button.

## Finding 4 — Object selection invisible in timelapse mode

- **Severity:** High
- **Location:** `src/components/AnnotationViewer.vue`
  (`drawTimelapseAnnotationCentroidsAndLabels`)
- **Summary:** The timelapse centroid dots were drawn white/black with no
  selection or hover branch, and `restyleAnnotations` only ever touches
  `annotationLayer` — so they had no restyle route of any kind. Selecting a
  track's objects changed nothing on screen while its links did light up, which
  reads as "Select picked the connections instead of the objects". Measured:
  selected dot `stroke black / width 1 / fillOpacity 0.5`, identical to every
  unselected dot; outside timelapse mode the same selection styled its feature
  `rgb(1,0,0)` vs `rgb(0.75,0,0)`.
- **Status:** fixed — points carry a `timelapsePointBaseStyle`,
  `getTimelapsePointStyle` adds selected/hovered branches in the same cyan as
  selected segments, and `restyleTimelapseFeatures` repaints them in place off a
  `watch([selectedAnnotationIds, hoveredAnnotationId])`. Verified live: 8/8 and
  22/22 drawn dots turn `#00e5ff`, unselected dots stay black, deselection
  restores the exact original style, and the same feature objects are reused
  (1,425 points before and after — no rebuild).
- **Found by:** user report, reviewing the per-track Select action.
