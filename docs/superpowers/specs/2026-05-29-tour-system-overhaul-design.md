# Tour System Overhaul — Design

**Date:** 2026-05-29
**Branch:** `tours/overhaul`
**Status:** Approved design (pre-implementation)

## Problem

Many guided tours are broken. A static diagnostic of all 8 tours against the
codebase found that the breakage is **not** in the tour engine — it is in the
project's own anchor contract and glue layer, made worse after repeated UI
changes.

### Evidence from the diagnostic

- **11 of 42 active element selectors resolve to no anchor in source.** Two
  sub-classes:
  - **Hard-removed/renamed UI chrome** (4 anchors): `measure-objects-button`,
    `measure-objects-close-button`, `properties-header`, `properties-content`.
    These live in the two largest tours (`CalculateBlobMetrics`,
    `WelcomeTourHome`) and appear consecutively, so the tour fast-forwards
    through a dead zone.
  - **Data-dependent dynamic ids** (~7 anchors): `blob`, `dapi-blob`,
    `nucleus`, `gaussian-blur`, `sigma`, `my-first-nimbus-dataset`,
    `parent-tag`. These are generated at runtime by `getTourStepId(name)` in
    `src/utils/strings.ts` from tool/tag/param/Zenodo-title strings, so they
    only exist when the current dataset contains an entity with that exact name.
- **Routes are fine.** All five referenced route names (`root`, `datasetview`,
  `newdataset`, `dataset`, `multi`) exist in the router.
- **The glue turns one missing anchor into a cascading silent failure.** In
  `tour.ts` `checkCurrentStep()`, a `waitForElement` timeout is caught and
  silently does `currentStepIndex++` then recurses — so a missing element
  skips, and consecutive missing elements cascade, with no UI feedback.
- **Multi-route tours stall silently.** On route mismatch, `checkCurrentStep()`
  returns and does nothing; there is no `router.push` to the expected route, so
  the tour dead-ends unless the user performs the exact triggering action.
- **Short default waits.** Default `waitForElement` is 1000 ms; heavy views
  (`datasetview` while images load) race the timeout and skip.
- **Stringified-JS hooks.** `beforeShow`/`onNext` are stored as strings run via
  `new Function()`. They are unused beyond `console.log` debug lines in one test
  tour — a CSP/security smell with no real usage.

### Engine landscape (deep research, 25 verified claims)

- Current engine is **Shepherd.js 8.3.1** (7 majors behind; latest is 15.2.2).
- **Shepherd relicensed MIT → AGPL-3.0 at v14** (Oct 2024); `vue-shepherd` added
  a paid commercial license at v6.0.0 (Feb 2026). NimbusImage is **Apache-2.0**,
  which is incompatible with AGPL — so upgrading Shepherd in place is not viable.
- **driver.js** (MIT, ~6 kb gzipped, zero deps, actively maintained) is the
  lightweight modern replacement. It lacks built-in wait-for-element,
  event-driven advancement, and router-awareness — but our `TourManager`
  already implements all of these, so they sit in our glue, not the engine.
- No library ships a declarative YAML/JSON authoring layer. Our YAML layer is
  the project's own value-add and is worth preserving.

## Goals

1. Make every tour run end-to-end on the current UI.
2. Make the anchor contract **typed and enforced**, so future UI changes fail a
   check instead of silently orphaning a step.
3. Replace the dated, license-incompatible engine with a modern, lightweight,
   MIT-licensed one — behind the unchanged YAML/controller interface.
4. Verify all flows in a real browser and capture evidence.

## Non-goals

- Changing the declarative YAML authoring model (kept as-is).
- Building a heavyweight automated browser e2e harness (Playwright). Regression
  prevention is handled by a fast static guard plus a one-time manual
  walkthrough.
- Unrelated refactoring of components touched only to add anchors.

## Design

### A. Guiding principle

Keep the architecture: declarative YAML → `TourManager` controller → directive +
event bus. Replace the **rendering engine**, harden the **glue**, and make the
**anchor contract** typed and enforced.

### B. Anchor system (core fix)

- Replace `id="x-tourstep"` with **`data-tour="x"`** on target elements;
  driver.js targets the CSS selector `[data-tour="x"]`.
- Add a **central registry** — a typed module (`src/tours/anchors.ts`) exporting
  every anchor name **and** every `v-tour-trigger` event name as constants.
  Components reference the constant; YAML references the string name. Trigger
  event names are the same failure class and join the same registry.
- The dynamic `getTourStepId(name)` path stays for content-coupled cases but is
  documented as "data-dependent" and **excluded** from the static-existence
  guard (it cannot be statically guaranteed).

