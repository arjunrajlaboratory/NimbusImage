import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { computed } from "vue";

// Reactive mocks: providers are read inside a `computed`, so a test that
// replaces store state must see the computed re-derive — exactly as the real
// store REPLACES workerImageList rather than mutating it.
const mocks = vi.hoisted(() => ({
  store: null as any,
  properties: null as any,
  filters: null as any,
}));

vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  mocks.store = reactive({
    isLoggedIn: true,
    layerMode: "multiple",
    dataset: { channelNames: new Map([[0, "DAPI"]]) },
    tools: [] as any[],
    layers: [] as any[],
    configuration: { snapshots: [] as any[] },
    toolTemplateList: [] as any[],
    availableToolShapes: [
      { text: "Point", value: "point" },
      { text: "Blob", value: "polygon" },
    ],
    requestPaletteOpen: vi.fn(),
    openAnnotationBrowserTab: vi.fn(),
    setSelectedToolId: vi.fn(),
    toggleLayerVisibility: vi.fn(),
    setIsColorByPropertyDialogOpen: vi.fn(),
  });
  return { default: mocks.store };
});

vi.mock("@/store/properties", async () => {
  const { reactive } = await import("vue");
  mocks.properties = reactive({
    workerImageList: {} as Record<string, any>,
    computedPropertyPaths: [] as string[][],
    displayedPropertyPaths: [] as string[][],
    getFullNameFromPath: (path: string[]) => `Name of ${path.join("/")}`,
    togglePropertyPathVisibility: vi.fn(),
  });
  return { default: mocks.properties };
});

vi.mock("@/store/filters", async () => {
  const { reactive } = await import("vue");
  mocks.filters = reactive({
    filterPaths: [] as string[][],
    togglePropertyPathFiltering: vi.fn(),
  });
  return { default: mocks.filters };
});

vi.mock("@/utils/v-mousetrap", async () => {
  const { ref } = await import("vue");
  return {
    boundKeys: ref({
      "1": { section: "Layer control", description: "Show/hide layer: DAPI" },
      "3": { section: "Layer control", description: "Show/hide layer: GFP" },
      "4": { section: "Layer control", description: "Show/hide layer: GFP" },
    }),
  };
});

import {
  addToolCommands,
  layerCommands,
  panelCommands,
  propertyCommands,
  propertyFilterCommands,
  propertyListCommands,
  snapshotCommands,
  toolCommands,
  tourCommands,
} from "./providers";
import { rankCommands } from "./scorer";
import {
  colorByPropertyRequest,
  snapshotLoadRequest,
  toolCreationRequest,
} from "./requests";

const TEMPLATES = JSON.parse(
  readFileSync(join(__dirname, "../../public/config/templates.json"), "utf8"),
);

let inViewer = true;
const ctx = { inViewer: () => inViewer };

function ids(commands: { id: string }[]) {
  return commands.map((command) => command.id);
}

beforeEach(() => {
  inViewer = true;
  mocks.store.isLoggedIn = true;
  mocks.store.toolTemplateList = TEMPLATES;
  mocks.store.tools = [];
  mocks.store.layers = [];
  mocks.store.configuration = { snapshots: [] };
  mocks.properties.workerImageList = {};
  mocks.properties.computedPropertyPaths = [];
  toolCreationRequest.value = null;
  snapshotLoadRequest.value = null;
  colorByPropertyRequest.value = null;
});

describe("toolCommands", () => {
  it("offers each configured tool, with its hotkey, and selects it", () => {
    mocks.store.tools = [
      { id: "t1", name: "Nuclei", hotkey: "n", values: {} },
      { id: "t2", name: "Spots", hotkey: null, values: {} },
    ];
    const commands = toolCommands(ctx)();
    expect(ids(commands)).toEqual(["tool.select.t1", "tool.select.t2"]);
    expect(commands[0].title).toBe("Use tool: Nuclei");
    expect(commands[0].hotkey).toBe("n");
    commands[0].run();
    expect(mocks.store.setSelectedToolId).toHaveBeenCalledWith("t1");
    expect(mocks.store.requestPaletteOpen).toHaveBeenCalledWith(["toolsPanel"]);
  });

  it("is disabled outside the viewer and when logged out", () => {
    mocks.store.tools = [{ id: "t1", name: "Nuclei", values: {} }];
    const [command] = toolCommands(ctx)();
    expect(command.enabled!()).toBe(true);
    mocks.store.isLoggedIn = false;
    expect(command.enabled!()).toBe(false);
    mocks.store.isLoggedIn = true;
    inViewer = false;
    expect(command.enabled!()).toBe(false);
  });
});

