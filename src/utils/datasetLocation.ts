import { IDataset, IDatasetLocation } from "@/store/model";
import { clamp } from "@/utils/math";

/**
 * Constrain a location index to [0, count - 1]. Non-finite input (a NaN from
 * a malformed `?xy=` query, say) becomes 0, and fractions are truncated.
 */
export function clampLocationIndex(value: number, count: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return clamp(Math.trunc(value), 0, Math.max(0, count - 1));
}

/**
 * Constrain a location to the dataset's XY/Z/T dimensions. The store keeps
 * slider indices into `dataset.xy`/`z`/`time`, so an index past the end makes
 * every `dataset.images(...)` lookup at the current location miss.
 */
export function clampLocationToDataset(
  location: IDatasetLocation,
  dataset: Pick<IDataset, "xy" | "z" | "time">,
): IDatasetLocation {
  return {
    xy: clampLocationIndex(location.xy, dataset.xy.length),
    z: clampLocationIndex(location.z, dataset.z.length),
    time: clampLocationIndex(location.time, dataset.time.length),
  };
}
