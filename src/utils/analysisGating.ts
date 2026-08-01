import {
  ANALYSIS_CATEGORY_KEY_VERSION,
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
import { createHasher, idSignatureOf } from "@/utils/signatures";

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
  // Collision-free category identities in index order. These are persisted in
  // a gate because its polygon coordinates refer to category indices.
  xCategories: string[] | null;
  yCategories: string[] | null;
  // Human-readable tick text aligned with the category identities above.
  xCategoryLabels: string[] | null;
  yCategoryLabels: string[] | null;
  // Annotations dropped because an axis had no value for them.
  skipped: number;
}

type TAnalysisCategoryRaw = string | string[] | number;

const ANALYSIS_CATEGORY_KEY_PREFIX = "v1:";

/** Encode a raw category identity without conflating it with its display text. */
export function encodeAnalysisCategoryKey(raw: TAnalysisCategoryRaw): string {
  return `${ANALYSIS_CATEGORY_KEY_PREFIX}${JSON.stringify(raw)}`;
}

function decodeAnalysisCategoryKey(key: string): TAnalysisCategoryRaw | null {
  if (!key.startsWith(ANALYSIS_CATEGORY_KEY_PREFIX)) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(
      key.slice(ANALYSIS_CATEGORY_KEY_PREFIX.length),
    );
    if (typeof raw === "string" || typeof raw === "number") {
      return raw;
    }
    if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) {
      return raw;
    }
  } catch {
    // Invalid persisted keys are rejected by isEncodedAnalysisCategoryKey.
  }
  return null;
}

