---
name: in-browser-testing
description: "Use when verifying NimbusImage changes in a live browser tab (localhost:5173) — clicking UI, driving drawing tools, reading store state from the console, measuring render performance, or reproducing a reported UI bug. Use BEFORE claiming any user-facing change works: tsc/lint/vitest green does not mean the UI works."
---

# In-Browser Testing of NimbusImage

## Overview

Multiple real bugs in this repo passed tsc, lint, all unit tests, and code reasoning — and only broke in the live app (pointer-events layering, deep-watch over-firing, HMR-corrupted store, background-tab false-passes). For any user-facing change, in-browser verification is a required gate, and it must be done in a way that can actually fail. The traps below each produced a false "it works" at least once.

## The four false-pass traps

1. **Synthetic clicks lie.** `element.dispatchEvent(new MouseEvent('click'))` bypasses hit-testing, `pointer-events`, z-index, and overlays. A synthetic-click walkthrough once reported a tour "working" while real user clicks did nothing. Verify clickability with `document.elementFromPoint(cx, cy)` (is the intended element the topmost hit target?), then click with the real `computer` tool. Reserve synthetic dispatch for *driving* flows fast only after clickability is independently confirmed.
2. **Background tabs lie.** A hidden tab pauses `requestAnimationFrame`, throttles `setTimeout` to ~1 Hz, and never composites — perf probes report 0 long tasks and event loops stall/time out. The tab must be foreground/visible for any timing or rendering claim. If a paced loop must survive a background tab, use busy-wait gaps (`while (performance.now() < end) {}`), not setTimeout.
3. **A stale store lies.** Editing any `src/store/*.ts` while `pnpm run dev` runs breaks HMR (`[vuex] duplicate getter key`, annotations stuck at 0). Hard-reload the page after every store-module edit before trusting anything. (Component `.vue` edits HMR fine.)
4. **A stale backend lies.** After backend plugin edits, `docker compose restart girder` does NOT load the new code (plugin is baked into the image) — new routes 404 while tox passes. Rebuild: `docker compose build girder && docker compose up -d girder`.

## Console handles (javascript_tool)

```js
// Wrap EVERYTHING in an IIFE — top-level const persists across javascript_tool
// calls ("Identifier 'store' has already been declared") and bare await fails.
(async () => {
  const store = document.querySelector('#app').__vue_app__
    .config.globalProperties.$store;
  const map = store.state.main.maps[0].map;   // live GeoJS map
  // window.geojsMap is a jQuery red herring — don't use it.
  // map.onIdle hangs if the map is already idle — don't await it blindly.

  // Navigation actions dispatch UN-namespaced:
  store.dispatch('setZ', 4);   // also setTime, setXY
  // Fire, don't await: these actions await a /dataset_view PUT that is
  // decoupled from the visible render — awaiting conflates backend latency
  // with render cost and can blow automation timeouts.

  const layer = map.layers().find(l => l.annotations)      // annotation layer
  return { z: store.state.main.z, n: layer?.annotations().length };
})();
```

Camera changes (`map.zoom(v)`, `map.center({x,y})`) do trigger the camera watcher but only after ~700 ms of debounces (250 ms camera + 200 ms fetch) — wait before reading resulting state. Memory: `window.__nimbusMem` (see nimbus-frontend skill).

**An async IIFE's return value does not come back** — `javascript_tool` reports `{}` for anything that needs awaiting, including plain strings. Objects serialize to `{}` too. So: stash on `window`, read it synchronously in a second call, and return a **string** (join the fields yourself).

```js
// Call 1 — kick it off, poll for readiness inside, stash a string.
window.__r = 'pending'; (async () => {
  const s = () => document.querySelector('#app')?.__vue_app__
    ?.config?.globalProperties?.$store;
  for (let i = 0; i < 100; i++) {                 // wait for load/hydration
    if (s()?.state?.main?.configuration?.layers?.length) break;
    await new Promise(r => setTimeout(r, 400));
  }
  window.__r = ['mode=' + s().state.main.layerMode,
                'tools=' + s().state.main.configuration.tools.length].join(' | ');
})(); 'started'
// Call 2
window.__r
```

**All store actions dispatch un-namespaced, in every module** — `dispatch('createProperty')`, not `dispatch('properties/createProperty')`. A namespaced name silently resolves to nothing and the promise *resolves*, so you get a false "no throw" rather than an error. Confirm a name exists with `Object.keys(store._actions)` before trusting a negative result. Cross-module state lives under its own key (`store.state.properties.propertiesAPI`).

