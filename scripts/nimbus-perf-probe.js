/* nimbus-perf-probe.js — deterministic in-browser render-perf probe for NimbusImage
 * ---------------------------------------------------------------------------------
 * This is the "evaluator floor" for a performance loop: a fixed, repeatable scenario
 * that emits a stable, non-gameable number you can gate a /goal-style "say no" on.
 * See codebaseDocumentation/PERFORMANCE_PROBE.md for the findings, baselines, and the
 * loop-engineering rationale.
 *
 * USAGE
 *   1. Open a dataset in NimbusImage in a FOREGROUND / VISIBLE tab (see Lesson 1).
 *   2. Paste this whole file into the devtools console (or inject via a browser
 *      automation tool's "evaluate" call). It installs window.__nimbusPerf.
 *   3. Run:  await __nimbusPerf.run()
 *      or:   await __nimbusPerf.run({ scenarios: ['pan','zoom'], warmups: 2, reps: 5 })
 *      or:   await __nimbusPerf.run({ scenarios: [['zScrub',{zs:[3,4]}]] })
 *   4. Compare result.summary against a committed baseline.json.
 *
 * THREE HARD-WON LESSONS (each baked into the code below — they are the difference
 * between a trustworthy "say no" and a random one):
 *
 *   Lesson 1 — VISIBILITY. A hidden/background tab pauses requestAnimationFrame,
 *   throttles setTimeout to ~1 Hz, and the compositor never paints — so the probe
 *   reports 0 long tasks / "all green" even when rendering is actually broken.
 *   That is the single most dangerous false-pass (a loop's "nodding" failure).
 *   => run() refuses to measure unless document.visibilityState === 'visible'.
 *
 *   Lesson 2 — FIRE, DON'T AWAIT store actions. setTime/setZ/setXY await a network
 *   PUT (updateLastLocationInDatasetView -> /dataset_view, src/store/index.ts) that is
 *   decoupled from the visible render. Awaiting per-step (a) conflates backend latency
 *   with render cost and (b) blows past automation eval timeouts. So scenarios dispatch
 *   and DO NOT await. (Side finding: every scrub step fires a dataset_view PUT — a
 *   debounce candidate.)
 *
 *   Lesson 3 — WARM UP + MEDIAN. Single runs are noise: the first run after idle is
 *   ~2x slower (cold caches + GC), so one-shot A/B comparisons produce false deltas
 *   (we observed a bogus 4x: 896 ms vs 230 ms, entirely cold-vs-warm). So runScenario
 *   discards `warmups` runs, then reports the MEDIAN of `reps` warm runs plus the
 *   spread, so the gated number is stable.
 *
 * MEASUREMENT SURFACE (discovered handles; valid as of the stub-annotations branch):
 *   store         document.querySelector('#app').__vue_app__.config.globalProperties.$store
 *   geojs map     store.state.main.maps[0].map   (.zoom/.center/.bounds/.geoOn/.onIdle)
 *                 NB: window.geojsMap is a jQuery red herring; .onIdle hangs if already idle.
 *   nav actions   store.dispatch('setTime'|'setZ'|'setXY', n)   (un-namespaced)
 *   mem snapshot  window.__nimbusMem.snapshot(label) -> { jsHeapUsed, annotations,
 *                 annotationCentroids, imageCache, histogramCache, ... }
 */
