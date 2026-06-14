/* eslint-disable no-console */
// Lightweight memory monitoring instrumentation. Intended for comparing
// memory pressure on the master branch vs. the memory-leak-fix branch.
//
// Usage from the browser console:
//   __nimbusMem.enable()         // turn on auto-snapshots on dataset switch
//   __nimbusMem.snapshot('label')// take a manual snapshot
//   __nimbusMem.print()          // print all snapshots with deltas
//   __nimbusMem.compare('a','b') // diff two labels
//   __nimbusMem.export()         // copy a JSON dump to clipboard
//   __nimbusMem.clear()
//   __nimbusMem.disable()
//
// To compare branches, cherry-pick this file (and the small hook in
// `setSelectedDataset`) onto master, run the same workflow on each branch,
// and `__nimbusMem.export()` to copy the JSON for each.

// NOTE: this file intentionally does NOT import any Vuex store modules at
// the top level. Doing so would create a load-order cycle with index.ts
// (which imports memDiag), causing class-field initializers in
// annotation.ts/properties.ts to read `main` before it is defined.
// The integration is instead pull-based: main.ts (after stores are loaded)
// calls memDiag.register(provider) with a function that returns the live
// counts. Until registration completes, snapshots fall back to zeros.

interface MemoryCounts {
  resourcesCache: number;
  resourcesLocks: number;
  imageCache: number;
  histogramCache: number;
  resolvedHistogramCache: number;
  annotations: number;
  annotationConnections: number;
  annotationCentroids: number;
  selectedAnnotationIds: number;
  activeAnnotationIds: number;
  copiedAnnotations: number;
  pendingAnnotation: number;
  submitPendingAnnotation: number;
  propertyValues: number;
  propertyStatuses: number;
  workerImageList: number;
  workerInterfaces: number;
  workerPreviews: number;
  pendingWorkerPreviewTimeouts: number;
}

interface MemorySnapshot extends MemoryCounts {
  label: string;
  timestamp: number;
  jsHeapUsed?: number;
  jsHeapTotal?: number;
  jsHeapLimit?: number;
}

type MemoryCountsProvider = () => MemoryCounts;

const ZERO_COUNTS: MemoryCounts = {
  resourcesCache: 0,
  resourcesLocks: 0,
  imageCache: 0,
  histogramCache: 0,
  resolvedHistogramCache: 0,
  annotations: 0,
  annotationConnections: 0,
  annotationCentroids: 0,
  selectedAnnotationIds: 0,
  activeAnnotationIds: 0,
  copiedAnnotations: 0,
  pendingAnnotation: 0,
  submitPendingAnnotation: 0,
  propertyValues: 0,
  propertyStatuses: 0,
  workerImageList: 0,
  workerInterfaces: 0,
  workerPreviews: 0,
  pendingWorkerPreviewTimeouts: 0,
};

let countsProvider: MemoryCountsProvider | null = null;

function register(provider: MemoryCountsProvider) {
  countsProvider = provider;
}

const STORAGE_KEY = "nimbusMemDiagEnabled";
const HISTORY: MemorySnapshot[] = [];
const HISTORY_CAP = 500;

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = readEnabled();

function readPerfMemory() {
  const mem = (performance as unknown as { memory?: Record<string, number> })
    .memory;
  if (mem && typeof mem.usedJSHeapSize === "number") {
    return {
      jsHeapUsed: mem.usedJSHeapSize,
      jsHeapTotal: mem.totalJSHeapSize,
      jsHeapLimit: mem.jsHeapSizeLimit,
    };
  }
  return {};
}

function takeSnapshot(label: string): MemorySnapshot {
  const counts = countsProvider ? countsProvider() : ZERO_COUNTS;
  return {
    label,
    timestamp: Date.now(),
    ...readPerfMemory(),
    ...counts,
  };
}

function pushSnapshot(snap: MemorySnapshot) {
  HISTORY.push(snap);
  while (HISTORY.length > HISTORY_CAP) {
    HISTORY.shift();
  }
}

function snapshot(label: string = "manual") {
  const snap = takeSnapshot(label);
  pushSnapshot(snap);
  return snap;
}

