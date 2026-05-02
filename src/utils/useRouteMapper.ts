import { watch, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { Router, RouteLocationNormalized } from "vue-router";
import { logError } from "./log";
import { awaitPreviousCallsDecorator } from "./lock";

export interface IMapper<T> {
  parse(value: string): T;
  get(): T | null;
  set(value: T | null): Promise<any>;
}

// This counter is used to avoid loops of changes to the URL and changes to the mapper values
// It counts how many instances of syncFromRoute are being called
let currentRouteChanges = 0;

// Counts in-flight Store→URL writes. While > 0, the URL is mid-transition
// because of our own router.replace() calls — skip URL→Store sync to avoid
// reading a stale URL value (a previously-queued router.replace that just
// resolved) and writing it back over a newer store value. Without this guard,
// rapid slider scrubbing causes store.time/xy/z to ping-pong as queued URL
// writes drain, because each fullPath change triggers syncFromRoute which
// reads the (now-outdated) URL value and overwrites the user's latest input.
let pendingUrlWrites = 0;

// Avoid "navigation cancelled" errors by doing calls to router.replace() one at a time
const setUrlParamsOrQuery = awaitPreviousCallsDecorator(
  async (
    type: "query" | "params",
    key: string,
    value: string,
    router: Router,
    route: RouteLocationNormalized,
  ) => {
    const stringifiedValue = String(value);
    if (stringifiedValue === route[type][key]) {
      return;
    }
    const replacement = {
      params: { ...route.params },
      query: { ...route.query },
    };
    replacement[type][key] = stringifiedValue;
    pendingUrlWrites++;
    try {
      await router.replace(replacement);
    } finally {
      pendingUrlWrites--;
    }
  },
);

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
  if (parsedUrlValue == currentValue) {
    return;
  }
  return obj.set(parsedUrlValue);
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
 *   from firing during URL→store sync
 */
export function useRouteMapper(
  paramsMapper: Record<string, IMapper<any>>,
  queryMapper: Record<string, IMapper<any>> = {},
) {
  const route = useRoute();
  const router = useRouter();

  // URL → Store sync
  async function syncFromRoute(r: RouteLocationNormalized) {
    // Skip if our own Store→URL writes are still draining — the URL value we
    // would read here is stale, and writing it back to the store would clobber
    // the user's newer input (e.g., during fast slider scrubbing).
    if (pendingUrlWrites > 0) {
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
    }
  }

  // Store → URL sync via watchers on computed refs
  for (const [key, mapper] of Object.entries(paramsMapper)) {
    const c = computed(() => mapper.get());
    watch(c, async (value: any) => {
      if (currentRouteChanges > 0) return;
      // Never write null into path params — String(null) = "null" which
      // creates invalid URLs like /datasetView/null/view and triggers
      // cascading failed API calls.
      if (value == null) return;
      await setUrlParamsOrQuery("params", key, value, router, route);
    });
  }
  for (const [key, mapper] of Object.entries(queryMapper)) {
    const c = computed(() => mapper.get());
    watch(c, async (value: any) => {
      if (currentRouteChanges > 0) return;
      await setUrlParamsOrQuery("query", key, value, router, route);
    });
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
