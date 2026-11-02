import { watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { RouteLocationNormalized } from "vue-router";
import store from "@/store";
import {
  CAMERA_DEEP_LINK_QUERY_KEYS,
  IPendingCameraDeepLink,
  parseCameraDeepLink,
} from "@/utils/cameraDeepLink";
import { removeQueryKeys } from "@/utils/useRouteMapper";

/** Whether the route still carries the link that was applied. */
export function routeCarriesCameraDeepLink(
  route: RouteLocationNormalized,
  applied: IPendingCameraDeepLink,
): boolean {
  const link = parseCameraDeepLink(route.query);
  return (
    !!link &&
    link.x === applied.x &&
    link.y === applied.y &&
    link.zoom === applied.zoom &&
    link.width === applied.width &&
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
      removeQueryKeys(CAMERA_DEEP_LINK_QUERY_KEYS, router, route, (current) =>
        routeCarriesCameraDeepLink(current, applied),
      );
    },
  );
}
