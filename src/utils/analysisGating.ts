import {
  IAnalysisGate,
  IAnalysisPlot,
  IAnnotationPropertyValues,
  IGeoJSPosition,
  TAnalysisAxis,
  TAnalysisCategoricalKey,
  TAnnotationOrStub,
} from "@/store/model";
import {
  createPathStringFromPathArray,
  getValueFromObjectAndPath,
} from "@/utils/paths";
import { idSignatureOf } from "@/utils/signatures";

/**
 * Coordinate/gating maths for the Analysis panel.
 *
 * Everything here is pure so that the scatter that DRAWS the points and the
 * resolver that decides which points a gate CONTAINS go through the same
 * functions. These are the classic pair of symmetric paths that drift: if
 * drawing and hit-testing computed coordinates independently, a gate would
 * quietly select different objects than the ones under the lasso.
 */

/** One plot's points, in plot coordinate space, aligned by index. */
export interface IAnalysisSeries {
  ids: string[];
  x: number[];
  y: number[];
  // Category labels in index order, for a categorical axis; null when numeric.
  xCategories: string[] | null;
  yCategories: string[] | null;
  // Annotations dropped because an axis had no value for them.
  skipped: number;
}

/**
 * Deterministic jitter in [-0.28, 0.28] spreading a categorical column into a
 * readable strip. Derived from the annotation id rather than Math.random so a
 * point does not move between renders — and, more importantly, so a gate drawn
 * over a jittered column still contains the same points when it is re-resolved
 * in a later session.
 */
export function jitterFromId(id: string, salt: number): number {
  let hash = salt;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return (((hash >>> 0) % 1000) / 1000 - 0.5) * 0.56;
}

/** Salts keeping the two axes' jitter independent. */
const X_JITTER_SALT = 17;
const Y_JITTER_SALT = 31;

export function categoricalLabel(
  annotation: TAnnotationOrStub,
  key: TAnalysisCategoricalKey,
  channelName: (channel: number) => string,
): string {
  switch (key) {
    case "tags":
      return annotation.tags.length > 0
        ? [...annotation.tags].sort().join(", ")
        : "(untagged)";
    case "shape":
      return annotation.shape;
    case "channel":
      return channelName(annotation.channel);
    case "xy":
      return `XY ${annotation.location.XY + 1}`;
    case "z":
      return `Z ${annotation.location.Z + 1}`;
    case "time":
      return `T ${annotation.location.Time + 1}`;
  }
}

// Raw per-annotation axis value: a number for a property axis, a label for a
// categorical one, or null when the annotation has no value on this axis.
function rawAxisValue(
  annotation: TAnnotationOrStub,
  axis: TAnalysisAxis,
  values: IAnnotationPropertyValues,
  channelName: (channel: number) => string,
): number | string | null {
  if (axis.type === "property") {
    const value = getValueFromObjectAndPath(
      values[annotation.id] ?? {},
      axis.path,
    );
    return typeof value === "number" && isFinite(value) ? value : null;
  }
  return categoricalLabel(annotation, axis.key, channelName);
}

/**
 * Build the plotted series for one plot.
 *
 * `categoryOrder` pins the index a category maps to. Pass a gate's stored
 * ordering when one exists: category indices are what the gate polygon's x/y
 * coordinates mean, so re-deriving the ordering from whatever categories happen
 * to be present would silently move the gate onto different categories (a real
 * risk since a configuration is shared across datasets). With no gate, the
 * ordering is derived from the data.
 */
export function buildPlotSeries(input: {
  annotations: TAnnotationOrStub[];
  values: IAnnotationPropertyValues;
  xAxis: TAnalysisAxis;
  yAxis: TAnalysisAxis;
  channelName: (channel: number) => string;
  xCategoryOrder?: string[] | null;
  yCategoryOrder?: string[] | null;
}): IAnalysisSeries {
  const { annotations, values, xAxis, yAxis, channelName } = input;

  const ids: string[] = [];
  const rawX: (number | string)[] = [];
  const rawY: (number | string)[] = [];
  for (const annotation of annotations) {
    const x = rawAxisValue(annotation, xAxis, values, channelName);
    if (x === null) {
      continue;
    }
    const y = rawAxisValue(annotation, yAxis, values, channelName);
    if (y === null) {
      continue;
    }
    ids.push(annotation.id);
    rawX.push(x);
    rawY.push(y);
  }

  const buildAxis = (
    axis: TAnalysisAxis,
    raw: (number | string)[],
    order: string[] | null | undefined,
    salt: number,
  ): { coords: number[]; categories: string[] | null } => {
    if (axis.type === "property") {
      return { coords: raw as number[], categories: null };
    }
    const labels = raw as string[];
    // A pinned ordering wins, extended with any category it does not know so
    // new categories still plot (at the end) instead of vanishing.
    const categories = order ? [...order] : [];
    const indexOf = new Map(categories.map((label, idx) => [label, idx]));
    for (const label of labels) {
      if (!indexOf.has(label)) {
        indexOf.set(label, categories.length);
        categories.push(label);
      }
    }
    if (!order) {
      // No pinned ordering: sort for a stable, readable axis, then re-index.
      categories.sort();
      indexOf.clear();
      categories.forEach((label, idx) => indexOf.set(label, idx));
    }
    return {
      coords: labels.map(
        (label, i) => indexOf.get(label)! + jitterFromId(ids[i], salt),
      ),
      categories,
    };
  };

  const x = buildAxis(xAxis, rawX, input.xCategoryOrder, X_JITTER_SALT);
  const y = buildAxis(yAxis, rawY, input.yCategoryOrder, Y_JITTER_SALT);
  return {
    ids,
    x: x.coords,
    y: y.coords,
    xCategories: x.categories,
    yCategories: y.categories,
    skipped: annotations.length - ids.length,
  };
}

