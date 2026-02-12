import { getCurrentInstance, watch, onMounted, computed } from "vue";
import type VueRouter from "vue-router";
import type { Route } from "vue-router";
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

// Avoid "navigation cancelled" errors by doing calls to router.replace() one at a time
const setUrlParamsOrQuery = awaitPreviousCallsDecorator(
  async (
    type: "query" | "params",
    key: string,
    value: string,
    router: VueRouter,
    route: Route,
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
    await router.replace(replacement);
  },
);

// Call the setter for this mapper if needed, using the value from the URL
function setMapperValueFromUrl(
  obj: IMapper<any>,
  urlValue: string | undefined,
) {
  if (urlValue === undefined) {
    return;
  }
  const parsedUrlValue = obj.parse(urlValue);
  const currentValue = obj.get();
  if (parsedUrlValue == currentValue) {
    return;
  }
  return obj.set(parsedUrlValue);
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
  const vm = getCurrentInstance()!.proxy;

  // URL → Store sync
  async function syncFromRoute(route: Route) {
    currentRouteChanges++;
    try {
      const promises = [
        ...Object.entries(paramsMapper).map(([key, mapper]) =>
          setMapperValueFromUrl(mapper, route.params[key]),
        ),
        ...Object.entries(queryMapper).map(([key, mapper]) =>
          setMapperValueFromUrl(mapper, route.query[key] as string | undefined),
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
      await setUrlParamsOrQuery("params", key, value, vm.$router, vm.$route);
    });
  }
  for (const [key, mapper] of Object.entries(queryMapper)) {
    const c = computed(() => mapper.get());
    watch(c, async (value: any) => {
      if (currentRouteChanges > 0) return;
      await setUrlParamsOrQuery("query", key, value, vm.$router, vm.$route);
    });
  }

  // Replace beforeRouteUpdate
  watch(
    () => vm.$route,
    (newRoute: Route) => syncFromRoute(newRoute),
  );

  // Replace beforeRouteEnter
  onMounted(() => syncFromRoute(vm.$route));
}
