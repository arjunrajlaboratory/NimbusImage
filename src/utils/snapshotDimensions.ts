import type { IDataset, IDatasetLocation, IDisplayLayer } from "@/store/model";

export type SnapshotDimensions = Record<keyof IDatasetLocation, boolean>;

// Locations use slider indices, not the physical Z/time values in metadata.
export function* snapshotLocations(
  dataset: Pick<IDataset, "xy" | "z" | "time">,
  location: IDatasetLocation,
  across: SnapshotDimensions,
): Generator<IDatasetLocation> {
  const indices = (axis: keyof IDatasetLocation) =>
    across[axis] ? dataset[axis].map((_, index) => index) : [location[axis]];
  for (const xy of indices("xy")) {
    for (const time of indices("time")) {
      for (const z of indices("z")) {
        yield { xy, time, z };
      }
    }
  }
}

export function snapshotLayers(
  layers: IDisplayLayer[],
  across: SnapshotDimensions,
): IDisplayLayer[] {
  return layers.map((layer) => ({
    ...layer,
    // Expanding an axis exports individual planes even for projected or fixed
    // layers. Keep the shared configuration and unchecked axes unchanged.
    xy: across.xy ? { type: "current", value: null } : layer.xy,
    z: across.z ? { type: "current", value: null } : layer.z,
    time: across.time ? { type: "current", value: null } : layer.time,
  }));
}