(() => {
  const app = document.querySelector("#app");
  const store = app && app.__vue_app__ && app.__vue_app__.config.globalProperties.$store;
  if (!store) {
    console.error("[nimbusPerf] Vuex store not found — is a dataset open?");
    return;
  }

  const P = {
    store,
    map: () => store.state.main.maps[0].map, // live GeoJS map instance
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    nextFrame: () => new Promise((r) => requestAnimationFrame(() => r())),
    pct(arr, p) {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
    },
    median(arr) {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    },

    /* Measure one execution of `fn`. Samples frame intervals via rAF (valid only when
     * visible — Lesson 1) and main-thread stalls via PerformanceObserver('longtask'). */
    async measure(label, fn, settleMs = 300) {
      const longtasks = [];
      let po = null;
      try {
        po = new PerformanceObserver((l) => {
          for (const e of l.getEntries()) longtasks.push(e.duration);
        });
        po.observe({ type: "longtask", buffered: false });
      } catch (e) {}
      const ft = [];
      let run = true;
      const loop = (t) => { ft.push(t); if (run) requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      const mb = window.__nimbusMem.snapshot(label + ":before");
      const t0 = performance.now();
      await fn();
      await this.sleep(settleMs);
      const t1 = performance.now();
      run = false;
      if (po) po.disconnect();
      const ma = window.__nimbusMem.snapshot(label + ":after");
      const iv = [];
      for (let i = 1; i < ft.length; i++) iv.push(ft[i] - ft[i - 1]);
      const el = t1 - t0;
      return {
        label,
        elapsedMs: +el.toFixed(0),
        fps: +(ft.length / (el / 1000)).toFixed(1),
        frameMedianMs: this.pct(iv, 0.5),
        frameP95Ms: this.pct(iv, 0.95),
        frameMaxMs: iv.length ? +Math.max(...iv).toFixed(1) : null,
        longtasks: longtasks.length,
        totalBlockingMs: +longtasks.reduce((a, b) => a + b, 0).toFixed(0),
        maxBlockMs: longtasks.length ? +Math.max(...longtasks).toFixed(0) : 0,
        heapBeforeMB: +(mb.jsHeapUsed / 1048576).toFixed(1),
        heapAfterMB: +(ma.jsHeapUsed / 1048576).toFixed(1),
        heapDeltaMB: +((ma.jsHeapUsed - mb.jsHeapUsed) / 1048576).toFixed(1),
      };
    },

    /* Deterministic interactions. All dispatch-and-fire (Lesson 2); all rAF-paced. */
    scenarios: {
      // step through time indices (fire setTime, 2 paints/step)
      timeScrub: async (P, { from = 0, to = 20 } = {}) => {
        for (let t = from; t <= to; t++) { P.store.dispatch("setTime", t); await P.nextFrame(); await P.nextFrame(); }
      },
      // alternate between z slices N times (the "load/reload" churn)
      zScrub: async (P, { zs = [3, 4], cycles = 4 } = {}) => {
        for (let c = 0; c < cycles; c++) for (const z of zs) {
          P.store.dispatch("setZ", z);
          await P.nextFrame(); await P.nextFrame(); await P.nextFrame();
          await P.sleep(60);
        }
      },
      // sinusoidal pan, amplitude = fraction of visible width (viewport-relative)
      pan: async (P, { frac = 0.4, steps = 40 } = {}) => {
        const m = P.map(); const c0 = m.center(); const b = m.bounds();
        const amp = frac * Math.abs(b.right - b.left);
        for (let i = 0; i <= steps; i++) { m.center({ x: c0.x + amp * Math.sin((i / steps) * Math.PI * 2), y: c0.y }); await P.nextFrame(); }
        m.center(c0);
      },
      // zoom in by `delta` and back out (triggers viewport hydration / budget refill)
      zoom: async (P, { delta = 2.5, steps = 40 } = {}) => {
        const m = P.map(); const z0 = m.zoom();
        for (let i = 0; i <= steps; i++) { m.zoom(z0 + delta * Math.sin((i / steps) * Math.PI)); await P.nextFrame(); }
        m.zoom(z0);
      },
    },

    /* Run one scenario: warm up (discarded), then median of `reps` warm runs (Lesson 3). */
    async runScenario(name, opts = {}, { warmups = 1, reps = 5 } = {}) {
      const fn = () => this.scenarios[name](this, opts);
      const warm = [];
      for (let i = 0; i < warmups; i++) { await this.measure(`${name}:warmup${i}`, fn, 300); await this.sleep(250); }
      for (let i = 0; i < reps; i++) { warm.push(await this.measure(`${name}:rep${i}`, fn, 300)); await this.sleep(250); }
      const pick = (k) => this.median(warm.map((r) => r[k]));
      return {
        scenario: name, opts, reps,
        median: { maxBlockMs: pick("maxBlockMs"), totalBlockingMs: pick("totalBlockingMs"), frameMaxMs: pick("frameMaxMs"), frameP95Ms: pick("frameP95Ms"), fps: pick("fps") },
        spread: { maxBlockMin: Math.min(...warm.map((r) => r.maxBlockMs)), maxBlockMax: Math.max(...warm.map((r) => r.maxBlockMs)) },
        runs: warm,
      };
    },

    context() {
      const s = this.store.state;
      return {
        dataset: s.main.dataset && s.main.dataset.name,
        z: s.main.z, time: s.main.time, xy: s.main.xy,
        zoom: +this.map().zoom().toFixed(2),
        stubOnlyMode: s.annotation.stubOnlyMode,
        annotations: (s.annotation.annotations || []).length,
        centroids: Object.keys(s.annotation.annotationCentroids || {}).length,
        heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(0),
      };
    },

    async run({ scenarios = ["timeScrub", "pan", "zoom"], warmups = 1, reps = 5 } = {}) {
      if (document.visibilityState !== "visible") { // Lesson 1
        return { error: "TAB NOT VISIBLE — bring the NimbusImage tab to the foreground; rAF/paint are paused while hidden and the probe would report a false pass." };
      }
      const out = { context: this.context(), results: {} };
      for (const sc of scenarios) {
        const [name, opts] = Array.isArray(sc) ? sc : [sc, {}];
        out.results[name] = await this.runScenario(name, opts, { warmups, reps });
      }
      out.summary = Object.fromEntries(Object.entries(out.results).map(([k, v]) => [k, v.median]));
      return out;
    },
  };

  window.__nimbusPerf = P;
  console.log("[nimbusPerf] installed. Run: await __nimbusPerf.run()");
  return "installed";
})();
