import { watch, computed, onScopeDispose } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { Router, RouteLocationNormalized } from "vue-router";
import { logError } from "./log";
import { awaitPreviousCallsDecorator } from "./lock";

export interface IMapper<T> {
  parse(value: string): T;
  get(): T | null;
  set(value: T | null): Promise<any>;
  /**
   * Query keys that describe the current value only, dropped in the same URL
   * write when the store changes this value (e.g. a view's camera target,
   * which must not follow a store-driven switch to another view).
   */
  clearsQuery?: readonly string[];
}

// This counter is used to avoid loops of changes to the URL and changes to the mapper values
// It counts how many instances of syncFromRoute are being called
let currentRouteChanges = 0;

// Run when currentRouteChanges returns to 0: each writes the Store→URL
// changes its instance skipped while a route change was being applied (a
// value the store changed on its own meanwhile, such as a clamp or the user
// scrubbing while a view loads), so the URL does not keep the old value.
const onRouteChangesSettled: Array<() => void> = [];

// Counts in-flight Store→URL writes. While > 0, the URL is mid-transition
// because of our own router.replace() calls — skip URL→Store sync to avoid
// reading a stale URL value (a previously-queued router.replace that just
// resolved) and writing it back over a newer store value. Without this guard,
// rapid slider scrubbing causes store.time/xy/z to ping-pong as queued URL
// writes drain, because each fullPath change triggers syncFromRoute which
// reads the (now-outdated) URL value and overwrites the user's latest input.
let pendingUrlWrites = 0;

// Callbacks to run when pendingUrlWrites returns to 0 AND stays there for
// DRAIN_DEBOUNCE_MS. A syncFromRoute that is skipped because writes are
// still in flight registers itself here and re-runs once the URL has
// settled — without this, a real external URL change (browser back/forward,
// manual edit) landing during the drain window is silently dropped and the
// store stays out of sync with the URL until some unrelated future route
// change happens.
//
// The debounce is critical for fast slider scrubs: each router.replace
// resolves with the URL at *that* tick's value, while later ticks are still
// queued behind it. If the drain fires the moment pendingUrlWrites hits 0
// (between every queued replace), syncFromRoute reads the now-stale URL
// value and writes it to the store via mapper.set — clobbering the user's
// most recent input. That manifests as render stutter because every
// scrub tick triggers two store writes (user → store, then stale URL →
// store) and double the render churn. See PR #1129 follow-up for the log
// trace that motivated this.
const onDrainCallbacks: Array<() => void> = [];
const DRAIN_DEBOUNCE_MS = 100;
let drainTimer: ReturnType<typeof setTimeout> | null = null;

function notifyDrainIfIdle() {
  if (pendingUrlWrites !== 0 || onDrainCallbacks.length === 0) {
    return;
  }
  // Debounce: each call resets the timer. Continuous router.replace
  // activity (fast slider scrub) keeps resetting it, so the callbacks
  // only fire once the writer has been quiet for DRAIN_DEBOUNCE_MS.
  if (drainTimer !== null) {
    clearTimeout(drainTimer);
  }
  drainTimer = setTimeout(() => {
    drainTimer = null;
    // Re-check: a write may have started between schedule and fire.
    if (pendingUrlWrites !== 0 || onDrainCallbacks.length === 0) {
      return;
    }
    const drained = onDrainCallbacks.splice(0);
    for (const cb of drained) {
      cb();
    }
  }, DRAIN_DEBOUNCE_MS);
}

// Avoid "navigation cancelled" errors by doing calls to router.replace() one
// at a time. Every URL write goes through this one lock (each
// awaitPreviousCallsDecorator wrap has its own chain), and `edit` reads
// `route` when the write runs, so a queued write never undoes an earlier one.
// `edit` changes the copied params/query and returns false for no change.
const writeUrl = awaitPreviousCallsDecorator(
  async (
    router: Router,
    route: RouteLocationNormalized,
    edit: (replacement: {
      params: RouteLocationNormalized["params"];
      query: RouteLocationNormalized["query"];
    }) => boolean,
  ) => {
    const replacement = {
      params: { ...route.params },
      query: { ...route.query },
    };
    if (!edit(replacement)) {
      return;
    }
    pendingUrlWrites++;
    try {
      await router.replace(replacement);
    } finally {
      pendingUrlWrites--;
      notifyDrainIfIdle();
    }
  },
);

