import { describe, expect, it } from "vitest";
import { snapshotLocations, snapshotLayers } from "./snapshotDimensions";
import { newLayer, type IDataset } from "@/store/model";

const dataset = { xy: [0, 1], z: [0, 2.5, 5], time: [0, 60] };
const location = { xy: 1, z: 2, time: 1 };

describe("snapshot dimensions", () => {
  it.each(Array.from({ length: 8 }, (_, mask) => mask))(
    "exports exactly the selected Cartesian product (mask %i)",
    (mask) => {
      const across = { xy: !!(mask & 1), time: !!(mask & 2), z: !!(mask & 4) };
      const result = [...snapshotLocations(dataset, location, across)];
      expect(result).toHaveLength(
        (across.xy ? 2 : 1) * (across.time ? 2 : 1) * (across.z ? 3 : 1),
      );
      expect(new Set(result.map((point) => JSON.stringify(point))).size).toBe(
        result.length,
      );
      for (const axis of ["xy", "z", "time"] as const) {
        expect([...new Set(result.map((point) => point[axis]))]).toEqual(
          across[axis]
            ? dataset[axis].map((_, index) => index)
            : [location[axis]],
        );
      }
      expect(location).toEqual({ xy: 1, z: 2, time: 1 });
    },
  );

  it("expands each snapshot against its own dataset", () => {
    expect([
      ...snapshotLocations({ xy: [0], z: [10, 20], time: [0] }, location, {
        xy: false,
        z: true,
        time: false,
      }),
    ]).toEqual([
      { xy: 1, z: 0, time: 1 },
      { xy: 1, z: 1, time: 1 },
    ]);
  });

  it("exports individual planes without mutating projection or offset settings", () => {
    const layer = newLayer(
      { channels: [0], channelNames: new Map() } as IDataset,
      [],
    );
    layer.z = { type: "max-merge", value: null };
    layer.xy = { type: "constant", value: 1 };
    layer.time = { type: "offset", value: 2 };
    const original = structuredClone(layer);
    const [expanded] = snapshotLayers([layer], {
      xy: true,
      z: true,
      time: false,
    });
    expect(expanded.z).toEqual({ type: "current", value: null });
    expect(expanded.xy).toEqual({ type: "current", value: null });
    expect(expanded.time).toEqual(layer.time);
    expect(layer).toEqual(original);
  });
});