describe("addToolCommands", () => {
  it("offers every template card, but not the hidden ones", () => {
    const titles = addToolCommands(ctx)().map((command) => command.title);
    expect(titles).toContain("Add tool: Point…");
    expect(titles).toContain("Add tool: Click to tag…");
    expect(titles).not.toContain("Add tool: Snap circle to dot…");
    expect(titles).not.toContain("Add tool: Slice…");
  });

  it("picks up a newly registered worker image without a reload", () => {
    const commandIds = computed(() => ids(addToolCommands(ctx)()));
    expect(commandIds.value).not.toContain("tool.add.worker:org/cellpose:1");
    // Replace, as the real store's setWorkerImageList does.
    mocks.properties.workerImageList = {
      "org/cellpose:1": {
        isAnnotationWorker: "",
        interfaceName: "Cellpose-SAM",
        interfaceCategory: "Segmentation",
        description: "Segment nuclei and cells",
        annotationShape: "polygon",
      },
    };
    expect(commandIds.value).toContain("tool.add.worker:org/cellpose:1");
    mocks.properties.workerImageList = {};
    expect(commandIds.value).not.toContain("tool.add.worker:org/cellpose:1");
  });

  it("asks for tool creation pre-selected instead of building a tool", () => {
    mocks.properties.workerImageList = {
      "org/cellpose:1": {
        isAnnotationWorker: "",
        interfaceName: "Cellpose-SAM",
        annotationShape: "polygon",
      },
    };
    const command = addToolCommands(ctx)().find(
      (c) => c.id === "tool.add.worker:org/cellpose:1",
    )!;
    expect(command.title).toBe("Add tool: Cellpose-SAM…");
    command.run();
    const request = toolCreationRequest.value!;
    expect(request.selectedItem?.text).toBe("Cellpose-SAM");
    // The submenu element is consumed and its value seeded, exactly as when
    // the card is clicked in the dialog.
    expect(
      request.template!.interface.some(
        (elem: any) => elem.type === "dockerImage",
      ),
    ).toBe(false);
    expect(Object.values(request.defaultValues)).toContainEqual({
      image: "org/cellpose:1",
    });
    expect(mocks.store.requestPaletteOpen).toHaveBeenCalledWith(["toolsPanel"]);
  });
});

describe("layerCommands", () => {
  it("toggles each layer, annotated with its bound hotkey and channel", () => {
    mocks.store.layers = [
      { id: "l1", name: "DAPI", channel: 0, visible: true },
      { id: "l2", name: "GFP", channel: 1, visible: false },
    ];
    const commands = layerCommands(ctx)();
    expect(ids(commands)).toEqual(["layer.toggle.l1", "layer.toggle.l2"]);
    expect(commands[0].hotkey).toBe("1");
    expect(commands[1].hotkey).toBeUndefined();
    expect(commands[0].keywords).toContain("DAPI");
    expect(commands[1].icon).toBe("mdi-eye-off");
    // Titled for what it will do; no searchable current-state description.
    expect(commands.map((c) => c.title)).toEqual([
      "Hide layer: DAPI",
      "Show layer: GFP",
    ]);
    expect(commands.every((c) => c.description === undefined)).toBe(true);
    expect(ids(rankCommands(commands, "visible dapi"))).toEqual([]);
    commands[1].run();
    expect(mocks.store.toggleLayerVisibility).toHaveBeenCalledWith("l2");
  });
});

describe("layerCommands in single mode", () => {
  it("offers no 'Hide layer' for the one visible layer, which can't be hidden", () => {
    mocks.store.layerMode = "single";
    mocks.store.layers = [
      { id: "l1", name: "DAPI", channel: 0, visible: true },
      { id: "l2", name: "GFP", channel: 1, visible: false },
    ];
    const [dapi, gfp] = layerCommands(ctx)();
    expect(dapi.title).toBe("Hide layer: DAPI");
    expect(dapi.enabled!()).toBe(false);
    expect(gfp.enabled!()).toBe(true);
    mocks.store.layerMode = "multiple";
    expect(layerCommands(ctx)()[0].enabled!()).toBe(true);
    mocks.store.layers = [];
  });
});

