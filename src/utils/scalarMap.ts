import {
  IScalarMap,
  IScalarMapMeta,
  TScalarMapColormap,
  TScalarMapThresholdSide,
} from "@/store/model";

/**
 * Pure helpers for the scalar map layer (HOTSPOT_REGIONS_WORKER.md §8.3):
 * validation of listed maps, display ranges, slider positions, and
 * conversion between a threshold value and the share of tissue it selects,
 * using the map's pooled `percentiles` (0th..100th, 101 entries).
 *
 * The colormap gradients are not here: the tile route samples the anchor
 * tables in the server's `server/helpers/colormaps.py`, which the client
 * reads through `color_by_property/options` (the same tables the
 * color-by-property legend draws), so the legend cannot drift from tiles.
 */

export const SCALAR_MAP_COLORMAPS: readonly {
  value: TScalarMapColormap;
  title: string;
}[] = [
  { value: "viridis", title: "Viridis" },
  { value: "magma", title: "Magma" },
  { value: "inferno", title: "Inferno" },
  { value: "gray", title: "Gray" },
];

export const SCALAR_MAP_PERCENTILE_COUNT = 101;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Whether a listed map has everything the layer and panel read. The server
 * validates on its side too; this keeps one malformed entry from breaking
 * the whole list.
 */
export function isValidScalarMap(map: unknown): map is IScalarMap {
  if (typeof map !== "object" || map === null) {
    return false;
  }
  const { itemId, meta } = map as Partial<IScalarMap>;
  if (typeof itemId !== "string" || typeof meta !== "object" || !meta) {
    return false;
  }
  const { percentiles, valueRange, locations } = meta;
  if (
    !Array.isArray(percentiles) ||
    percentiles.length !== SCALAR_MAP_PERCENTILE_COUNT ||
    !percentiles.every(isFiniteNumber) ||
    percentiles.some(
      (value, index) => index > 0 && value < percentiles[index - 1],
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(valueRange) ||
    valueRange.length !== 2 ||
    !valueRange.every(isFiniteNumber) ||
    valueRange[0] > valueRange[1]
  ) {
    return false;
  }
  return (
    Array.isArray(locations) &&
    locations.every(
      (location) =>
        typeof location === "object" &&
        location !== null &&
        typeof location.key === "string",
    )
  );
}

/**
 * The range a map is displayed over by default (and on Reset). A constant
 * map (min == max) is widened to [v - 0.5, v + 0.5], the server's own rule
 * when min/max are omitted: the tile route rejects min == max.
 */
export function displayValueRange(
  valueRange: readonly [number, number],
): [number, number] {
  const [min, max] = valueRange;
  return max > min ? [min, max] : [min - 0.5, min + 0.5];
}

// Sliders over map values use integer positions: Vuetify rounds a slider's
// value to the decimals of `step.toString()`, which is 0 for a step written
// in exponent notation (below 1e-6), so a float step on a tiny range rounds
// every value to 0.
export const SLIDER_POSITIONS = 1000;

/** The integer slider position (0..SLIDER_POSITIONS) of a value. */
export function valueToSliderPosition(
  value: number,
  range: readonly [number, number],
): number {
  const [low, high] = range;
  if (!(high > low)) {
    return 0;
  }
  const fraction = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return Math.round(fraction * SLIDER_POSITIONS);
}

/** The value at an integer slider position; the ends are exact. */
export function sliderPositionToValue(
  position: number,
  range: readonly [number, number],
): number {
  const [low, high] = range;
  if (position <= 0) {
    return low;
  }
  if (position >= SLIDER_POSITIONS) {
    return high;
  }
  return low + ((high - low) * position) / SLIDER_POSITIONS;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The value at percentile `percentile` (0..100, clamped), interpolating
 * linearly between the stored whole percentiles. `percentiles[80]` is the
 * worker's `Top percent of tissue` 20 threshold, so this agrees with it at
 * every whole number.
 */
export function valueAtPercentile(
  percentiles: readonly number[],
  percentile: number,
): number {
  const last = percentiles.length - 1;
  if (last < 0) {
    return NaN;
  }
  const position = (clamp(percentile, 0, 100) / 100) * last;
  const low = Math.floor(position);
  const high = Math.min(last, low + 1);
  const fraction = position - low;
  return percentiles[low] + (percentiles[high] - percentiles[low]) * fraction;
}

/**
 * The percentiles bounding `value`: [share of tissue strictly below it,
 * share at or below it], 0..100. They differ only when many cells share the
 * value exactly (a run of equal percentiles, e.g. a floor at 0).
 */
export function percentileBounds(
  percentiles: readonly number[],
  value: number,
): [number, number] {
  const last = percentiles.length - 1;
  if (last < 1 || !Number.isFinite(value)) {
    return [NaN, NaN];
  }
  const scale = 100 / last;
  if (value < percentiles[0]) {
    return [0, 0];
  }
  if (value > percentiles[last]) {
    return [100, 100];
  }
  const first = percentiles.indexOf(value);
  if (first >= 0) {
    return [first * scale, percentiles.lastIndexOf(value) * scale];
  }
  for (let index = 0; index < last; index++) {
    const low = percentiles[index];
    const high = percentiles[index + 1];
    if (value > low && value < high) {
      const percentile = (index + (value - low) / (high - low)) * scale;
      return [percentile, percentile];
    }
  }
  return [100, 100];
}

/**
 * The share of tissue (0..100 %) a threshold actually selects. The tile
 * route and the worker are inclusive (`>=` above, `<=` below), so a value
 * shared by many cells counts with the selected side.
 */
export function selectedTissueShare(
  percentiles: readonly number[],
  threshold: number,
  side: TScalarMapThresholdSide,
): number {
  const [below, atOrBelow] = percentileBounds(percentiles, threshold);
  return side === "above" ? 100 - below : atOrBelow;
}

/** The threshold that selects `share` % of tissue on `side`. */
export function thresholdForTissueShare(
  percentiles: readonly number[],
  share: number,
  side: TScalarMapThresholdSide,
): number {
  const clamped = clamp(share, 0, 100);
  return valueAtPercentile(
    percentiles,
    side === "above" ? 100 - clamped : clamped,
  );
}

export interface IThresholdShare {
  // What the user asked for in percent mode; null when set by value.
  requested: number | null;
  // What the inclusive cutoff selects.
  selected: number;
  // Ties at the cutoff make the selection differ from the request.
  tied: boolean;
}

// Shares within this of each other are the same request (float noise of the
// percent -> value -> percent round trip).
const SHARE_TOLERANCE = 1e-6;

export function thresholdShare(
  percentiles: readonly number[],
  threshold: number,
  side: TScalarMapThresholdSide,
  requested: number | null,
): IThresholdShare {
  const selected = selectedTissueShare(percentiles, threshold, side);
  return {
    requested,
    selected,
    tied:
      requested !== null && Math.abs(selected - requested) > SHARE_TOLERANCE,
  };
}

/** A map value for display: about three significant digits. */
export function formatMapValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "–";
  }
  if (value === 0) {
    return "0";
  }
  const magnitude = Math.abs(value);
  if (magnitude >= 1e5 || magnitude < 1e-3) {
    return value.toExponential(2);
  }
  return Number(value.toPrecision(3)).toString();
}

