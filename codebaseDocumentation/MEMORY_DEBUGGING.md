# Memory Debugging

A browser-console memory monitoring tool is registered globally as `window.__nimbusMem` (implementation in `src/utils/memoryDiagnostics.ts`). Auto-tracking is **opt-in** via `__nimbusMem.enable()` and adds zero overhead otherwise — the hook in `setSelectedDataset` short-circuits on a single boolean check when disabled.

## Console API

```js
__nimbusMem.enable()           // auto-snapshots on dataset switch (persists in localStorage)
__nimbusMem.disable()
__nimbusMem.snapshot('label')  // manual snapshot at any moment
__nimbusMem.print()            // console.table of all snapshots with heap deltas
__nimbusMem.compare('a', 'b')  // diff two labeled snapshots
__nimbusMem.export()           // copy raw JSON of all snapshots to clipboard
__nimbusMem.clear()            // reset history
```

## What gets recorded

Each snapshot includes:

- **Heap (Chrome only)** — `performance.memory`: `usedJSHeapSize`, `totalJSHeapSize`, `jsHeapSizeLimit`
- **Cache sizes** — `resourcesCache`, `imageCache`, `histogramCache`, `resolvedHistogramCache`
- **Annotation store** — `annotations`, `annotationConnections`, `annotationCentroids`, `selectedAnnotationIds`, `activeAnnotationIds`, `copiedAnnotations`, `pendingAnnotation`, `submitPendingAnnotation`
- **Properties store** — `propertyValues`, `propertyStatuses`, `workerImageList`, `workerInterfaces`, `workerPreviews`, `pendingWorkerPreviewTimeouts`

History is capped at 500 snapshots (FIFO eviction).

## Architecture

`memoryDiagnostics.ts` does NOT import any store modules at the top level — that would create a load-order cycle with `index.ts`, breaking class-field initializers in `annotation.ts`/`properties.ts`. The integration is pull-based:

1. `index.ts` imports `memDiag` and calls `autoSnapshot('label')` at boundaries (currently in `setSelectedDataset`)
2. `main.ts` (which runs after all stores have initialized) calls `memDiag.register(provider)` with a closure that reads live counts from each store

Snapshots taken before `register()` runs return zero counts but won't crash.

## Extending

**To add a new tracked counter:**

1. Add the field to the `MemoryCounts` interface and `ZERO_COUNTS` in `src/utils/memoryDiagnostics.ts`
2. Add a column to the `print()` `console.table` output
3. Update the provider closure in `src/main.ts` to read the live count

**To add a new auto-snapshot point:**

Call `memDiag.autoSnapshot('label')` in the relevant Vuex action. It no-ops when auto-tracking is disabled, so the call site has no overhead in normal use.

## Comparing branches

The diagnostic file is intentionally self-contained so it can be cherry-picked onto a comparison branch (e.g. master) for before/after measurements. To set up a comparison:

1. **In a worktree on the comparison branch**, copy these four pieces of integration:
   - `src/utils/memoryDiagnostics.ts` (whole file, no edits)
   - `getCacheSizes()` accessor on `src/store/GirderAPI.ts`
   - The three `memDiag.autoSnapshot(...)` calls in `setSelectedDataset` in `src/store/index.ts` (and the `import { memDiag } from "@/utils/memoryDiagnostics"`)
   - The `memDiag.register(...)` block in `src/main.ts` (along with the three store imports)
2. Run a Vite dev server on a different port (e.g. `pnpm exec vite --port 5174`). Note that you will need to log in fresh on the new port since localStorage is per-origin.
3. On both branches: `__nimbusMem.enable()` → reload → run the same workflow → `__nimbusMem.export()` to copy the JSON.
4. Diff the two JSON dumps to identify which counters grow on the leaky branch and stay bounded on the fixed branch.

When cherry-picking, fields that exist only on the fix branch (e.g. `pendingWorkerPreviewTimeouts`) need to be guarded in the provider closure so the comparison branch can read them as `undefined`. Example:

```typescript
const tmoutMap = (propertiesStore as unknown as Record<string, unknown>)
  .pendingWorkerPreviewTimeouts as { size: number } | undefined;
// ...
pendingWorkerPreviewTimeouts: tmoutMap ? tmoutMap.size : 0,
```

## Limitations

- `performance.memory` is **Chrome-only**. Firefox and Safari return `undefined` for the heap fields; the cache/store counts still work.
- Heap reporting is noisy without forced GC. Single-sample numbers can wobble ±10–20 MB. For reliable signal, take multiple snapshots across an action and look at trend, not a single value. Use Chrome DevTools' Memory panel for definitive answers.
- The tool measures **Vuex store and JS-cache sizes**, not DOM detached nodes, observers, or WeakMap leaks. For those, use the Memory panel's heap snapshot diff feature.