describe("layerCommands hotkeys", () => {
  it("gives same-named layers their own key, not the first one's", () => {
    mocks.store.layers = [
      { id: "l1", name: "DAPI", channel: 0, visible: true },
      { id: "l2", name: "Cy5", channel: 1, visible: true },
      { id: "l3", name: "GFP", channel: 2, visible: true },
      { id: "l4", name: "GFP", channel: 3, visible: true },
    ];
    expect(layerCommands(ctx)().map((command) => command.hotkey)).toEqual([
      "1",
      undefined,
      "3",
      "4",
    ]);
  });
});

describe("snapshotCommands", () => {
  it("requests the snapshot and opens the Snapshots palette", () => {
    const snapshot = { name: "Fig 2", datasetViewId: "dv1", tags: ["paper"] };
    mocks.store.configuration = { snapshots: [snapshot] };
    const [command] = snapshotCommands(ctx)();
    expect(command.id).toBe("snapshot.load.dv1:Fig 2");
    expect(command.title).toBe("Go to snapshot: Fig 2");
    command.run();
    expect(snapshotLoadRequest.value).toEqual(snapshot);
    expect(mocks.store.requestPaletteOpen).toHaveBeenCalledWith([
      "snapshotPanel",
    ]);
  });
});

describe("propertyCommands", () => {
  it("opens Color by with the property pre-selected", () => {
    mocks.properties.computedPropertyPaths = [["p1", "area"]];
    const [command] = propertyCommands(ctx)();
    expect(command.title).toBe("Color by: Name of p1/area");
    command.run();
    expect(colorByPropertyRequest.value).not.toBeNull();
    expect(mocks.store.setIsColorByPropertyDialogOpen).toHaveBeenCalledWith(
      true,
    );
  });
});

describe("propertyListCommands", () => {
  it("offers each property as an object-list column, found by 'list area'", () => {
    mocks.properties.computedPropertyPaths = [
      ["p1", "Area"],
      ["p2", "Intensity"],
    ];
    mocks.properties.displayedPropertyPaths = [["p2", "Intensity"]];
    const commands = propertyListCommands(ctx)();
    expect(commands.map((c) => c.title)).toEqual([
      "Show in object list: Name of p1/Area",
      "Hide from object list: Name of p2/Intensity",
    ]);
    expect(ids(rankCommands(commands, "list area"))).toEqual([
      "property.list.p1.Area",
    ]);
    commands[0].run();
    // The Objects tab, not just the panel: the column must be in sight.
    expect(mocks.store.openAnnotationBrowserTab).toHaveBeenCalledWith(
      "objects",
    );
    expect(mocks.properties.togglePropertyPathVisibility).toHaveBeenCalledWith([
      "p1",
      "Area",
    ]);
  });

  it("does not reopen the Object Browser when hiding a column", () => {
    mocks.properties.computedPropertyPaths = [["p1", "Area"]];
    mocks.properties.displayedPropertyPaths = [["p1", "Area"]];
    mocks.store.openAnnotationBrowserTab.mockClear();
    propertyListCommands(ctx)()[0].run();
    expect(mocks.store.openAnnotationBrowserTab).not.toHaveBeenCalled();
    expect(mocks.properties.togglePropertyPathVisibility).toHaveBeenCalledWith([
      "p1",
      "Area",
    ]);
  });
});

describe("toggleCommands per-state keywords", () => {
  it("offers 'filtered' only while the command turns filtering on", async () => {
    const { ref } = await import("vue");
    const { toggleCommands } = await import("./toggles");
    const filtered = ref(true);
    const build = () =>
      toggleCommands([
        {
          id: "f",
          setting: filtered,
          turnOn: "Only show objects passing filters",
          turnOff: "Draw every object",
          keywords: ["annotations", "draw"],
          turnOnKeywords: ["filtered", "passing"],
          turnOffKeywords: ["unfiltered", "every", "all"],
        },
      ]);
    expect(ids(rankCommands(build(), "filtered objects"))).toEqual([]);
    filtered.value = false;
    expect(ids(rankCommands(build(), "filtered objects"))).toEqual(["f"]);
  });
});