/**
 * Even-odd ray casting. Deliberately local rather than `geo.util.pointInPolygon`:
 * this module is pure maths with no map involved, and keeping geojs out of it
 * lets the gating tests run without the geojs mock every map-touching test needs.
 */
function isPointInPolygon(
  x: number,
  y: number,
  vertices: IGeoJSPosition[],
): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].x;
    const yi = vertices[i].y;
    const xj = vertices[j].x;
    const yj = vertices[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** The ids of `series` whose point falls inside `gate`. */
export function resolveGateIds(
  series: IAnalysisSeries,
  gate: IAnalysisGate,
): string[] {
  // Fewer than 3 vertices bounds no area; treat as selecting nothing rather
  // than letting the ray cast return an arbitrary answer.
  if (gate.vertices.length < 3) {
    return [];
  }
  const ids: string[] = [];
  for (let i = 0; i < series.ids.length; i++) {
    if (isPointInPolygon(series.x[i], series.y[i], gate.vertices)) {
      ids.push(series.ids[i]);
    }
  }
  return ids;
}

/**
 * Translate a Plotly `plotly_selected` payload into a persistable gate.
 *
 * Handles both selection tools: the lasso reports a free-form path in
 * `lassoPoints`, the box reports opposite corners in `range`. Returns null when
 * the payload carries neither (Plotly emits a bare event in some internal
 * clears), so the caller can leave the existing gate alone.
 */
export function selectionEventToGate(
  event: {
    lassoPoints?: { x: number[]; y: number[] };
    range?: { x: number[]; y: number[] };
  } | null,
  series: IAnalysisSeries,
): IAnalysisGate | null {
  const categories = {
    xCategories: series.xCategories,
    yCategories: series.yCategories,
  };
  const lasso = event?.lassoPoints;
  if (lasso && lasso.x.length >= 3) {
    return {
      vertices: lasso.x.map((x, i) => ({ x, y: lasso.y[i] })),
      ...categories,
    };
  }
  const range = event?.range;
  if (range && range.x.length === 2 && range.y.length === 2) {
    const [x0, x1] = range.x;
    const [y0, y1] = range.y;
    return {
      vertices: [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ],
      ...categories,
    };
  }
  return null;
}

/**
 * Walk the plot chain: entry `i` is the population reaching plot `i`, i.e. the
 * base narrowed by the gates of plots `0..i-1`. A plot never sees its own gate,
 * or the points just lassoed would disappear from the plot they were drawn on.
 *
 * The single implementation of the chain — the store's gate refresh, the
 * panel's display, and the tests all walk it through here.
 */
export function chainPlotInputs(
  plots: IAnalysisPlot[],
  gateIds: { [plotId: string]: string[] },
  base: TAnnotationOrStub[],
): TAnnotationOrStub[][] {
  const inputs: TAnnotationOrStub[][] = [];
  let population = base;
  for (const plot of plots) {
    inputs.push(population);
    const ids = gateIds[plot.id];
    if (plot.gateEnabled && plot.gate !== null && ids !== undefined) {
      const gate = new Set(ids);
      population = population.filter((annotation) => gate.has(annotation.id));
    }
  }
  return inputs;
}

/** Property paths the given plots need values for (categorical axes need none). */
export function analysisPropertyPaths(plots: IAnalysisPlot[]): string[][] {
  const seen = new Map<string, string[]>();
  for (const plot of plots) {
    for (const axis of [plot.xAxis, plot.yAxis]) {
      if (axis?.type === "property") {
        seen.set(createPathStringFromPathArray(axis.path), axis.path);
      }
    }
  }
  return [...seen.values()];
}

/** A cheap identity for a population. See idSignatureOf for why it samples. */
export function populationSignature(population: TAnnotationOrStub[]): string {
  return idSignatureOf(population);
}
