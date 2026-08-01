import type {
  IAnalysisGate,
  IAnalysisPlot,
  IAnnotationBrowserConfig,
  IPropertyAnnotationFilter,
  TAnalysisAxis,
} from "@/store/model";
import { ANALYSIS_CATEGORY_KEY_VERSION } from "@/store/model";
import { isCategoricalAxisKey } from "@/utils/analysisAxes";
import { isEncodedAnalysisCategoryKey } from "@/utils/analysisGating";
import { createPathStringFromPathArray } from "@/utils/paths";

// Assemble the annotation-browser state to persist in the configuration.
// Only filters backing a visible row (path present in filterPaths) belong to
// configuration metadata. Filters created by chat remain session-only.
export function buildAnnotationBrowserConfig(
  displayedPropertyPaths: string[][],
  filterPaths: string[][],
  propertyFilters: IPropertyAnnotationFilter[],
  analysisPlots: IAnalysisPlot[],
): IAnnotationBrowserConfig {
  const visiblePaths = new Set(filterPaths.map(createPathStringFromPathArray));
  return {
    displayedPropertyPaths: [...displayedPropertyPaths],
    filterPaths: [...filterPaths],
    propertyFilters: propertyFilters.filter((filter) =>
      visiblePaths.has(createPathStringFromPathArray(filter.propertyPath)),
    ),
    // Only the gate polygon travels, never the annotation ids it resolves to —
    // ids belong to one dataset and this configuration is shared by all of
    // them. See IAnalysisGate.
    analysisPlots: analysisPlots.map((plot) => ({
      id: plot.id,
      xAxis: plot.xAxis,
      yAxis: plot.yAxis,
      gate: plot.gate,
      gateEnabled: plot.gateEnabled,
    })),
  };
}

// Validate a persisted annotation-browser config coming from the server: drop
// malformed entries, paths referencing properties no longer part of the
// configuration, and property filters outside the persisted browser rows.
export function resolveAnnotationBrowserConfig(
  config: Partial<IAnnotationBrowserConfig> | undefined,
  propertyIds: string[],
): IAnnotationBrowserConfig {
  const knownIds = new Set(propertyIds);
  const isKnownPath = (path: unknown): path is string[] =>
    Array.isArray(path) &&
    path.length > 0 &&
    path.every((segment) => typeof segment === "string") &&
    knownIds.has(path[0]);
  const asArray = <T>(value: T[] | undefined): T[] =>
    Array.isArray(value) ? value : [];

  const displayedPropertyPaths = asArray(config?.displayedPropertyPaths).filter(
    isKnownPath,
  );
  const filterPaths = asArray(config?.filterPaths).filter(isKnownPath);
  const visiblePaths = new Set(filterPaths.map(createPathStringFromPathArray));
  const propertyFilters = asArray(config?.propertyFilters).filter(
    (filter) =>
      isKnownPath(filter?.propertyPath) &&
      visiblePaths.has(createPathStringFromPathArray(filter.propertyPath)),
  );

  return {
    displayedPropertyPaths,
    filterPaths,
    propertyFilters,
    analysisPlots: asArray(config?.analysisPlots)
      .map((plot) => resolveAnalysisPlot(plot, isKnownPath))
      .filter((plot): plot is IAnalysisPlot => plot !== null),
  };
}

// An axis survives only if it still resolves: a property axis whose property
// left the configuration would plot nothing, and an unknown categorical key
// would fall through the category identity builder and yield undefined.
function resolveAxis(
  axis: unknown,
  isKnownPath: (path: unknown) => path is string[],
): TAnalysisAxis | null {
  if (!axis || typeof axis !== "object") {
    return null;
  }
  const candidate = axis as { type?: unknown; path?: unknown; key?: unknown };
  if (candidate.type === "property" && isKnownPath(candidate.path)) {
    return { type: "property", path: candidate.path };
  }
  if (isCategoricalAxisKey(candidate.key) && candidate.type === "categorical") {
    return { type: "categorical", key: candidate.key };
  }
  return null;
}

type TResolvedGateCandidate = Omit<IAnalysisGate, "categoryKeyVersion"> & {
  categoryKeyVersion: unknown;
};

function resolveGate(gate: unknown): TResolvedGateCandidate | null {
  if (!gate || typeof gate !== "object") {
    return null;
  }
  const candidate = gate as {
    categoryKeyVersion?: unknown;
    vertices?: unknown;
    xCategories?: unknown;
    yCategories?: unknown;
  };
  // Fewer than 3 vertices bounds no area, so such a gate could only ever select
  // nothing — drop it rather than persisting a filter that hides everything.
  if (!Array.isArray(candidate.vertices) || candidate.vertices.length < 3) {
    return null;
  }
  const vertices = candidate.vertices.filter(
    (vertex): vertex is { x: number; y: number } =>
      !!vertex &&
      typeof vertex === "object" &&
      typeof (vertex as { x?: unknown }).x === "number" &&
      typeof (vertex as { y?: unknown }).y === "number",
  );
  if (vertices.length !== candidate.vertices.length) {
    return null;
  }
  const categories = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? value
      : null;
  return {
    categoryKeyVersion: candidate.categoryKeyVersion,
    vertices: vertices.map(({ x, y }) => ({ x, y })),
    xCategories: categories(candidate.xCategories),
    yCategories: categories(candidate.yCategories),
  };
}

function categoryOrderMatchesAxis(
  axis: TAnalysisAxis,
  categories: string[] | null,
  categoryKeyVersion: unknown,
): boolean {
  return axis.type === "property"
    ? categories === null
    : categories !== null &&
        categoryKeyVersion === ANALYSIS_CATEGORY_KEY_VERSION &&
        new Set(categories).size === categories.length &&
        categories.every(isEncodedAnalysisCategoryKey);
}

function resolveAnalysisPlot(
  plot: unknown,
  isKnownPath: (path: unknown) => path is string[],
): IAnalysisPlot | null {
  if (!plot || typeof plot !== "object") {
    return null;
  }
  const candidate = plot as Partial<IAnalysisPlot>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    return null;
  }
  const xAxis = resolveAxis(candidate.xAxis, isKnownPath);
  const yAxis = resolveAxis(candidate.yAxis, isKnownPath);
  // A gate's coordinates only mean anything alongside the axes they were drawn
  // against, so an axis that failed to resolve takes the gate with it.
  const resolvedGate = xAxis && yAxis ? resolveGate(candidate.gate) : null;
  // The old implementation persisted display labels as identities. Those
  // orders cannot be migrated safely because one label may represent several
  // raw categories, so drop the gate instead of silently selecting the wrong
  // population. The axes and plot remain available for the user to redraw it.
  const gate =
    resolvedGate &&
    xAxis &&
    yAxis &&
    categoryOrderMatchesAxis(
      xAxis,
      resolvedGate.xCategories,
      resolvedGate.categoryKeyVersion,
    ) &&
    categoryOrderMatchesAxis(
      yAxis,
      resolvedGate.yCategories,
      resolvedGate.categoryKeyVersion,
    )
      ? {
          ...resolvedGate,
          categoryKeyVersion: ANALYSIS_CATEGORY_KEY_VERSION,
        }
      : null;
  return {
    id: candidate.id,
    xAxis,
    yAxis,
    gate,
    gateEnabled: candidate.gateEnabled !== false,
  };
}