function setUrlParamsOrQuery(
  type: "query" | "params",
  key: string,
  value: string,
  router: Router,
  route: RouteLocationNormalized,
  clearsQuery: readonly string[] = [],
) {
  return writeUrl(router, route, (replacement) => {
    const stringifiedValue = String(value);
    if (stringifiedValue === route[type][key]) {
      return false;
    }
    replacement[type][key] = stringifiedValue;
    for (const queryKey of clearsQuery) {
      delete replacement.query[queryKey];
    }
    return true;
  });
}

/**
 * Remove query keys from the URL through the same lock as the mappers'
 * writes (and counted in pendingUrlWrites), so neither cancels the other.
 * The removal may wait behind other writes and run on a later route:
 * `onlyIf` (given the route when it runs) skips it when that route is no
 * longer the one it was meant for.
 */
export function removeQueryKeys(
  keys: readonly string[],
  router: Router,
  route: RouteLocationNormalized,
  onlyIf: (current: RouteLocationNormalized) => boolean = () => true,
) {
  return writeUrl(router, route, (replacement) => {
    if (!onlyIf(route) || !keys.some((key) => key in replacement.query)) {
      return false;
    }
    for (const key of keys) {
      delete replacement.query[key];
    }
    return true;
  });
}

// Values this module has passed to a mapper's set() that have not settled
// yet. While one of them differs from the URL's value, "the URL equals the
// store" does not mean "nothing to do": the store is about to be replaced by
// that navigation, and the URL's value must be set again to overtake it
// (view S, open T, back to S before T's view arrives: the store still holds
// S). Only this module's own calls count. A store-driven switch (a snapshot,
// the breadcrumbs) leaves the URL on the old value until it lands, and an
// unrelated URL write in that window must not cancel it.
const pendingSets = new WeakMap<IMapper<any>, any[]>();

function hasPendingSetToAnother(obj: IMapper<any>, value: any): boolean {
  return (pendingSets.get(obj) ?? []).some((pending) => pending != value);
}

function trackedSet(obj: IMapper<any>, value: any) {
  const pending = pendingSets.get(obj) ?? [];
  pendingSets.set(obj, pending);
  pending.push(value);
  const settle = () => {
    pending.splice(pending.indexOf(value), 1);
  };
  let result;
  try {
    result = obj.set(value);
  } catch (error) {
    settle();
    throw error;
  }
  // Watched on the side: the caller awaits set()'s own promise, unchanged
  Promise.resolve(result).then(settle, settle);
  return result;
}

// Call the setter for this mapper if needed, using the value from the URL
function setMapperValueFromUrl(
  obj: IMapper<any>,
  urlValue: string | undefined,
) {
  if (urlValue == null || urlValue === "null") {
    return;
  }
  const parsedUrlValue = obj.parse(urlValue);
  const currentValue = obj.get();
  if (
    parsedUrlValue == currentValue &&
    !hasPendingSetToAnother(obj, parsedUrlValue)
  ) {
    return;
  }
  return trackedSet(obj, parsedUrlValue);
}

// Check if any mapper's store value differs from the URL value
function needsSync(
  paramsMapper: Record<string, IMapper<any>>,
  queryMapper: Record<string, IMapper<any>>,
  route: RouteLocationNormalized,
): boolean {
  for (const [key, mapper] of Object.entries(paramsMapper)) {
    const urlValue = route.params[key] as string | undefined;
    if (urlValue == null || urlValue === "null") continue;
    if (mapper.parse(urlValue) != mapper.get()) return true;
  }
  for (const [key, mapper] of Object.entries(queryMapper)) {
    const urlValue = route.query[key] as string | undefined;
    if (urlValue == null || urlValue === "null") continue;
    if (mapper.parse(urlValue) != mapper.get()) return true;
  }
  return false;
}

/**
 * Composable replacing the routeMapper mixin.
 * Syncs route params/query with store values via mapper objects.
 *
 * - URL → Store: on mount and on route change
 * - Store → URL: via watchers on computed refs from mapper.get()
 * - Loop prevention: currentRouteChanges counter prevents store→URL watchers
 *   from writing during URL→store sync; what they skipped is written once
 *   every sync has settled
 */
