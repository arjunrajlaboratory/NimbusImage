import { describe, it, expect } from "vitest";
import { StubPerf, MAX_LATENCY_SAMPLES } from "@/utils/stubPerf";

describe("StubPerf", () => {
  it("caps hydrateLatencyMs to a ring buffer of the most recent samples", () => {
    const perf = new StubPerf();
    const total = MAX_LATENCY_SAMPLES + 50;
    for (let i = 0; i < total; ++i) {
      perf.trackLatency(i);
    }
    const samples = perf.snapshot().hydrateLatencyMs;
    expect(samples.length).toBe(MAX_LATENCY_SAMPLES);
    // Oldest dropped, newest kept.
    expect(samples[0]).toBe(total - MAX_LATENCY_SAMPLES);
    expect(samples[samples.length - 1]).toBe(total - 1);
  });

  it("reset() also clears cacheCap", () => {
    const perf = new StubPerf();
    perf.trackCache(100, 5000);
    expect(perf.snapshot().cacheCap).toBe(5000);
    perf.reset();
    expect(perf.snapshot().cacheCap).toBe(0);
  });

  it("track* methods are no-ops when disabled (production)", () => {
    const perf = new StubPerf();
    perf.enabled = false;
    perf.trackRequest(10, 5);
    perf.trackLatency(42);
    perf.trackCache(100, 5000);
    perf.trackEviction(3, 1);
    perf.trackCameraUpdate();
    perf.trackVisibilityUpdate();
    const s = perf.snapshot();
    expect(s.httpRequestsFired).toBe(0);
    expect(s.idsFetched).toBe(0);
    expect(s.hydrateLatencyMs).toEqual([]);
    expect(s.cacheCap).toBe(0);
    expect(s.evictions).toBe(0);
    expect(s.cameraUpdates).toBe(0);
    expect(s.visibilityUpdates).toBe(0);
  });

  it("records counters when enabled", () => {
    const perf = new StubPerf();
    perf.enabled = true;
    perf.trackCameraUpdate();
    perf.trackVisibilityUpdate();
    perf.trackRequest(10, 5);
    const s = perf.snapshot();
    expect(s.cameraUpdates).toBe(1);
    expect(s.visibilityUpdates).toBe(1);
    expect(s.httpRequestsFired).toBe(1);
    expect(s.idsFetched).toBe(10);
    expect(s.idsAlreadyCached).toBe(5);
  });
});