describe("propertyListCommands direction", () => {
  it("lets 'add' find only a hidden column and 'remove' only a shown one", () => {
    mocks.properties.computedPropertyPaths = [
      ["p1", "Area"],
      ["p2", "Perimeter"],
    ];
    mocks.properties.displayedPropertyPaths = [["p1", "Area"]];
    const commands = propertyListCommands(ctx)();
    expect(ids(rankCommands(commands, "add column area"))).toEqual([]);
    expect(ids(rankCommands(commands, "remove column area"))).toEqual([
      "property.list.p1.Area",
    ]);
    expect(ids(rankCommands(commands, "add column perimeter"))).toEqual([
      "property.list.p2.Perimeter",
    ]);
    expect(ids(rankCommands(commands, "remove column perimeter"))).toEqual([]);
  });
});

describe("propertyListCommands at the column cap", () => {
  it("withholds 'Show in' once the list is full, but still offers 'Hide from'", () => {
    const full = Array.from({ length: 100 }, (_, i) => [`p${i}`, "v"]);
    mocks.properties.computedPropertyPaths = [
      ["p0", "v"],
      ["new", "Area"],
    ];
    mocks.properties.displayedPropertyPaths = full;
    const [hide, show] = propertyListCommands(ctx)();
    expect(hide.title).toBe("Hide from object list: Name of p0/v");
    expect(hide.enabled!()).toBe(true);
    expect(show.title).toBe("Show in object list: Name of new/Area");
    expect(show.enabled!()).toBe(false);
  });
});

describe("propertyFilterCommands", () => {
  it("adds a property's filter, or removes one already there", () => {
    mocks.properties.computedPropertyPaths = [
      ["p1", "Area"],
      ["p2", "Intensity"],
    ];
    mocks.filters.filterPaths = [["p2", "Intensity"]];
    mocks.store.requestPaletteOpen.mockClear();
    const [area, intensity] = propertyFilterCommands(ctx)();
    expect(area.title).toBe("Add filter: Name of p1/Area");
    expect(intensity.title).toBe("Stop filtering by: Name of p2/Intensity");
    // "filter <name>" finds only the add, never the removal.
    expect(ids(rankCommands([area, intensity], "filter intensity"))).toEqual(
      [],
    );
    expect(ids(rankCommands([area, intensity], "filter area"))).toEqual([
      area.id,
    ]);
    area.run();
    expect(mocks.store.requestPaletteOpen).toHaveBeenCalledWith([
      "filtersPanel",
    ]);
    expect(mocks.filters.togglePropertyPathFiltering).toHaveBeenCalledWith([
      "p1",
      "Area",
    ]);
  });
});

describe("state verbs", () => {
  it("lets a query's show/hide find only the command that does it", () => {
    mocks.store.layers = [
      { id: "l1", name: "DAPI", channel: 0, visible: true },
      { id: "l2", name: "GFP", channel: 1, visible: false },
    ];
    const layers = layerCommands(ctx)();
    expect(ids(rankCommands(layers, "hide"))).toEqual(["layer.toggle.l1"]);
    expect(ids(rankCommands(layers, "show"))).toEqual(["layer.toggle.l2"]);
    const panels = panelCommands(ctx, {
      isOpen: (id) => id === "filtersPanel",
      toggle: vi.fn(),
    })();
    expect(ids(rankCommands(panels, "show filters"))).toEqual([]);
    expect(ids(rankCommands(panels, "hide filters"))).toEqual([
      "panel.toggle.filtersPanel",
    ]);
    mocks.store.layers = [];
  });
});

describe("panelCommands", () => {
  it("flips Open/Close with the palette's state and toggles through the owner", () => {
    const open = new Set(["filtersPanel"]);
    const toggle = vi.fn();
    const commands = panelCommands(ctx, {
      isOpen: (id) => open.has(id),
      toggle,
    })();
    const filters = commands.find((c) => c.id === "panel.toggle.filtersPanel")!;
    const layers = commands.find((c) => c.id === "panel.toggle.layersPanel")!;
    expect(filters.title).toBe("Close Filters");
    expect(layers.title).toBe("Open Layers");
    filters.run();
    expect(toggle).toHaveBeenCalledWith("filtersPanel");
  });
});

describe("tourCommands", () => {
  it("offers only the tours available here", () => {
    const tours = {
      a: { name: "Intro", entryPoint: "datasetview" },
      b: { name: "Upload", entryPoint: "root" },
    } as any;
    const start = vi.fn();
    const commands = tourCommands(
      () => tours,
      (tour) => tour.entryPoint === "root",
      start,
    )();
    expect(ids(commands)).toEqual(["tour.start.b"]);
    commands[0].run();
    expect(start).toHaveBeenCalledWith("b");
  });
});