export function useRouteMapper(
  paramsMapper: Record<string, IMapper<any>>,
  queryMapper: Record<string, IMapper<any>> = {},
) {
  const route = useRoute();
  const router = useRouter();

  // Per-instance flags so we can safely register a one-shot drain callback
  // (no duplicates per instance) and skip it if the component has already
  // unmounted by the time the drain fires.
  let drainReplayQueued = false;
  let isAlive = true;
  onScopeDispose(() => {
    isAlive = false;
  });

  // URL → Store sync
  async function syncFromRoute(r: RouteLocationNormalized) {
    // Skip if our own Store→URL writes are still draining — the URL value we
    // would read here is stale, and writing it back to the store would clobber
    // the user's newer input (e.g., during fast slider scrubbing). We
    // register a one-shot replay so a real external URL change that arrives
    // during the drain window doesn't get permanently dropped.
    if (pendingUrlWrites > 0) {
      if (!drainReplayQueued) {
        drainReplayQueued = true;
        onDrainCallbacks.push(() => {
          drainReplayQueued = false;
          if (isAlive) {
            // Use the current route, not the (possibly stale) `r` from when
            // this was originally skipped — `route` is reactive and reflects
            // the URL state right now.
            syncFromRoute(route);
          }
        });
      }
      return;
    }
    currentRouteChanges++;
    try {
      const promises = [
        ...Object.entries(paramsMapper).map(([key, mapper]) =>
          setMapperValueFromUrl(mapper, r.params[key] as string | undefined),
        ),
        ...Object.entries(queryMapper).map(([key, mapper]) =>
          setMapperValueFromUrl(mapper, r.query[key] as string | undefined),
        ),
      ];
      await Promise.all(promises);
    } catch (e) {
      logError(e);
    } finally {
      currentRouteChanges--;
      if (currentRouteChanges === 0) {
        for (const cb of onRouteChangesSettled.splice(0)) {
          cb();
        }
      }
    }
  }

  // Store → URL sync via watchers on computed refs
  function writeToUrl(
    type: "params" | "query",
    key: string,
    mapper: IMapper<any>,
    value: any,
  ) {
    // Never write null into path params — String(null) = "null" which
    // creates invalid URLs like /datasetView/null/view and triggers
    // cascading failed API calls.
    if (type === "params" && value == null) return;
    return setUrlParamsOrQuery(
      type,
      key,
      value,
      router,
      route,
      mapper.clearsQuery,
    );
  }

  // Store → URL writes skipped while a route change was applied, replayed
  // with the store's value once every route change has settled. A value the
  // route change itself set matches the URL by then, so its replay is a no-op.
  const skippedWrites = new Map<
    string,
    { type: "params" | "query"; key: string; mapper: IMapper<any> }
  >();
  function replaySkippedWrites() {
    const writes = [...skippedWrites];
    skippedWrites.clear();
    if (!isAlive) return;
    for (const [, { type, key, mapper }] of writes) {
      writeToUrl(type, key, mapper, mapper.get());
    }
  }

  for (const [type, mappers] of [
    ["params", paramsMapper],
    ["query", queryMapper],
  ] as const) {
    for (const [key, mapper] of Object.entries(mappers)) {
      const c = computed(() => mapper.get());
      watch(c, async (value: any) => {
        if (currentRouteChanges > 0) {
          if (skippedWrites.size === 0) {
            onRouteChangesSettled.push(replaySkippedWrites);
          }
          skippedWrites.set(`${type}:${key}`, { type, key, mapper });
          return;
        }
        await writeToUrl(type, key, mapper, value);
      });
    }
  }

  // Replace beforeRouteUpdate — watch fullPath so param changes within the
  // same route name are detected (reactive proxy identity never changes).
  watch(
    () => route.fullPath,
    () => syncFromRoute(route),
  );

  // Sync from route during setup (not onMounted) so that store setters
  // (e.g., setDatasetViewId which sets datasetLoading=true) run before
  // child components mount. Vue lifecycle order is: parent setup → child
  // setup → child onMounted → parent onMounted. If we wait for onMounted,
  // child components (like ImageViewer) mount and draw stale data before
  // the store knows a transition is happening.
  //
  // Skip the sync if all store values already match the URL. This prevents
  // expensive cascading re-fetches during HMR: editing this file triggers
  // HMR for all 7+ importing components, and each syncFromRoute would call
  // setDatasetViewId (which re-fetches dataset, config, annotations, tiles).
  if (needsSync(paramsMapper, queryMapper, route)) {
    syncFromRoute(route);
  }
}

// Self-accept HMR updates to prevent cascading re-mounts of all importing
// components. Without this, editing useRouteMapper.ts triggers HMR for every
// route component (DatasetView, Viewer, Project, etc.), causing the entire
// component tree (ImageViewer, tiles, annotations) to be torn down and rebuilt,
// which freezes the browser. Existing component instances continue using their
// captured closures (store/router refs are singletons, so they stay valid).
if (import.meta.hot) {
  import.meta.hot.accept();
}