### C. Engine swap: Shepherd → driver.js

- Add `driver.js`; remove `shepherd.js` and its CSS import.
- `TourManager` **keeps ownership** of sequencing, routing, element waiting, and
  event-driven advancement (it already does all of this). Per step, instead of
  `shepherd.show()`, it calls a driver.js instance to highlight one element and
  render the popover via `highlight({ element, popover })`.
- **Modal vs non-modal** maps to driver.js overlay opacity (dimmed vs
  transparent) plus `disableActiveInteraction` toggled per step.
- Custom **Next/Done buttons** and the **"N of M" progress** indicator are
  reimplemented via driver.js popover config / `onPopoverRender` (we already
  build these manually today).
- The custom `tour.scss` is reworked to style driver.js's popover to match the
  Vuetify theme.

### D. Glue hardening (fixes the cascade; engine-independent)

1. **Stop silent auto-advance on missing element.** Replace the catch-and-skip
   with a logged warning and a visible "target unavailable — Skip / End tour"
   state, so a broken anchor never silently marches through the rest of the tour.
2. **Auto-navigate on route mismatch.** When a step declares a `route` that
   differs from the current route, `router.push` to it so multi-route tours
   self-advance instead of dead-ending.
3. **Saner waits.** Raise the default `waitForElement`; keep the
   MutationObserver-based wait.
4. **Delete the stringified-JS hooks** (`new Function()` for `beforeShow` /
   `onNext`), since they are unused beyond debug logging.

### E. Content-coupled tours

- **Re-target to stable UI** wherever possible: tool-*type* tiles, the tool
  panel, generic param rows, and the properties/measure panels — these get real
  `data-tour` anchors. This recovers the 4 hard-removed anchors
  (`measure-objects-*`, `properties-*`) by re-adding anchors to the current
  components.
- For steps that genuinely need specific content (e.g. a guided "measure nuclei"
  walkthrough), pair them with the **existing Zenodo sample dataset** that the
  app already pulls for tours, which guarantees the referenced entities exist.
  No new local seeding is introduced.

### F. Testing & verification

- **Static guard (Vitest):** parse every tour YAML, assert each *static* anchor
  and trigger name exists in the registry **and** that the registry constant is
  actually referenced by a component. Data-dependent (`getTourStepId`) anchors
  are exempted but listed in the test output. This is the CI regression net.
- **Manual browser walkthrough (Claude-in-Chrome):** against the running local
  app, drive each tour end-to-end; verify highlight, positioning, timing, and
  advancement; capture a screenshot or GIF per tour. One-time correctness + UX
  pass. Requires `docker compose` backend up and the Zenodo sample dataset
  available.

### G. Sequencing (phased; each independently verifiable)

1. **Registry + `data-tour` migration** — mechanical; add the static guard
   alongside so it goes green as anchors are converted.
2. **Glue hardening** — silent-skip removal, auto-navigation, waits, drop eval;
   verified while still on Shepherd.
3. **Engine swap** to driver.js behind the unchanged YAML/controller interface.
4. **Re-anchor + re-target** broken and content-coupled tours; wire content
   tours to the Zenodo sample dataset.
5. **Manual browser walkthrough** of all tours; capture evidence; fix
   stragglers.

## Risks

- **driver.js feature parity** on fully interactive non-modal steps (wait on a
  user click). Low risk — our glue already drives advancement; validate early in
  phase 3.
- **Local env for browser testing** — needs backend up and the Zenodo sample
  dataset reachable; confirm before phase 5.
- **Churn surface** — ~42 `id` anchors + 14 dynamic `getTourStepId` + 25
  `v-tour-trigger` usages (~81 attachment points) migrate to the new scheme;
  bounded but broad. The static guard mitigates mistakes during conversion.

## Affected files (initial)

- `src/plugins/tour.ts` — controller: engine swap, glue hardening.
- `src/plugins/tour.scss` — restyle driver.js popover.
- `src/plugins/tour-trigger.directive.ts`, `src/plugins/tourBus.ts` — unchanged
  contract; trigger names move into the registry.
- `src/tours/anchors.ts` — **new** typed registry.
- `src/tours/*.yaml` — re-anchored to `data-tour` names; broken steps re-targeted.
- `src/utils/strings.ts` — `getTourStepId` retained, documented as data-dependent.
- Components carrying anchors (~per churn estimate) — `id="x-tourstep"` →
  `data-tour="x"`.
- `src/store/model.ts` — tour-related types (drop Shepherd-specific types).
- `package.json` — add `driver.js`, remove `shepherd.js`.
- New Vitest static-guard test under the tours area.