/**
 * A value to copy into the worker: enough digits (9 significant) to
 * round-trip the float32 map value, trailing zeros dropped.
 */
export function formatExactValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "–";
  }
  return Number(value.toPrecision(9)).toString();
}

/** A share of tissue for display: one decimal below 10 %, whole above. */
export function formatShare(share: number): string {
  if (!Number.isFinite(share)) {
    return "–";
  }
  const rounded = share < 10 ? Math.round(share * 10) / 10 : Math.round(share);
  return rounded.toString();
}

export interface IWorkerThreshold {
  // The worker interface's `Threshold type` select (§3).
  type:
    | "Top percent of tissue"
    | "Bottom percent of tissue"
    | "Value at least"
    | "Value at most";
  // Its `Threshold` number.
  threshold: string;
  // The worker would not reproduce the preview's cutoff exactly.
  approximate: boolean;
}

/**
 * The previewed threshold in the two forms the Hotspot Regions worker takes.
 * The value form is exact. The percent form reproduces the cutoff only when
 * it is a whole percentile whose stored value is the cutoff (the worker
 * thresholds `Top percent N` at `percentiles[100 - N]`); otherwise it is
 * marked approximate.
 */
export function workerThresholdForms(
  percentiles: readonly number[],
  threshold: number,
  side: TScalarMapThresholdSide,
  requestedShare: number | null,
): IWorkerThreshold[] {
  const share =
    requestedShare ?? selectedTissueShare(percentiles, threshold, side);
  const roundedShare = Math.round(share);
  const exactPercent =
    Math.abs(share - roundedShare) <= SHARE_TOLERANCE &&
    percentiles[side === "above" ? 100 - roundedShare : roundedShare] ===
      threshold;
  return [
    {
      type:
        side === "above" ? "Top percent of tissue" : "Bottom percent of tissue",
      threshold: exactPercent ? roundedShare.toString() : formatShare(share),
      approximate: !exactPercent,
    },
    {
      type: side === "above" ? "Value at least" : "Value at most",
      threshold: formatExactValue(threshold),
      approximate: false,
    },
  ];
}

/** The map's location key for a viewer position, or null without data. */
export function scalarMapLocationKey(
  meta: IScalarMapMeta,
  xy: number,
  z: number,
  time: number,
): string | null {
  return (
    meta.locations.find(
      (location) =>
        location.XY === xy && location.Z === z && location.Time === time,
    )?.key ?? null
  );
}

/** Statistic and radius, as the panel's subtitle. */
export function scalarMapSummary(meta: IScalarMapMeta): string {
  const statistic =
    meta.statistic === "Fraction above cutoff" && meta.cutoff !== null
      ? `${meta.statistic} ${meta.cutoff}`
      : meta.statistic;
  const parts = [statistic];
  if (meta.property && meta.statistic !== "Density") {
    parts.push(meta.property);
  }
  parts.push(`radius ${meta.radius} ${meta.radiusUnit}`);
  return parts.join(" · ");
}
