# Slider Scrub Bouncing Fix (Vue 3 / Vuetify 4)

Branch: `fix/slider-scrub-bouncing`

## Summary

After the Vue 3 + Vuetify 4 migration, scrubbing the time/Z/XY sliders felt like the slider was "fighting" the mouse — especially on datasets with >20 frames. A previous attempt (#1103, `fix/slider-scrub-jerkiness`) added an `isDragging` guard in `ValueSlider.vue` and a 10ms debounce on `ImageViewer`'s `mapLayerList` watcher, but the underlying issues were elsewhere. Three independent bugs were stacking up to make scrubbing feel unstable:

1. **`useRouteMapper` two-way binding race** — URL→Store sync was reading stale URL values mid-drag and writing them back to the store, ping-ponging `store.time`.
2. **Counter layout shift** — the `145 of 145` counter sat in the same flex row as the slider track, and changing digits shifted the track's `getBoundingClientRect()` by a few pixels each frame. Vuetify reads the track rect on every `mousemove`, so a steady cursor was producing alternating step values.
3. **Stale-prop flicker on drag release** — `onDragEnd` synchronously called `updateInternalValue()` before the most recent emit had propagated through the parent re-render, briefly snapping the thumb to the previous value.

In addition, the dense slider layout was wasting horizontal pixels on a redundant counter, leaving very few pixels per step on long timelines.

All three bugs are fixed and the layout is reorganized to give the slider track maximum width.

## How we found it

Targeted instrumentation, not a profiler. The diagnostic flow was:

1. **Add a timestamp-relative log to every event in the slider value pipeline** — `@start`, `@end`, the `slider` computed setter (Vuetify → us), and the `props.modelValue` watcher (us → Vuetify). Each log carries `oldProp`, `newProp`, `internal`, and `wouldChangeInternal` so we can see whether the prop watcher would have written a stale value back into the slider's internal state.
2. **Add timing logs to `ImageViewer`'s `mapLayerList` watcher and `draw()`** with a fire counter and coalesced count, to test whether main-thread blocking from GeoJS work was starving pointermove events.

The first run showed `draw()` running in 1–2ms (so the debounce wasn't doing meaningful work) and several `prop watch: SKIPPED { wouldChangeInternal: true }` events during steady drags — meaning *something other than the slider* was mutating `store.time` to a previous value. That pointed to the route mapper.

After the route mapper fix, a second run showed clean monotonic emits during fast drags but **multi-step bouncing during steady drags** — the setter itself was being called by Vuetify with alternating values 16ms apart. Adding a `trackRect: el.querySelector('.v-slider-track').getBoundingClientRect()` field to the setter log proved that the track's `left` and `width` were shifting between frames. From there it was easy to see the counter span (sibling of the slider with `flex-shrink: 0` against a `flex-grow: 1` slider column) was the layout-shift source.

Diagnostic principle: **if a value is bouncing, log every place that writes it and check the timing.** A 60Hz alternation pattern is a strong tell for layout-shift-during-drag — Vuetify's `parseMouseMove` calls `getBoundingClientRect()` on every event, so any per-frame layout change feeds back into the value computation.

## Root causes and fixes

### 1. `useRouteMapper` URL→Store loop (`src/utils/useRouteMapper.ts`)

**Cause.** `useRouteMapper` syncs route query/params to store state in both directions. The Store→URL direction had a guard (`currentRouteChanges` counter) that blocked it while a URL→Store sync was in flight. The reverse guard was missing. Each slider drag tick called `setUrlParamsOrQuery` which queued a `router.replace`. As those queued replacements drained out-of-band, the `route.fullPath` watcher fired `syncFromRoute`, which read the (now-stale) URL value and wrote it back to the store via `mapper.set(parsedUrlValue)`, overwriting the user's newer drag value.

**Fix.** Added a `pendingUrlWrites` counter — incremented around `await router.replace(...)` and checked at the top of `syncFromRoute`:

```ts
let pendingUrlWrites = 0;

const setUrlParamsOrQuery = awaitPreviousCallsDecorator(async (...) => {
  // ...
  pendingUrlWrites++;
  try {
    await router.replace(replacement);
  } finally {
    pendingUrlWrites--;
  }
});

async function syncFromRoute(r) {
  if (pendingUrlWrites > 0) return;  // URL is mid-transition, don't read it
  // ... existing sync logic
}
```

This is symmetric with the existing `currentRouteChanges` guard. To avoid silently dropping a real external URL change (browser back/forward, manual edit) that lands during the drain window, a skipped `syncFromRoute` registers a one-shot drain-replay callback on a module-level `onDrainCallbacks` queue. When `pendingUrlWrites` returns to 0 *and stays there for `DRAIN_DEBOUNCE_MS` (100ms)*, queued callbacks fire and re-run `syncFromRoute` with the *current* (now-settled) `route`. Each `useRouteMapper` instance dedupes its own callback registration with a `drainReplayQueued` flag and gates the replay on `isAlive` (set false by `onScopeDispose`) so a callback that fires after the component unmounts is a no-op.

The 100ms debounce is critical for fast slider scrubs. `awaitPreviousCallsDecorator` serializes `router.replace` calls FIFO, so during a fast scrub the queue accumulates one tick per pixel of cursor travel and each `router.replace` resolves with the URL at *that* tick's value (not the latest). Without the debounce, the drain fires the moment `pendingUrlWrites` hits 0 between every queued replace; `syncFromRoute` reads the now-stale URL value and writes it to the store via `mapper.set`, clobbering the user's most recent input. That manifests as render stutter — every scrub tick produces two store writes (user → store, then stale URL → store) and double the `ImageViewer` render churn. The debounce holds the replay until the writer has been quiet for 100ms, by which point the URL has caught up to the store.

### 2. Counter layout shift (`src/components/ValueSlider.vue`)

**Cause.** The counter span lived in the same flex row as the slider:

```vue
<div class="d-flex">
  <div class="slider-column flex-grow-1">
    <v-slider .../>
  </div>
  <span class="counter-label">{{ modelValue + offset }} of {{ max + offset }}</span>
</div>
```

The counter's content changed on every drag tick. Even when digit count was constant (e.g., 59 → 62 → 61), Roboto's proportional digit widths produced sub-pixel layout shifts in the counter's content-sized box. With `flex-grow: 1` on the slider column, those shifts propagated into the slider track's width. Vuetify reads `el.getBoundingClientRect()` on every mousemove inside `parseMouseMove`, so the same cursor position resolved to different step values frame-to-frame.

On dense sliders (1–2 pixels per step), even a 1px layout shift can jump the value by 1 step. Crossing a digit-count boundary like `9` → `10` shifts ~7px and produces multi-step bounces.

**Fix (initial).** Reserved a fixed `min-width` on the counter sized for the largest possible content (`${maxDigits * 2 + 4}ch`) and added `font-variant-numeric: tabular-nums` so individual digit widths don't vary. This stopped the bouncing immediately.

**Fix (final, layout reorganization).** Once we knew the counter was the culprit, the better fix was to remove it from the slider's flex row entirely. The current layout is:

- **Row 1:** label (`Time:`), text-field (numeric input, dynamically sized), `/<max>` static suffix, ↑/↓ step arrows
- **Row 2:** full-width slider track with no left spacer

The `/<max>` suffix is static (depends only on `max`, never on the current value), so it can never cause layout shift. The slider track gets the full container width, roughly doubling pixels-per-step versus the old shared-row layout.

The text-field width is now computed from `max`'s digit count to fit the largest possible value without clipping:

```ts
const inputWidth = computed(() => {
  const maxDigits = Math.max(String(props.max + props.offset).length, 2);
  return `calc(${maxDigits}ch + 40px)`;  // 32px is v-field's compact padding-inline + 8px cushion
});
```

### 3. `@end` stale-prop flicker (`src/components/ValueSlider.vue`)

**Cause.** Vuetify's v-slider fires `model.value = X; emit('end', X)` synchronously on `mouseup`. Our `slider.set(X)` updates `internalValue` and emits `update:modelValue`. The parent's listener (`time = computed({set: (v) => store.setTime(v)})`) commits the Vuex mutation synchronously, but the parent re-render that propagates the new `props.modelValue` to the child has not yet happened — Vue 3 props update on the next render cycle, not synchronously.

Inside `onDragEnd` (which fires immediately after the setter), `props.modelValue` was therefore the *previous* emit value. `updateInternalValue()` would set `internalValue = props.modelValue + props.offset`, briefly snapping the thumb to the previous step. The watcher then fired with the correct prop and snapped it back. The user perceived this as a small jitter on release.

**Fix.** Defer the resync to `nextTick` so the parent's re-render has propagated:

```ts
function onDragEnd() {
  isDragging.value = false;
  nextTick(() => {
    if (!isDragging.value) {
      updateInternalValue();
    }
  });
}
```

### 4. Removed the `mapLayerList` debounce (`src/components/ImageViewer.vue`)

The 10ms `setTimeout` debounce around `draw()` was added in #1103 as a guess at the cause. With the actual root causes fixed and `draw()` measured at 1–2ms per frame (the `setFrameQuad` path is designed for instant per-frame quad-texture swaps), the debounce was just adding 10ms of latency to the latest frame. Reverted to plain `nextTick`:

```ts
watch(mapLayerList, () => {
  nextTick(() => {
    if (!refsMounted.value) return;
    draw();
  });
});
```

This also exposed a pre-existing bug in `ImageViewer.test.ts`'s `createLayerStackImage` mock factory: trailing `...overrides` was clobbering `layer` and `image` when callers passed those keys. Pull them out before spreading the rest. (Same fix as the unmerged commit `e6ccddf4` on `claude/fix-slider-jerkiness-Na9xD`.)

## Files changed

- `src/utils/useRouteMapper.ts` — `pendingUrlWrites` counter blocks URL→Store sync while our own `router.replace` calls are draining.
- `src/components/ValueSlider.vue` — layout reorganized to give slider full row width; counter is now a small static `/<max>` next to the input; `onDragEnd` defers `updateInternalValue` to `nextTick`. Text-field uses `flex-grow-1` (master behavior) so unit-suffixed value labels like `3 μm` aren't truncated. Includes the Shift-drag fine-adjust modifier described below and a consolidated v-tooltip on the slider track.
- `src/components/ImageViewer.vue` — `mapLayerList` watcher reverted from `setTimeout(10)` to `nextTick`.
- `src/components/ImageViewer.test.ts` — fixed mock factory's spread order so `{ layer: { ... } }` overrides no longer clobber the carefully-built default.

## Shift-drag fine-adjust modifier

Even with the wider track, datasets with >150 steps put each step at ~1.5–2px on typical screen sizes, which is at the edge of mouse pointer resolution. The chevron arrows and the existing `s/f`, `d/e`, `w/r` hotkeys (see `CLAUDE.md`) provide ±1 stepping for fine work; the Shift modifier provides a more ergonomic continuous-drag option matching Photoshop/Figma/audio-tool conventions.

### Constraints

- Vuetify's `useSlider` reads `e.clientX` directly inside `parseMouseMove` and rounds to the nearest step via `roundValue`. There is no built-in fine-adjust hook.
- Vuetify registers its `mousemove` listener with `{ passive: true, capture: true }` on `window` inside `onSliderMousedown`, and its `mouseup` listener with no capture flag (bubble phase) on `window`.
- We don't want to fork or monkey-patch Vuetify.

### Implementation

`src/components/ValueSlider.vue` registers two window-level capture-phase listeners at component mount, before any drag occurs. Because Vuetify only attaches its listeners on `mousedown`, ours are registered first and fire first in capture phase on the same target.

1. **`mousemove` (capture)** — if `isDragging && e.shiftKey`, call `e.stopImmediatePropagation()` to suppress Vuetify's listener, then write `anchor.value + round(pixelDelta * FINE_RATIO)` via the same internal-value + emit path Vuetify uses. `FINE_RATIO = 0.1` (10px per step). When Shift is not held the handler clears the anchor and no-ops, so Vuetify runs unchanged for normal drags. The anchor is set on the first Shift event of a session and cleared on every non-shift event, so press/release/press transitions re-anchor cleanly.

2. **`mouseup` (capture)** — if a fine drag is in progress when mouseup fires, set a one-shot `suppressNextSetterWrite` flag. Vuetify's bubble-phase mouseup runs `handleStop → onSliderEnd`, which writes `parseMouseMove(e)` (the cursor-based absolute value) into `model.value`; the slider setter consumes the flag and returns early, so the parent's state stays at the fine value. `useProxiedModel` returns `props.modelValue` when controlled, so the rendered thumb stays at the fine value even though Vuetify's internal ref gets a stale write.

3. **`@end` thumb blur** — Vuetify focuses the thumb on `mousedown` and never blurs it, leaving a persistent `.v-slider-thumb--focused` halo. `onDragEnd` runs `thumb.blur()`. `@end` only fires for mouse/touch drags (not keyboard arrow nav), so this doesn't break keyboard accessibility.

### Hint tooltip

A single `v-tooltip` on the slider-row consolidates the caller-supplied description (e.g., `145 Time Values (Hotkeys s/f)`) with `Hold Shift for fine adjustment` when `max - min >= 100`. The previous `:title="..."` prop on `ValueSlider` was being applied as a native HTML `title` attribute via attribute fallthrough, producing a separate browser-styled tooltip with selectable text; declaring `title` as a real prop now consumes it instead. `open-delay="600"` prevents incidental hover pop-ups; `location="end"` keeps the tooltip clear of the row above.

### Known limitations

- Releasing Shift mid-drag returns control to Vuetify's absolute-cursor handler, which can produce a small thumb jump if the cursor and value have drifted apart during fine adjustment. Achieving zero-jump on release would require modifying Vuetify's internal `startOffset`, which is not exposed.
- Touch interactions use `touchmove` (not intercepted) and have no Shift modifier, so they fall back to normal behavior.

### Fragility — verify these on Vuetify version bumps

The Shift-drag implementation reaches into Vuetify's private internals to intercept its own listeners and to suppress one of its writes. None of the touchpoints below are part of Vuetify's public API. A minor Vuetify upgrade can silently break the slider in ways that look fine in jsdom-mounted tests (correct values are emitted) but fail visually in the browser (thumb jumps on mouseup, halo lingers, fine drag doesn't engage). When bumping `vuetify` in `package.json`, walk through these and re-verify each one in `node_modules/vuetify/lib/components/VSlider/`:

1. **`mousemove` listener registered with `{ passive: true, capture: true }` on `window` inside `onSliderMousedown`** (`slider.js`). Our handler is registered earlier (at component mount) so it fires first in capture phase on the same target. If Vuetify drops `capture: true` or switches to a pointer event, our `stopImmediatePropagation` no longer suppresses Vuetify's handler and fine-drag values are immediately overwritten by the cursor-based value.

2. **`mouseup` listener registered without a capture flag (bubble phase) on `window` inside `onSliderMousedown`** (`slider.js`). Our capture-phase mouseup handler must fire first to set the suppress flag before Vuetify's mouseup runs. If Vuetify switches to capture phase, our listener registered at component mount may still fire first (registered earlier on the same target+phase), but the symmetry is no longer guaranteed.

3. **`onSliderEnd` writes `model.value = roundedValue` BEFORE emitting `@end`** (`VSlider.js`). The one-shot suppress flag is consumed by the slider setter, then `onDragEnd` clears any leftover state. If Vuetify reorders these, `@end` fires first, our handler clears the suppress flag, and the cursor-based `model.value` write then leaks through to the parent.

4. **`useProxiedModel` getter returns `props.modelValue` when `isControlled` is true** (`composables/proxiedModel.js`). This is what lets our setter suppression keep the rendered thumb at the fine value: even though Vuetify's internal ref gets the stale cursor-based write, the rendered thumb position is computed from the prop. If Vuetify changes the controlled-mode getter to return the internal ref, the thumb visually jumps on mouseup despite our suppression.

5. **DOM class `.v-slider-thumb` on the thumb element** (`VSliderThumb.js`). `onDragEnd` queries this class to call `.blur()` and clear the focus halo. A rename produces a silent regression — the thumb stays focused after every drag.

6. **CSS class `.v-slider-thumb--focused` activates the halo via `transform: scale(2); opacity: var(--v-focus-opacity);`** (`VSliderThumb.css`). If Vuetify replaces the focused-class with a different selector (e.g., `:focus-visible`), `onDragEnd`'s blur becomes a no-op against the now-inert class, but the halo behavior may also change in ways that make the blur unnecessary. Test by clicking and releasing the slider and confirming the halo disappears immediately.

7. **`v-tooltip` `activator="parent"` activates on hover of the immediate `v-tooltip` parent element** (`VTooltip.js`). The fine-adjust hint and caller description are attached to the slider-row this way. If `activator="parent"` semantics change (e.g., walks up to the next "interactive" element), the tooltip may activate on hover of the wrong region.

### Out of scope (consider later)

- A "right-click drag = fine adjust" alternative for trackpad users without a Shift modifier.
- Per-axis fine modifiers (e.g., Alt for ×0.01).
- Canary tests for the fragility points above. An attempt was made to add jsdom-based tests (source-pattern matching for #1–#3, controlled-mode rendering for #4, DOM class checks for #5), but Vuetify 4's overlay/teleport behavior in jsdom made the tests flaky enough that they were abandoned. A more robust approach would be a real-browser test (Playwright/Cypress) that drives the slider with synthetic events and asserts the resulting values and DOM state.

## Diagnostic principles worth keeping

- **When a value bounces, log every place that writes it.** Don't just log the symptom (the bouncing); log the writers and the timing relative to user input. The 60Hz alternation pattern in this case was the signal that something was reading geometry on every frame.
- **Sub-pixel layout shift is observable through Vuetify's slider math.** Any flex-grow component sharing a row with a content-sized variable-width sibling is a candidate. `font-variant-numeric: tabular-nums` and reserved `min-width` are cheap defenses.
- **Verify "fast" with measurement before assuming.** The 10ms debounce in `ImageViewer` was added on the hypothesis that `draw()` was expensive. It wasn't — measuring `performance.now()` around the call showed 1–2ms — so debouncing only added latency.
- **Two-way bindings need symmetric loop guards.** Any sync that writes one direction conditionally must check whether the other direction is mid-flight, or the in-flight write will be observed and replayed.
