import { useRoute } from "vue-router";
import store from "@/store";
import { ITourMetadata } from "@/store/model";

// Shared predicates for where commands apply, so the palette and the menus
// that offer the same things can't drift apart.

export interface IProviderContext {
  // True on the dataset view with a dataset loaded — the only place the
  // panels, tools and layers these commands act on are mounted.
  inViewer: () => boolean;
}

export function isViewerRoute(routeName: unknown): boolean {
  return routeName === "datasetview";
}

export function useViewerContext(routeName: () => unknown): IProviderContext {
  return { inViewer: () => isViewerRoute(routeName()) && !!store.dataset };
}

/**
 * `inViewer` for a component that registers commands. Needed by anything
 * inside a right-hand FloatingPalette (Settings, Object Browser, Snapshots):
 * those palettes stay mounted on every route, so "registered by a viewer
 * component" does not imply "only in the viewer".
 */
export function useInViewer(): () => boolean {
  const route = useRoute();
  return useViewerContext(() => route?.name).inViewer;
}

/**
 * Whether a tour can start from this route: a dataset-view tour needs the
 * dataset view; every other tour navigates to its own entry point.
 */
export function isTourAvailableOnRoute(
  tour: ITourMetadata,
  routeName: unknown,
): boolean {
  return tour.entryPoint !== "datasetview" || isViewerRoute(routeName);
}
