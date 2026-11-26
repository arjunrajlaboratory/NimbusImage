import { watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { RouteLocationNormalized } from "vue-router";
import store from "@/store";
import {
  CAMERA_DEEP_LINK_QUERY_KEYS,
  IAppliedCameraDeepLink,
  parseCameraDeepLink,
} from "@/utils/cameraDeepLink";
import { removeQueryKeys } from "@/utils/useRouteMapper";

/**
 * Whether the route still carries the link that was applied: the same point
 * and size, for the same view (the route's own view id where it has one; on
 * a share route, the view the store holds, which the share's token picks).
 * Another view's link with the same numbers is not this one.
 */
export function routeCarriesCameraDeepLink(
  route: RouteLocationNormalized,
  applied: IAppliedCameraDeepLink,
): boolean {
  const link = parseCameraDeepLink(route.query);
  const routeViewId = route.params.datasetViewId;
  const viewId =
    typeof routeViewId === "string" ? routeViewId : store.datasetView?.id;
  return (
    !!link &&
    link.x === applied.x &&
    link.y === applied.y &&
    link.zoom === applied.zoom &&
    link.width === applied.width &&
    viewId === applied.datasetViewId &&
    store.datasetView?.datasetId === applied.datasetId
  );
}

/**
 * Once ImageViewer applies a camera deep link, drop its keys from the URL:
 * left there, a reload or a copied URL would jump back to the linked point
 * after the user has moved on. Only on apply (a navigation's reset clears the
 * pending target while its own view, with its own keys, is still loading),
 * and only while the URL still carries that very link: the removal can wait
 * behind other URL writes, and by then the route may hold another link.
 */
export function useCameraDeepLinkUrlCleanup() {
  const route = useRoute();
  const router = useRouter();
  watch(
    () => store.appliedCameraDeepLink,
    (applied) => {
      if (!applied) {
        return;
      }
      // The path too: on a share route the view id comes from the store,
      // which still holds the old share while another share's link loads.
      const path = route.path;
      removeQueryKeys(
        CAMERA_DEEP_LINK_QUERY_KEYS,
        router,
        route,
        (current) =>
          current.path === path && routeCarriesCameraDeepLink(current, applied),
      );
    },
  );
}