**Verifying error propagation without touching real data.** Stub an API method to reject, dispatch, read `error.message`, restore in `finally` — this exercises the real built code (decorators included) and writes nothing, because the stub replaces the request:

```js
const api = store.state.main.api, orig = api.updateConfigurationKey;
api.updateConfigurationKey = async () => { throw new Error('BACKEND_SAYS_NO'); };
try { await store.dispatch('syncConfiguration', { key: 'layers', throwOnError: true }); }
catch (e) { window.__r = e.message; } finally { api.updateConfigurationKey = orig; }
```

To exercise a **success** path without changing anything, re-save the values already in the store (read them, pass them straight back) and assert the write count rather than the value. Counting writes catches batching regressions a value check can't: wrap the API method to increment a counter and delegate to the original.

**A live probe is only evidence if it can fail.** Before believing a passing probe, re-check out the pre-fix file (`git checkout <commit> -- src/store/index.ts`), `location.reload()`, and confirm the probe *fails*. That's what distinguished a real fix from a coincidence here — a 1081-char mangled message before vs a 21-char one after. Restore the file afterward.

## Driving GeoJS drawing tools

CDP `left_click_drag` silently fails for freehand/continuous drawing: it emits mousedown + ONE move + up in ~7 ms, GeoJS ends with 2 vertices and discards the annotation with no error. Working recipe: dispatch synthetic `MouseEvent`s (`mousedown` / `mousemove`×N / `mouseup`, `bubbles: true`, correct `buttons`) on the `.geojs-map` canvas with **busy-wait** gaps (~40 ms) between steps — immune to background throttling and lets lodash-throttled handlers (100 ms in AnnotationViewer) fire mid-drag. Synthetic `clientX/Y` are offset from screen coords by the map node's page offset — fine for behavior testing; don't assert exact positions. Verify results through live handles (`layer.annotations()`, `annotation.options('vertices')`), not screenshots alone.

Real `computer` clicks: this environment runs DPR 2 with a downscaled screenshot — the computer tool's coordinate space can differ from screenshot pixels. Read `window.innerWidth/innerHeight` and scale, or confirm the target with `elementFromPoint` first.

The `computer` tool works in **screenshot** space, so convert from page coords and check hittability in one pass. Scale from the screenshot dimensions the tool reported (e.g. 1568×756) against `window.inner*` — they differ, and the window can be resized between calls, so recompute rather than reusing a factor:

```js
const sx = 1568 / window.innerWidth, sy = 756 / window.innerHeight;
const el = [...document.querySelectorAll('input[type=radio]')]
  .find(e => e.value === 'single');
const r = el.getBoundingClientRect();
const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
// hittable? -> is the intended element actually the topmost target?
const top = document.elementFromPoint(cx, cy);
return [Math.round(cx * sx), Math.round(cy * sy),
        el === top || el.contains(top)].join(' / ');
```

Picking a target by eyeballing a screenshot lands on overlays: the coords that *looked* like a layer's toggle resolved to a `v-expansion-panel-title__overlay`, which would have toggled the panel instead. `elementFromPoint` returning the real `INPUT` is the go-ahead.

If every browser call starts failing with `Cannot access contents of the page. Extension manifest must request permission to access the respective host` (and `javascript_tool` times out), the extension has lost host permission for the tab. Nothing you can do from here — confirm the dev server is still up from the shell (`curl -o /dev/null -w '%{http_code}' http://localhost:5173`) so you can say it's extension-side, then ask the user to re-grant site access and check the extension side panel for a pending prompt.

## Performance measurement

- **Warm up + median**: the first run after idle is ~2× slower (cold cache + GC). A one-shot A/B once produced a false 4× regression. Discard 1–2 warmups, report the median of N warm runs.
- Measure with `PerformanceObserver('longtask')` + rAF cadence in a **foreground** tab; report max block and worst frame.
- Distrust static analysis for bottlenecks: wrap the suspect live and measure — a static pass once fingered a function that measured at 16 ms of an 87 ms block.

## Checklist before claiming "verified in browser"

- [ ] Tab foreground and visible
- [ ] Page hard-reloaded if any `src/store/*.ts` changed
- [ ] Backend rebuilt (not restarted) if plugin code changed
- [ ] Interaction driven by real clicks (or synthetic drive with clickability confirmed via `elementFromPoint`)
- [ ] Result read from live state (`store` / `layer.annotations()`), not inferred from absence of errors
