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

## Finding 5 — Selection panels unreachable behind the AI panel

- **Severity:** High
- **Location:** `src/components/AnnotationActionPanel.vue`,
  `src/components/ConnectionActionPanel.vue`
- **Summary:** Moving the selection panels clear of the Timelapse palette
  (Finding 4's neighbour fix) keyed the new right-edge offset off a single
  `object-browser-open` class. The Object Browser is not the only overlay that
  holds the right edge: `.ai-panel` is `z-index: 2001` against the panels' 1000
  and is mutually exclusive with neither timelapse mode nor the Browser. So the
  panels moved out from under the Timelapse palette and straight under the AI
  panel. Measured live at 1684×857 with timelapse on, AI panel open and a
  selection: `.action-panel` 171×138px covered, `.connection-action-panel`
  206×103px covered, and **6 of the two panels' 8 buttons failed
  `elementFromPoint`** — including `Deselect All`, the only non-destructive way to
  dismiss them, leaving two reachable buttons that both delete things.
- **Status:** fixed — `rightEdgeClearX()` in `@/utils/paletteGeometry` resolves
  the max over every open right-edge overlay and App.vue projects it as
  `--nimbus-right-edge-clear-x`, so each panel needs one CSS rule instead of one
  per overlay combination. Verified live: `rightVar` 556px, panels at x 953–1128,
  `overlapsAI=false`, **0 blocked buttons** with the AI panel open and with both
  it and the Browser open (the offset takes 556 over 544, not their sum).
- **Found by:** self-review of the branch (`/branch-review`).

## Finding 6 — Track swatches shown outside timelapse mode

- **Severity:** Low
- **Location:** `src/components/AnnotationBrowser/ConnectionList.vue`
- **Summary:** `showTrackSwatches` was gated on the colouring option but not on
  the mode, while `trackColor` is reached only from the timelapse draw path. With
  the mode off the swatch therefore named a colour nothing on the canvas used —
  measured, 248 swatches in 248 distinct hues against zero drawn connection
  features (a timelapse link's endpoints sit on different timepoints, and normal
  mode never co-displays them). And they could not be switched off, because the
  only control that hides them lives in the Timelapse palette, which *is* the
  mode. This is the pair the branch had already written into
  `CONNECTION_LIST.md` ("a track's colour in the viewer | its swatch in the
  Connections tab") and then missed on the mode gate.
- **Status:** fixed — gated on `timelapseStore.showMode` as well. Verified live:
  248 track rows throughout, swatches 248 → 0 → 248 across a mode toggle.
- **Found by:** self-review of the branch (`/branch-review`).

## Finding 7 — Delete-all guarded on a different set than it deletes

- **Severity:** Low
- **Location:** `src/components/TimelapsePanel.vue`
- **Summary:** The button's `disabled` used the total connection count, but
  `deleteAllTimelapseConnections` only deletes `TIMELAPSE_CONNECTION_TAG` ones.
  On a dataset whose connections are all hand-made or from Connect-to-nearest the
  button was enabled, the click deleted nothing, and nothing was reported. The
  old Navigator button had no guard at all, so the guard was new here — it just
  counted the wrong set.
- **Status:** fixed — a separate `timelapseTaggedCount` drives the guard; the
  readout keeps the dataset-wide total on purpose, since the timelapse view draws
  every connection whose endpoints are displayed regardless of tag.
- **Found by:** self-review of the branch (`/branch-review`).

## Finding 8 — Timelapse state in the main store module

- **Severity:** Low
- **Location:** `src/store/index.ts`
- **Summary:** Six timelapse fields and their seven mutations had accumulated in
  `src/store/index.ts`, against the guideline that a distinct feature area gets
  its own focused module rather than growing the 2000-line main one. Deferred
  through two review rounds as a large behaviour-neutral edit to this feature's
  main safety net, then explicitly requested.
- **Status:** fixed — extracted to `src/store/timelapse.ts` (`showMode`,
  `modeWindow`, `tags`, `showLabels`, `trackColoring`, `colorSeed`). Mechanical
  because none of it is persisted: no `syncConfiguration` or dataset-view path
  touches these fields, so there was nothing to re-point but readers.
  `annotationBrowserTab` and `isAnnotationPanelOpen` deliberately stayed —
  they are panel-visibility state that App.vue owns alongside the other palette
  flags, not timelapse state.
- **Verification:** the risk here was the test harness, not the source. The new
  `@/store/timelapse` mock must be `reactive()` or every timelapse draw test
  passes against a layer that was never rebuilt. Confirmed by breaking it:
  a plain-object mock fails 6 tests including both colouring-watch tests.
  Then live, driving the new module's mutations from a fresh page load —
  mode off 0 points / 0 segments; on 1,966 / 1,714 in 119 colours; uniform the
  same counts in **1** colour; shuffle 120 colours with the sampled hue changed;
  window 30 → 2,728 / 2,488. `main` retains no timelapse field, and
  `timelapse-palette-open` still tracks the mode.
