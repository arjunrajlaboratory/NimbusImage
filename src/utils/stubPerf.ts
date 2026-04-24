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
 */

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

class StubPerf {
  verbose = false;

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
    this.cacheCapacityReached = false;
    this.evictions = 0;
    this.selectedProtected = 0;
    this.cameraUpdates = 0;
    this.visibilityUpdates = 0;
  }

  trackRequest(idsToFetch: number, idsAlreadyCached: number) {
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
    this.hydrateLatencyMs.push(ms);
  }

  trackCache(size: number, cap: number) {
    this.cacheSize = size;
    this.cacheCap = cap;
    if (cap > 0 && size >= cap) this.cacheCapacityReached = true;
  }

  trackEviction(count: number, protectedCount: number) {
    this.evictions += count;
    this.selectedProtected += protectedCount;
  }

  trackCameraUpdate() {
    this.cameraUpdates += 1;
  }

  trackVisibilityUpdate() {
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
    const hitRate = totalReq > 0 ? ((s.idsAlreadyCached / totalReq) * 100).toFixed(1) : "n/a";
    const latencies = s.hydrateLatencyMs.slice().sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
    const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

    /* eslint-disable no-console */
    console.log("=== stubPerf report ===");
    console.log(`dataset: ${s.datasetId ?? "(none)"}`);
    console.log(`elapsed: ${(s.elapsedMs / 1000).toFixed(1)}s`);
    console.log(`interaction: ${s.cameraUpdates} camera updates, ${s.visibilityUpdates} visibility updates`);
    console.log("--- HTTP ---");
    console.log(`httpRequestsFired: ${s.httpRequestsFired}`);
    console.log(`idsFetched:        ${s.idsFetched}`);
    console.log(`idsAlreadyCached:  ${s.idsAlreadyCached}`);
    console.log(`cache hit rate:    ${hitRate}%`);
    console.log(`latency p50/p95:   ${p50}ms / ${p95}ms (n=${s.hydrateLatencyMs.length})`);
    console.log("--- cache ---");
    console.log(`cacheSize:         ${s.cacheSize}/${s.cacheCap}`);
    console.log(`capacityReached:   ${s.cacheCapacityReached}`);
    console.log(`evictions:         ${s.evictions}`);
    console.log(`selectedProtected: ${s.selectedProtected}`);
    /* eslint-enable no-console */
  }
}

export const stubPerf = new StubPerf();

// Expose on window for DevTools access
if (typeof window !== "undefined") {
  (window as unknown as { __stubPerf: StubPerf }).__stubPerf = stubPerf;
}
