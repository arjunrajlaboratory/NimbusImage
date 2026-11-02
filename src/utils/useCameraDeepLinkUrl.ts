import { watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { RouteLocationNormalized } from "vue-router";
import store from "@/store";
import { CAMERA_DEEP_LINK_QUERY_KEYS } from "@/utils/cameraDeepLink";
import { removeQueryKeys } from "@/utils/useRouteMapper";

function cameraKeys(route: RouteLocationNormalized) {
  return JSON.stringify(
    CAMERA_DEEP_LINK_QUERY_KEYS.map((key) => route.query[key] ?? null),
  );
}

/**
 * Once ImageViewer applies a camera deep link, drop its keys from the URL:
 * left there, a reload or a copied URL would jump back to the linked point
 * after the user has moved on. Only on apply (a navigation's reset clears the
 * pending target while its own view, with its own keys, is still loading),
 * and only from the link that was applied: the removal can wait behind other
 * URL writes, and by then the route may hold another view's link.
 */
export function useCameraDeepLinkUrlCleanup() {
  const route = useRoute();
  const router = useRouter();
  watch(
    () => store.appliedCameraDeepLinks,
    () => {
      const path = route.path;
      const applied = cameraKeys(route);
      removeQueryKeys(
        CAMERA_DEEP_LINK_QUERY_KEYS,
        router,
        route,
        (current) => current.path === path && cameraKeys(current) === applied,
      );
    },
  );
}