/** True for the versioned, collision-free category identities stored in gates. */
export function isEncodedAnalysisCategoryKey(key: string): boolean {
  return decodeAnalysisCategoryKey(key) !== null;
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

function categoricalRawIdentity(
  annotation: TAnnotationOrStub,
  key: TAnalysisCategoricalKey,
): TAnalysisCategoryRaw {
  switch (key) {
    case "tags":
      return [...annotation.tags].sort();
    case "shape":
      return annotation.shape;
    case "channel":
      return annotation.channel;
    case "xy":
      return annotation.location.XY;
    case "z":
      return annotation.location.Z;
    case "time":
      return annotation.location.Time;
  }
}

function categoricalLabelFromRaw(
  raw: TAnalysisCategoryRaw,
  key: TAnalysisCategoricalKey,
  channelName: (channel: number) => string,
): string {
  switch (key) {
    case "tags": {
      const tags = raw as string[];
      return tags.length > 0 ? tags.join(", ") : "(untagged)";
    }
    case "shape":
      return raw as string;
    case "channel":
      return channelName(raw as number);
    case "xy":
      return `XY ${(raw as number) + 1}`;
    case "z":
      return `Z ${(raw as number) + 1}`;
    case "time":
      return `T ${(raw as number) + 1}`;
  }
}

interface IAnalysisCategoricalValue {
  key: string;
  label: string;
}

// Raw per-annotation axis value: a number for a property axis, a key/label pair
// for a categorical one, or null when the annotation has no value on this axis.
function rawAxisValue(
  annotation: TAnnotationOrStub,
  axis: TAnalysisAxis,
  values: IAnnotationPropertyValues,
  channelName: (channel: number) => string,
): number | IAnalysisCategoricalValue | null {
  if (axis.type === "property") {
    const value = getValueFromObjectAndPath(
      values[annotation.id] ?? {},
      axis.path,
    );
    return typeof value === "number" && isFinite(value) ? value : null;
  }
  const raw = categoricalRawIdentity(annotation, axis.key);
  return {
    key: encodeAnalysisCategoryKey(raw),
    label: categoricalLabelFromRaw(raw, axis.key, channelName),
  };
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
  const rawX: (number | IAnalysisCategoricalValue)[] = [];
  const rawY: (number | IAnalysisCategoricalValue)[] = [];
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
    raw: (number | IAnalysisCategoricalValue)[],
    order: string[] | null | undefined,
    salt: number,
  ): {
    coords: number[];
    categories: string[] | null;
    categoryLabels: string[] | null;
  } => {
    if (axis.type === "property") {
      return {
        coords: raw as number[],
        categories: null,
        categoryLabels: null,
      };
    }
    const categoryValues = raw as IAnalysisCategoricalValue[];
    const labelsByKey = new Map(
      categoryValues.map(({ key, label }) => [key, label]),
    );
    const labelForKey = (key: string): string => {
      const presentLabel = labelsByKey.get(key);
      if (presentLabel !== undefined) {
        return presentLabel;
      }
      const decoded = decodeAnalysisCategoryKey(key);
      return decoded === null
        ? key
        : categoricalLabelFromRaw(decoded, axis.key, channelName);
    };
    // A pinned ordering wins, extended with any category it does not know so
    // new categories still plot (at the end) instead of vanishing. Note that
    // appended categories are display-only: a gate never contains them (see
    // resolveGateIds), so their indices carry no gate semantics.
    const categories = order ? [...order] : [];
    const indexOf = new Map(categories.map((key, idx) => [key, idx]));
    // Sort by readable label, then raw identity so duplicate display labels
    // remain deterministic and separate. Applied to the whole axis when no
    // ordering is pinned, and to the appended slice when one is — appended
    // indices must not depend on population iteration order.
    const byLabelThenKey = (left: string, right: string) =>
      labelForKey(left).localeCompare(labelForKey(right)) ||
      left.localeCompare(right);
    const appended: string[] = [];
    for (const { key } of categoryValues) {
      if (!indexOf.has(key)) {
        indexOf.set(key, 0); // marker; real indices assigned below
        appended.push(key);
      }
    }
    appended.sort(byLabelThenKey);
    categories.push(...appended);
    if (!order) {
      categories.sort(byLabelThenKey);
    }
    indexOf.clear();
    categories.forEach((key, idx) => indexOf.set(key, idx));
    return {
      coords: categoryValues.map(
        ({ key }, i) => indexOf.get(key)! + jitterFromId(ids[i], salt),
      ),
      categories,
      categoryLabels: categories.map(labelForKey),
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
    xCategoryLabels: x.categoryLabels,
    yCategoryLabels: y.categoryLabels,
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

/**
 * The ids of `series` whose point falls inside `gate`.
 *
 * A categorical point whose category is NOT in the gate's pinned order is
 * never inside, no matter where the polygon reaches (SERVER_GATING.md,
 * "unknown categories are outside the gate"). Appended categories plot at
 * indices ≥ the pinned count, and jitter is bounded by ±0.28, so rounding
 * the coordinate recovers the index exactly. This is what keeps the gate a
 * pure per-annotation predicate — the property that lets the server resolve
 * it without knowing the client's population.
 */
export function resolveGateIds(
  series: IAnalysisSeries,
  gate: IAnalysisGate,
): string[] {
  // Fewer than 3 vertices bounds no area; treat as selecting nothing rather
  // than letting the ray cast return an arbitrary answer.
  if (gate.vertices.length < 3) {
    return [];
  }
  const xPinned =
    series.xCategories !== null && gate.xCategories !== null
      ? gate.xCategories.length
      : null;
  const yPinned =
    series.yCategories !== null && gate.yCategories !== null
      ? gate.yCategories.length
      : null;
  const ids: string[] = [];
  for (let i = 0; i < series.ids.length; i++) {
    if (xPinned !== null && Math.round(series.x[i]) >= xPinned) {
      continue;
    }
    if (yPinned !== null && Math.round(series.y[i]) >= yPinned) {
      continue;
    }
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
    categoryKeyVersion: ANALYSIS_CATEGORY_KEY_VERSION,
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

/** An exact identity for a population. See idSignatureOf for why it hashes all ids. */
export function populationSignature(population: TAnnotationOrStub[]): string {
  return idSignatureOf(population);
}

/** The categorical axis keys the given plots actually use. */
export function analysisCategoricalKeys(
  plots: IAnalysisPlot[],
): TAnalysisCategoricalKey[] {
  const keys = new Set<TAnalysisCategoricalKey>();
  for (const plot of plots) {
    for (const axis of [plot.xAxis, plot.yAxis]) {
      if (axis?.type === "categorical") {
        keys.add(axis.key);
      }
    }
  }
  return [...keys];
}

/**
 * An identity for the annotation CONTENT a categorical axis reads.
 *
 * Membership is not enough. Editing an annotation's tags leaves the population
 * and its ids identical while moving that point to a different column, so a
 * signature built only from ids never re-runs the gate resolution: the panel
 * redraws the point under its new category while the gate keeps filtering by
 * the old one.
 *
 * Hashed from the raw fields rather than from display labels so nothing is
 * allocated per annotation — this runs whenever a gate is active. It is not the
 * canonical label (tags are not sorted here), which is fine: it only has to
 * CHANGE when the content does. A reordering triggers a harmless extra refresh.
 */
export function categoricalContentSignature(
  annotations: TAnnotationOrStub[],
  keys: TAnalysisCategoricalKey[],
): string {
  if (keys.length === 0) {
    return "-";
  }
  const hasher = createHasher();
  for (const annotation of annotations) {
    for (const key of keys) {
      switch (key) {
        case "tags":
          for (const tag of annotation.tags) {
            hasher.feedString(tag);
          }
          break;
        case "shape":
          hasher.feedString(annotation.shape);
          break;
        case "channel":
          hasher.feedNumber(annotation.channel);
          break;
        case "xy":
          hasher.feedNumber(annotation.location.XY);
          break;
        case "z":
          hasher.feedNumber(annotation.location.Z);
          break;
        case "time":
          hasher.feedNumber(annotation.location.Time);
          break;
      }
    }
    hasher.countItem();
  }
  return hasher.digest();
}
