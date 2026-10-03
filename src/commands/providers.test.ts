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
}));

vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  mocks.store = reactive({
    isLoggedIn: true,
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
    getFullNameFromPath: (path: string[]) => `Name of ${path.join("/")}`,
  });
  return { default: mocks.properties };
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
  snapshotCommands,
  toolCommands,
  tourCommands,
} from "./providers";
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
    commands[1].run();
    expect(mocks.store.toggleLayerVisibility).toHaveBeenCalledWith("l2");
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
