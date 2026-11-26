import {
  IScalarMapMeta,
  TScalarMapColormap,
  TScalarMapThresholdSide,
} from "@/store/model";

/**
 * Pure helpers for the scalar map layer (HOTSPOT_REGIONS_WORKER.md §8.3):
 * colormap legends, and conversion between a threshold value and the share
 * of tissue it selects, using the map's pooled `percentiles` (0th..100th).
 */

/**
 * Gradient stops of the colormaps the tile route renders, evenly spaced from
 * the display minimum to the maximum. The legend is the only consumer; keep
 * every colormap's stops here so the panel never transcribes them.
 */
export const SCALAR_MAP_COLORMAP_STOPS: Readonly<
  Record<TScalarMapColormap, readonly string[]>
> = {
  viridis: [
    "#440154",
    "#482878",
    "#3e4989",
    "#31688e",
    "#26828e",
    "#1f9e89",
    "#35b779",
    "#6ece58",
    "#b5de2b",
    "#fde725",
  ],
  magma: [
    "#000004",
    "#180f3d",
    "#440f76",
    "#721f81",
    "#9e2f7f",
    "#cd4071",
    "#f1605d",
    "#fd9668",
    "#feca8d",
    "#fcfdbf",
  ],
  inferno: [
    "#000004",
    "#1b0c41",
    "#4a0c6b",
    "#781c6d",
    "#a52c60",
    "#cf4446",
    "#ed6925",
    "#fb9b06",
    "#f7d13d",
    "#fcffa4",
  ],
  gray: ["#000000", "#ffffff"],
};

export const SCALAR_MAP_COLORMAPS: readonly {
  value: TScalarMapColormap;
  title: string;
}[] = [
  { value: "viridis", title: "Viridis" },
  { value: "magma", title: "Magma" },
  { value: "inferno", title: "Inferno" },
  { value: "gray", title: "Gray" },
];

/** A left-to-right CSS gradient for a colormap's legend. */
export function colormapGradientCss(colormap: TScalarMapColormap): string {
  const stops = SCALAR_MAP_COLORMAP_STOPS[colormap];
  return `linear-gradient(to right, ${stops.join(", ")})`;
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
 * The percentile (0..100) of `value`: the inverse of `valueAtPercentile`.
 * Below the 0th percentile it is 0 and above the 100th it is 100. A value
 * equal to a run of equal percentiles (many cells with the same value) lands
 * in the middle of that run.
 */
export function percentileOfValue(
  percentiles: readonly number[],
  value: number,
): number {
  const last = percentiles.length - 1;
  if (last < 0 || !Number.isFinite(value)) {
    return NaN;
  }
  const scale = 100 / Math.max(1, last);
  if (value < percentiles[0]) {
    return 0;
  }
  if (value > percentiles[last]) {
    return 100;
  }
  let first = -1;
  let final = -1;
  for (let index = 0; index <= last; index++) {
    if (percentiles[index] === value) {
      if (first < 0) {
        first = index;
      }
      final = index;
    }
  }
  if (first >= 0) {
    return ((first + final) / 2) * scale;
  }
  for (let index = 0; index < last; index++) {
    const low = percentiles[index];
    const high = percentiles[index + 1];
    if (value > low && value < high) {
      return (index + (value - low) / (high - low)) * scale;
    }
  }
  return 100;
}

/**
 * The share of tissue (0..100 %) a threshold selects: above it for
 * `above`, below it for `below`.
 */
export function tissueShareOfThreshold(
  percentiles: readonly number[],
  threshold: number,
  side: TScalarMapThresholdSide,
): number {
  const percentile = percentileOfValue(percentiles, threshold);
  return side === "above" ? 100 - percentile : percentile;
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
}

/**
 * The previewed threshold in the two forms the Hotspot Regions worker takes,
 * percent of tissue first (what a re-run on other data generalizes to), then
 * the absolute value.
 */
export function workerThresholdForms(
  percentiles: readonly number[],
  threshold: number,
  side: TScalarMapThresholdSide,
): IWorkerThreshold[] {
  const share = tissueShareOfThreshold(percentiles, threshold, side);
  return [
    {
      type:
        side === "above" ? "Top percent of tissue" : "Bottom percent of tissue",
      threshold: formatShare(share),
    },
    {
      type: side === "above" ? "Value at least" : "Value at most",
      threshold: formatMapValue(threshold),
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
