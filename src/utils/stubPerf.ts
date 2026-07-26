/**
 * Dev-only performance tracker for the stub/hydrate system.
 *
 * Accumulates counters across a session so you can measure the impact of
 * caching changes. Exposed on `window.__stubPerf` so you can query from
 * DevTools without scrolling console logs:
 *
 *   __stubPerf.snapshot()      // { ...all counters }
 *   __stubPerf.report()        // console.log a human-readable summary
 *   __stubPerf.reset()         // zero all counters, keep datasetId
 *   __stubPerf.verbose = true  // log each hydrate request
 *
 * This is instrumentation only; removing it has no behavior effect.
 *
 * Gated by `enabled` (= import.meta.env.DEV): in a production build every
 * track* method is a no-op, so the per-pan / per-hydrate hot paths don't pay
 * for instrumentation and the latency array can't grow. In dev, latency
 * samples are kept in a fixed-size ring buffer (MAX_LATENCY_SAMPLES) so a
 * long-lived tab doesn't leak memory through an ever-growing array.
 */

// Keep only the most recent N hydrate-latency samples (enough for a stable
// p50/p95 without unbounded growth over a tab's lifetime).
export const MAX_LATENCY_SAMPLES = 200;

export interface IStubPerfStats {
  datasetId: string | null;
  startTime: number;
  elapsedMs: number;

  // HTTP
  httpRequestsFired: number;
  idsFetched: number;
  idsAlreadyCached: number;
  hydrateLatencyMs: number[];

  // Cache
  cacheSize: number;
  cacheCap: number;
  cacheCapacityReached: boolean;
  evictions: number;
  selectedProtected: number;

  // Interaction
  cameraUpdates: number;
  visibilityUpdates: number;
}

export class StubPerf {
  verbose = false;
  // Production builds (DEV === false) disable all tracking → zero hot-path cost
  // and no unbounded latency array. Tunable from DevTools in dev.
  enabled = import.meta.env.DEV;

  datasetId: string | null = null;
  startTime = Date.now();

  httpRequestsFired = 0;
  idsFetched = 0;
  idsAlreadyCached = 0;
  hydrateLatencyMs: number[] = [];

  cacheSize = 0;
  cacheCap = 0;
  cacheCapacityReached = false;
  evictions = 0;
  selectedProtected = 0;

  cameraUpdates = 0;
  visibilityUpdates = 0;

  setDataset(id: string | null) {
    this.datasetId = id;
    this.reset();
  }

  reset() {
    this.startTime = Date.now();
    this.httpRequestsFired = 0;
    this.idsFetched = 0;
    this.idsAlreadyCached = 0;
    this.hydrateLatencyMs = [];
    this.cacheSize = 0;
    this.cacheCap = 0;
    this.cacheCapacityReached = false;
    this.evictions = 0;
    this.selectedProtected = 0;
    this.cameraUpdates = 0;
    this.visibilityUpdates = 0;
  }

  trackRequest(idsToFetch: number, idsAlreadyCached: number) {
    if (!this.enabled) return;
    this.idsAlreadyCached += idsAlreadyCached;
    if (idsToFetch > 0) {
      this.httpRequestsFired += 1;
      this.idsFetched += idsToFetch;
    }
    if (this.verbose) {
      // eslint-disable-next-line no-console
      console.log(
        `[stubPerf] request: fetch=${idsToFetch} cached=${idsAlreadyCached}`,
      );
    }
  }

  trackLatency(ms: number) {
    if (!this.enabled) return;
    this.hydrateLatencyMs.push(ms);
    // Ring buffer: drop the oldest once over the cap so the array can't grow
    // unbounded over the tab's lifetime.
    if (this.hydrateLatencyMs.length > MAX_LATENCY_SAMPLES) {
      this.hydrateLatencyMs.shift();
    }
  }

  trackCache(size: number, cap: number) {
    if (!this.enabled) return;
    this.cacheSize = size;
    this.cacheCap = cap;
    if (cap > 0 && size >= cap) this.cacheCapacityReached = true;
  }

  trackEviction(count: number, protectedCount: number) {
    if (!this.enabled) return;
    this.evictions += count;
    this.selectedProtected += protectedCount;
  }

  trackCameraUpdate() {
    if (!this.enabled) return;
    this.cameraUpdates += 1;
  }

  trackVisibilityUpdate() {
    if (!this.enabled) return;
    this.visibilityUpdates += 1;
  }

  snapshot(): IStubPerfStats {
    return {
      datasetId: this.datasetId,
      startTime: this.startTime,
      elapsedMs: Date.now() - this.startTime,
      httpRequestsFired: this.httpRequestsFired,
      idsFetched: this.idsFetched,
      idsAlreadyCached: this.idsAlreadyCached,
      hydrateLatencyMs: [...this.hydrateLatencyMs],
      cacheSize: this.cacheSize,
      cacheCap: this.cacheCap,
      cacheCapacityReached: this.cacheCapacityReached,
      evictions: this.evictions,
      selectedProtected: this.selectedProtected,
      cameraUpdates: this.cameraUpdates,
      visibilityUpdates: this.visibilityUpdates,
    };
  }

  report() {
    const s = this.snapshot();
    const totalReq = s.idsFetched + s.idsAlreadyCached;
    const hitRate =
      totalReq > 0 ? ((s.idsAlreadyCached / totalReq) * 100).toFixed(1) : "n/a";
    const latencies = s.hydrateLatencyMs.slice().sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
    const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

    /* eslint-disable no-console */
    console.log("=== stubPerf report ===");
    console.log(`dataset: ${s.datasetId ?? "(none)"}`);
    console.log(`elapsed: ${(s.elapsedMs / 1000).toFixed(1)}s`);
    console.log(
      `interaction: ${s.cameraUpdates} camera updates, ${s.visibilityUpdates} visibility updates`,
    );
    console.log("--- HTTP ---");
    console.log(`httpRequestsFired: ${s.httpRequestsFired}`);
    console.log(`idsFetched:        ${s.idsFetched}`);
    console.log(`idsAlreadyCached:  ${s.idsAlreadyCached}`);
    console.log(`cache hit rate:    ${hitRate}%`);
    console.log(
      `latency p50/p95:   ${p50}ms / ${p95}ms (n=${s.hydrateLatencyMs.length})`,
    );
    console.log("--- cache ---");
    console.log(`cacheSize:         ${s.cacheSize}/${s.cacheCap}`);
    console.log(`capacityReached:   ${s.cacheCapacityReached}`);
    console.log(`evictions:         ${s.evictions}`);
    console.log(`selectedProtected: ${s.selectedProtected}`);
    /* eslint-enable no-console */
  }
}

declare global {
  interface Window {
    __stubPerf?: StubPerf;
  }
}

export const stubPerf = new StubPerf();

// Expose on window for DevTools access (dev only — in prod the tracker is a
// no-op, but the handle is harmless and avoids a build-conditional here).
if (typeof window !== "undefined") {
  window.__stubPerf = stubPerf;
}