// Take a snapshot only when auto-tracking is enabled. Used by store hooks.
function autoSnapshot(label: string) {
  if (!enabled) {
    return;
  }
  pushSnapshot(takeSnapshot(label));
}

function fmtBytes(n?: number): string {
  if (n === undefined) {
    return "—";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  if (n < 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function print() {
  if (HISTORY.length === 0) {
    console.log("[memDiag] no snapshots yet");
    return;
  }
  const rows = HISTORY.map((s, i) => {
    const prev = i > 0 ? HISTORY[i - 1] : undefined;
    const heapDelta =
      prev && s.jsHeapUsed !== undefined && prev.jsHeapUsed !== undefined
        ? fmtBytes(s.jsHeapUsed - prev.jsHeapUsed)
        : "—";
    return {
      "#": i,
      label: s.label,
      "t (ms)": prev ? s.timestamp - prev.timestamp : 0,
      "heap used": fmtBytes(s.jsHeapUsed),
      "Δ heap": heapDelta,
      resources: s.resourcesCache,
      imgCache: s.imageCache,
      histCache: s.histogramCache,
      annot: s.annotations,
      "annot conn": s.annotationConnections,
      centroids: s.annotationCentroids,
      "sel ids": s.selectedAnnotationIds,
      "prop vals": s.propertyValues,
      "prop stat": s.propertyStatuses,
      "wkr prev": s.workerPreviews,
      "wkr if": s.workerInterfaces,
      tmout: s.pendingWorkerPreviewTimeouts,
    };
  });
  console.table(rows);
  console.log(
    `[memDiag] ${HISTORY.length} snapshots. Use __nimbusMem.export() to copy raw JSON.`,
  );
}

function compare(labelA: string, labelB: string) {
  const a = HISTORY.findLast?.((s) => s.label === labelA) ?? findLast(labelA);
  const b = HISTORY.findLast?.((s) => s.label === labelB) ?? findLast(labelB);
  if (!a || !b) {
    console.log(
      `[memDiag] could not find snapshots for "${labelA}" and "${labelB}"`,
    );
    return;
  }
  const numericKeys = (Object.keys(a) as (keyof MemorySnapshot)[]).filter(
    (k) => typeof a[k] === "number" && k !== "timestamp",
  );
  const rows = numericKeys.map((k) => {
    const av = a[k] as number;
    const bv = b[k] as number;
    return {
      field: k,
      [labelA]: k.startsWith("jsHeap") ? fmtBytes(av) : av,
      [labelB]: k.startsWith("jsHeap") ? fmtBytes(bv) : bv,
      delta: k.startsWith("jsHeap") ? fmtBytes(bv - av) : bv - av,
    };
  });
  console.table(rows);
}

function findLast(label: string): MemorySnapshot | undefined {
  for (let i = HISTORY.length - 1; i >= 0; --i) {
    if (HISTORY[i].label === label) {
      return HISTORY[i];
    }
  }
  return undefined;
}

function exportJson() {
  const json = JSON.stringify(HISTORY, null, 2);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(json).then(
      () => console.log("[memDiag] copied JSON to clipboard"),
      () => console.log(json),
    );
  } else {
    console.log(json);
  }
  return json;
}

function clear() {
  HISTORY.length = 0;
  console.log("[memDiag] history cleared");
}

function enable() {
  enabled = true;
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* ignore */
  }
  console.log(
    "[memDiag] auto-snapshots on dataset switch ENABLED (persists in localStorage)",
  );
}

function disable() {
  enabled = false;
  try {
    localStorage.setItem(STORAGE_KEY, "0");
  } catch {
    /* ignore */
  }
  console.log("[memDiag] auto-snapshots DISABLED");
}

function isEnabled() {
  return enabled;
}

export const memDiag = {
  snapshot,
  print,
  compare,
  export: exportJson,
  clear,
  enable,
  disable,
  isEnabled,
  // Internal: used by store hooks. No-op if not enabled.
  autoSnapshot,
  // Internal: used by main.ts to wire up the live count provider once
  // stores have finished loading.
  register,
};

declare global {
  interface Window {
    __nimbusMem?: typeof memDiag;
  }
}

if (typeof window !== "undefined") {
  window.__nimbusMem = memDiag;
}
