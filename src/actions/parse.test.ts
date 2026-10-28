import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ store: null as any }));

vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  mocks.store = reactive({
    isLoggedIn: true,
    dataset: {
      xy: [0, 1, 2, 3],
      z: Array.from({ length: 20 }, (_, i) => i),
      time: Array.from({ length: 50 }, (_, i) => i),
      channelNames: new Map([
        [0, "DAPI"],
        [1, "GFP"],
        [2, "Cy3"],
      ]),
    },
    layers: [
      { id: "l-gfp", name: "Green", channel: 1, visible: true },
      { id: "l-dapi", name: "Nuclei", channel: 0, visible: true },
      { id: "l-cy3", name: "Cy3", channel: 2, visible: false },
    ],
    syncConfiguration: vi.fn(),
  });
  return { default: mocks.store };
});

const ops = vi.hoisted(() => ({
  goToLocation: vi.fn(),
  setVisibleLayers: vi.fn(),
  selectTool: vi.fn(),
}));
vi.mock("./operations", () => ops);

import { paramCommandsForQuery } from "./parse";

let inViewer = true;
const ctx = { inViewer: () => inViewer };

function titles(query: string) {
  return paramCommandsForQuery(query, ctx).map((c) => c.title);
}

beforeEach(() => {
  inViewer = true;
  vi.clearAllMocks();
});

describe("paramCommandsForQuery", () => {
  it.each(["z 12", "go to z 12", "slice 12", "z12", "Z  12"])(
    "reads %j as Go to Z 12",
    (query) => {
      const [command] = paramCommandsForQuery(query, ctx);
      expect(command.title).toBe("Go to Z 12");
      expect(command.group).toBe("Navigate");
      expect(command.description).toBe("of 20");
      expect(command.generated).toBe(true);
    },
  );

  it.each(["t 40", "time 40", "timepoint 40", "frame 40", "t40"])(
    "reads %j as Go to time 40",
    (query) => {
      expect(titles(query)).toEqual(["Go to time 40"]);
    },
  );

  it.each(["xy 3", "position 3", "xy3"])("reads %j as Go to XY 3", (query) => {
    expect(titles(query)).toEqual(["Go to XY 3"]);
  });

  it("reads every phrase form, the glued one included", () => {
    for (const query of ["z12", "go to z 12", "slice 12", "z 12"]) {
      expect(titles(query), query).toEqual(["Go to Z 12"]);
    }
    expect(titles("t40")).toEqual(["Go to time 40"]);
    expect(titles("xy3")).toEqual(["Go to XY 3"]);
  });

  it("converts the typed 1-based number to a 0-based index", async () => {
    await paramCommandsForQuery("z 1", ctx)[0].run();
    expect(ops.goToLocation).toHaveBeenCalledWith({ z: 0 });
    await paramCommandsForQuery("time 50", ctx)[0].run();
    expect(ops.goToLocation).toHaveBeenLastCalledWith({ time: 49 });
    await paramCommandsForQuery("xy 4", ctx)[0].run();
    expect(ops.goToLocation).toHaveBeenLastCalledWith({ xy: 3 });
  });

  it("offers nothing for 0 or a number past the dimension's length", () => {
    expect(titles("z 0")).toEqual([]);
    expect(titles("z 21")).toEqual([]);
    expect(titles("z 20")).toEqual(["Go to Z 20"]);
    expect(titles("t 51")).toEqual([]);
  });

  it("offers nothing without a number, or for a non-integer", () => {
    expect(titles("z")).toEqual([]);
    expect(titles("z abc")).toEqual([]);
    expect(titles("z 1.5")).toEqual([]);
  });

  it("offers nothing for a dimension with a single entry", () => {
    mocks.store.dataset.z = [0];
    expect(titles("z 1")).toEqual([]);
    mocks.store.dataset.z = Array.from({ length: 20 }, (_, i) => i);
  });

  it("lists every layer for the bare phrase", () => {
    expect(titles("show only")).toEqual([
      "Show only layer: Green",
      "Show only layer: Nuclei",
      "Show only layer: Cy3",
    ]);
  });

  it.each(["show only dapi", "only dapi", "solo dapi", "isolate dapi"])(
    "matches the layer through its channel name for %j",
    (query) => {
      expect(titles(query)).toEqual(["Show only layer: Nuclei"]);
    },
  );

  it("ranks the best layer first for a partial name", () => {
    expect(titles("show only da")[0]).toBe("Show only layer: Nuclei");
    expect(titles("show only gre")[0]).toBe("Show only layer: Green");
  });

  it("runs the show-only command through the shared operation, then persists", async () => {
    await paramCommandsForQuery("show only dapi", ctx)[0].run();
    expect(ops.setVisibleLayers).toHaveBeenCalledWith(["l-dapi"]);
    expect(mocks.store.syncConfiguration).toHaveBeenCalledWith("layers");
  });

  it("does not persist show-only when logged out", async () => {
    mocks.store.isLoggedIn = false;
    await paramCommandsForQuery("show only dapi", ctx)[0].run();
    mocks.store.isLoggedIn = true;
    expect(ops.setVisibleLayers).toHaveBeenCalled();
    expect(mocks.store.syncConfiguration).not.toHaveBeenCalled();
  });

  it("caps the listed layers", () => {
    mocks.store.layers = Array.from({ length: 12 }, (_, i) => ({
      id: `l${i}`,
      name: `Layer ${i}`,
      channel: 0,
      visible: true,
    }));
    expect(titles("show only")).toHaveLength(8);
  });

  it("gives ids that name the action and value", () => {
    expect(paramCommandsForQuery("z 3", ctx)[0].id).toBe("navigate.z:2");
  });

  it("offers nothing for an unrelated or empty query", () => {
    expect(titles("")).toEqual([]);
    expect(titles("open filters")).toEqual([]);
    expect(titles("zebra 3")).toEqual([]);
  });

  it("offers nothing outside the viewer", () => {
    inViewer = false;
    expect(titles("z 3")).toEqual([]);
    expect(titles("show only")).toEqual([]);
  });
});
