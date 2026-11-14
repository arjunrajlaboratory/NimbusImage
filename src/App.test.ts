import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { routeLocationKey } from "vue-router";
import { shallowMount, flushPromises, config } from "@vue/test-utils";

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

// Reactive: App.vue watches the store for palette-open requests (the escape
// hatch used by components with no access to the palette registry), and a
// plain object would never fire that watcher.
vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      isLoggedIn: false,
      girderUser: null,
      dataset: null,
      setToolTemplateList: vi.fn(),
      setIsAnnotationPanelOpen: vi.fn(),
      api: {
        getUserPrivateFolder: vi.fn().mockResolvedValue({ _id: "folder-1" }),
      },
      initializeUploadWorkflow: vi.fn(),
      isAnnotationPanelOpen: false,
      annotationPanel: false,
      paletteOpenRequests: [] as string[],
      setPaletteOpenRequests: vi.fn(),
    }),
  };
});

vi.mock("@/store/properties", () => ({
  default: {
    uncomputedCountByProperty: {} as Record<string, number>,
  },
}));

vi.mock("@/store/filters", () => ({
  default: {
    activeFilterCount: 0,
    activeAnalysisGateCount: 0,
  },
}));

vi.mock("@/store/transcripts", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      hasTranscripts: false,
      error: null,
      loading: false,
      ensureSchema: vi.fn(),
    }),
  };
});

vi.mock("axios", () => ({
  default: {
    get: vi
      .fn()
      .mockResolvedValue({ data: [{ name: "Tool1", type: "create" }] }),
  },
}));

vi.mock("mousetrap", () => ({
  default: {
    bind: vi.fn(),
    unbind: vi.fn(),
  },
}));

vi.mock("@/utils/v-mousetrap", () => ({
  default: vi.fn(),
  boundKeys: {},
}));

import { routeProvider, routerProvider } from "@/test/helpers";
import MaterializeGenesDialog from "@/components/AnnotationBrowser/MaterializeGenesDialog.vue";
import { genesDialogOpen } from "@/utils/genesDialog";
import App from "./App.vue";
import store from "@/store";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import transcriptsStore from "@/store/transcripts";
import axios from "axios";
import { logError } from "@/utils/log";

// The dataset viewer: palettes only open there.
const mockRoute = {
  name: "datasetview",
  params: {},
};

const mockRouter = {
  push: vi.fn(),
};

function mountComponent(
  routeOverrides: Record<string, any> = {},
  extraStubs: Record<string, any> = {},
  providedRoute = routeProvider({ ...mockRoute, ...routeOverrides }),
) {
  const wrapper = shallowMount(App, {
    global: {
      mocks: {
        $loadAllTours: vi.fn().mockResolvedValue({}),
        $startTour: vi.fn(),
      },
      provide: {
        ...providedRoute,
        ...routerProvider(mockRouter),
      },
      stubs: {
        "user-menu": true,
        "server-status": true,
        "analyze-annotations": true,
        "annotations-settings": true,
        snapshots: true,
        "annotation-browser": true,
        "help-panel": true,
        "bread-crumbs": true,
        "chat-component": true,
        "router-view": true,
        ...extraStubs,
      },
    },
  });
  mountedWrappers.push(wrapper);
  return wrapper;
}

// Every mounted App watches the one mocked store and remembers its layout in
// the one localStorage, so an App left mounted by an earlier test answers the
// next test's store changes and overwrites its stored layout.
const mountedWrappers: { unmount: () => void }[] = [];
afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) {
    wrapper.unmount();
  }
});

// shallowMount stubs every Vuetify component, so App.vue's own app-bar markup
// never renders. These pass-through stubs open up just the chain down to the
// palette buttons (v-app > v-app-bar > v-tooltip activator slot) so the
// filter-count badge is asserted against real rendered output.
const renderAppBarStubs = {
  VApp: { template: "<div><slot /></div>" },
  VAppBar: { template: "<div><slot /></div>" },
  VTooltip: { template: '<div><slot name="activator" :props="{}" /></div>' },
};

function mountWithAppBar() {
  (store as any).dataset = { id: "ds1", name: "Dataset" };
  return mountComponent({ name: "datasetview" }, renderAppBarStubs);
}

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // The panel layout is remembered in localStorage; without this each test
    // would start from the layout the previous one left.
    window.localStorage.clear();
    // Reset store mocks
    (store as any).isLoggedIn = false;
    (store as any).girderUser = null;
    (store as any).dataset = null;
    (store as any).setToolTemplateList = vi.fn();
    (store as any).setIsAnnotationPanelOpen = vi.fn();
    (store as any).api = {
      getUserPrivateFolder: vi.fn().mockResolvedValue({ _id: "folder-1" }),
    };
    (store as any).paletteOpenRequests = [];
    (store as any).setPaletteOpenRequests = vi.fn();
    (store as any).configuration = null;
    (store as any).datasetView = null;
    (store as any).annotationPanelBadge = false;
    (store as any).setAnnotationPanelBadge = vi.fn();
    (propertyStore as any).uncomputedCountByProperty = {};
    (filterStore as any).activeFilterCount = 0;
    (filterStore as any).activeAnalysisGateCount = 0;
    (transcriptsStore as any).error = null;
    (transcriptsStore as any).loading = false;
    (axios.get as any) = vi
      .fn()
      .mockResolvedValue({ data: [{ name: "Tool1", type: "create" }] });
    mockRouter.push = vi.fn();
  });

  // -- Computed: routeName --
  it("keeps the Transcripts control reachable after schema failure and during retry", async () => {
    const wrapper = mountWithAppBar();
    const vm = wrapper.vm as any;
    expect(wrapper.find('[aria-label="Transcripts"]').exists()).toBe(false);
    (transcriptsStore as any).error =
      "Could not read the dataset's transcript store.";
    await nextTick();
    await wrapper.get('[aria-label="Transcripts"]').trigger("click");
    expect(vm.transcriptsPanel).toBe(true);
    (transcriptsStore as any).error = null;
    (transcriptsStore as any).loading = true;
    await nextTick();
    expect(vm.transcriptsPanel).toBe(true);
    vm.togglePalette("transcriptsPanel");
    await nextTick();
    expect(wrapper.find('[aria-label="Transcripts"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("routeName returns the current route name", () => {
    const wrapper = mountComponent({ name: "datasetview" });
    const vm = wrapper.vm as any;
    expect(vm.routeName).toBe("datasetview");
  });

  it("routeName returns root when route name is root", () => {
    const wrapper = mountComponent({ name: "root" });
    const vm = wrapper.vm as any;
    expect(vm.routeName).toBe("root");
  });

  it.each([
    { name: "embed", query: {} },
    { name: "datasetview", query: { embed: "1" } },
  ])(
    "keeps palettes closed after entering an embedded viewer: $name",
    async (destination) => {
      const providedRoute = routeProvider();
      const route = providedRoute[routeLocationKey as symbol];
      const wrapper = mountComponent({}, renderAppBarStubs, providedRoute);
      const vm = wrapper.vm as any;
      Object.assign(route, destination);
      await nextTick();
      (store as any).dataset = { id: "ds1", name: "Dataset" };
      await flushPromises();
      expect(vm.navigatorPanel).toBe(false);
      expect(vm.layersPanel).toBe(false);
      expect(vm.toolsPanel).toBe(false);
      expect(wrapper.findComponent({ name: "NavigatorPanel" }).exists()).toBe(
        false,
      );

      // Late viewer requests and keyboard toggles must not reopen either side.
      (store as any).paletteOpenRequests = ["analysisPanel", "filtersPanel"];
      vm.togglePalette("navigatorPanel");
      await nextTick();
      expect(vm.analysisPanel).toBe(false);
      expect(vm.filtersPanel).toBe(false);
      expect(vm.navigatorPanel).toBe(false);
      expect(store.setPaletteOpenRequests).toHaveBeenCalledWith([]);

      // The normalized route name stays datasetview: leaving embed must still
      // restore the ordinary shared viewer's default controls.
      Object.assign(route, { name: "shared", query: {} });
      await nextTick();
      expect(vm.navigatorPanel).toBe(true);
      expect(vm.layersPanel).toBe(true);
      expect(vm.toolsPanel).toBe(true);
      wrapper.unmount();
    },
  );

  // -- Method: togglePalette --
  it("togglePalette opens a palette", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.annotationPanel).toBe(false);
    vm.togglePalette("annotationPanel");
    expect(vm.annotationPanel).toBe(true);
  });

  it("togglePalette closes a palette that is already open", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.togglePalette("annotationPanel");
    expect(vm.annotationPanel).toBe(true);
    vm.togglePalette("annotationPanel");
    expect(vm.annotationPanel).toBe(false);
  });

  it("opening a primary palette closes other primaries", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.togglePalette("annotationPanel");
    expect(vm.annotationPanel).toBe(true);
    vm.togglePalette("settingsPanel");
    expect(vm.settingsPanel).toBe(true);
    expect(vm.annotationPanel).toBe(false);
  });

  it("Filters and the Object Browser can be open together", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.togglePalette("annotationPanel");
    vm.togglePalette("filtersPanel");
    expect(vm.annotationPanel).toBe(true);
    expect(vm.filtersPanel).toBe(true);
  });

  it("Filters and the Analysis panel can be open together", () => {
    // The Analysis panel's over-cap guidance is "narrow the filters", so
    // opening Filters must not evict it.
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.togglePalette("analysisPanel");
    vm.togglePalette("filtersPanel");
    expect(vm.analysisPanel).toBe(true);
    expect(vm.filtersPanel).toBe(true);
  });

  it("stacks Filters above whichever primary hosts it", () => {
    // Coexisting is not enough: both palettes are right-anchored, so without a
    // stacking offset the wider Analysis panel simply covers Filters and the
    // guidance to use it stays unusable. The offset must apply to BOTH hosts.
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.filtersStacked).toBe(false);

    vm.togglePalette("annotationPanel");
    vm.togglePalette("filtersPanel");
    expect(vm.filtersStacked).toBe(true);

    // Switch the host to the Analysis panel: still stacked, not overlapping.
    vm.togglePalette("analysisPanel");
    expect(vm.analysisPanel).toBe(true);
    expect(vm.filtersPanel).toBe(true);
    expect(vm.filtersStacked).toBe(true);
  });

  it("Filters stays open when the Object Browser is closed", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.togglePalette("annotationPanel");
    vm.togglePalette("filtersPanel");
    vm.togglePalette("annotationPanel"); // close the host directly
    expect(vm.annotationPanel).toBe(false);
    expect(vm.filtersPanel).toBe(true);
  });

  it("opening Settings closes both the Object Browser and Filters", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.togglePalette("annotationPanel");
    vm.togglePalette("filtersPanel");
    vm.togglePalette("settingsPanel");
    expect(vm.settingsPanel).toBe(true);
    expect(vm.annotationPanel).toBe(false);
    expect(vm.filtersPanel).toBe(false);
  });

  it("opening Filters alongside a non-host primary evicts that primary", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.togglePalette("settingsPanel");
    vm.togglePalette("filtersPanel");
    expect(vm.filtersPanel).toBe(true);
    expect(vm.settingsPanel).toBe(false);
  });

  // -- Leaving and re-entering the viewer --
  it("shows no palette outside the viewer and brings the layout back on return", async () => {
    const providedRoute = routeProvider({ ...mockRoute });
    const route = providedRoute[routeLocationKey as symbol];
    const wrapper = mountComponent({}, {}, providedRoute);
    const vm = wrapper.vm as any;
    vm.togglePalette("annotationPanel");
    vm.togglePalette("filtersPanel");
    vm.togglePalette("layersPanel");

    Object.assign(route, { name: "root" });
    await nextTick();
    for (const id of [
      "annotationPanel",
      "filtersPanel",
      "navigatorPanel",
      "toolsPanel",
    ]) {
      expect(vm[id]).toBe(false);
    }
    // Nothing opens out there either.
    vm.togglePalette("settingsPanel");
    expect(vm.settingsPanel).toBe(false);

    Object.assign(route, { name: "datasetview" });
    await nextTick();
    expect(vm.annotationPanel).toBe(true);
    expect(vm.filtersPanel).toBe(true);
    expect(vm.navigatorPanel).toBe(true);
    expect(vm.layersPanel).toBe(false);
    expect(vm.settingsPanel).toBe(false);
    wrapper.unmount();
  });

  // -- Chips, hide-all, resize and reorder --
  describe("rearranging palettes", () => {
    function mountViewer() {
      (store as any).dataset = { id: "ds1", name: "Dataset" };
      return mountComponent({}, renderAppBarStubs);
    }

    function paletteStub(
      wrapper: ReturnType<typeof mountViewer>,
      title: string,
    ) {
      const stub = wrapper
        .findAllComponents({ name: "FloatingPalette" })
        .find((palette) => palette.props("title") === title);
      expect(stub, `${title} palette`).toBeDefined();
      return stub!;
    }

    function chip(wrapper: ReturnType<typeof mountViewer>, id: string) {
      return wrapper.find(
        `.palette-chip[data-command-id="panel.toggle.${id}"]`,
      );
    }

    function chipTitles(wrapper: ReturnType<typeof mountViewer>, zone: string) {
      return wrapper
        .findAll(`.palette-chips[data-zone="${zone}"] .palette-chip`)
        .map((element) => element.text());
    }

    function hideAll(vm: any) {
      vm.appHotkeys
        .find((entry: any) => entry.bind === "mod+.")
        .handler(document.body, new KeyboardEvent("keydown"));
    }

    // jsdom has no ResizeObserver: stand one in, and report sizes through
    // the function this returns.
    function stubResizeObserver() {
      const callbacks: ((entries: { target: Element }[]) => void)[] = [];
      const observed = new Set<Element>();
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe = vi.fn((element: Element) => {
            if (element.classList.contains("palette-chips")) {
              observed.add(element);
            }
          });
          disconnect = vi.fn();
          constructor(callback: (entries: { target: Element }[]) => void) {
            callbacks.push(callback);
          }
        },
      );
      const report = (element: Element, width: number, height: number) => {
        Object.defineProperty(element, "offsetWidth", {
          value: width,
          configurable: true,
        });
        Object.defineProperty(element, "offsetHeight", {
          value: height,
          configurable: true,
        });
        for (const callback of callbacks) {
          callback([{ target: element }]);
        }
      };
      // What was handed to an observer, so a test can tell the rows are
      // really being watched and not only that the callback works.
      report.observed = () => [...observed];
      return report;
    }

    function storedArrangement() {
      return JSON.parse(
        window.localStorage.getItem("nimbus.ui.anonymous.layout.arrangement")!,
      );
    }

    it("a closed panel is a chip in its zone, and clicking it opens the panel", async () => {
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      // The default: the left stack open, the right column closed.
      expect(chipTitles(wrapper, "left")).toEqual([]);
      expect(chipTitles(wrapper, "right")).toEqual([
        "Object Browser",
        "Filters",
        "Analysis",
        "Snapshots",
        "Settings",
      ]);

      paletteStub(wrapper, "Tools").vm.$emit("update:modelValue", false);
      await nextTick();
      expect(chipTitles(wrapper, "left")).toEqual(["Tools"]);
      await chip(wrapper, "toolsPanel").trigger("click");
      expect(vm.toolsPanel).toBe(true);
      // An open panel has no chip.
      expect(chip(wrapper, "toolsPanel").exists()).toBe(false);

      // A chip opens through the placement rules.
      await chip(wrapper, "annotationPanel").trigger("click");
      await chip(wrapper, "settingsPanel").trigger("click");
      expect(vm.settingsPanel).toBe(true);
      expect(vm.annotationPanel).toBe(false);
      expect(chip(wrapper, "annotationPanel").exists()).toBe(true);
    });

    it("left chips follow the user's stack order", async () => {
      const wrapper = mountViewer();
      paletteStub(wrapper, "Navigator").vm.$emit("reorder-step", 1);
      for (const title of ["Navigator", "Layers", "Tools"]) {
        paletteStub(wrapper, title).vm.$emit("update:modelValue", false);
      }
      await nextTick();
      expect(chipTitles(wrapper, "left")).toEqual([
        "Layers",
        "Navigator",
        "Tools",
      ]);
    });

    it("an unavailable panel has no chip", async () => {
      const wrapper = mountViewer();
      expect(chip(wrapper, "transcriptsPanel").exists()).toBe(false);
      // Not while the dataset's first lookup runs: most datasets have no
      // transcripts, and the chip would come and go on every load.
      (transcriptsStore as any).loading = true;
      await nextTick();
      expect(chip(wrapper, "transcriptsPanel").exists()).toBe(false);
      (transcriptsStore as any).loading = false;
      (transcriptsStore as any).hasTranscripts = true;
      await nextTick();
      expect(chip(wrapper, "transcriptsPanel").exists()).toBe(true);
      (transcriptsStore as any).hasTranscripts = false;
      await nextTick();
      expect(chip(wrapper, "transcriptsPanel").exists()).toBe(false);
    });

    it("a chip carries its badge, and its label says what the count means", async () => {
      (filterStore as any).activeFilterCount = 4;
      const wrapper = mountViewer();
      const filters = chip(wrapper, "filtersPanel");
      expect(filters.find(".palette-chip-badge").text()).toBe("4");
      // The count is in the label too, not only in the badge it draws.
      expect(filters.attributes("aria-label")).toBe("Filters (4 active)");
      // A chip with nothing to report has no badge.
      expect(
        chip(wrapper, "settingsPanel").find(".palette-chip-badge").exists(),
      ).toBe(false);
    });

    it("a chip's tooltip says what its panel is for, and what its count means", () => {
      (filterStore as any).activeFilterCount = 2;
      const vm = mountViewer().vm as any;
      const tooltip = (id: string) =>
        vm.panelChips.right.find((entry: any) => entry.id === id).tooltip;
      expect(tooltip("filtersPanel")).toBe(vm.filtersTooltip);
      expect(tooltip("filtersPanel")).toContain("(2 active filters)");
      expect(tooltip("analysisPanel")).toBe(vm.analysisTooltip);
      expect(tooltip("settingsPanel")).toBe(
        "Image and object display settings",
      );
    });

    it("the chips the tours point at carry their anchors", () => {
      const wrapper = mountViewer();
      expect(chip(wrapper, "annotationPanel").attributes("data-tour")).toBe(
        "object-list-button",
      );
      expect(chip(wrapper, "settingsPanel").attributes("data-tour")).toBe(
        "settings-button",
      );
      expect(
        chip(wrapper, "analysisPanel").attributes("data-tour"),
      ).toBeUndefined();
      // The open palette names the step its chip was for.
      expect(
        paletteStub(wrapper, "Object Browser").props("tourDoneAnchor"),
      ).toBe("object-list-button");
      expect(
        paletteStub(wrapper, "Tools").props("tourDoneAnchor"),
      ).toBeUndefined();
    });

    it("the app bar has no panel toggles", () => {
      const wrapper = mountViewer();
      expect(
        wrapper
          .findAll("[data-command-id^='panel.toggle.']")
          .every((element) => element.classes("palette-chip")),
      ).toBe(true);
      expect(wrapper.findAll(".palette-ibtn")).toHaveLength(2);
    });

    it("there are no chips outside the viewer or in the embed", async () => {
      const providedRoute = routeProvider({ ...mockRoute });
      const route = providedRoute[routeLocationKey as symbol];
      (store as any).dataset = { id: "ds1", name: "Dataset" };
      const wrapper = mountComponent({}, renderAppBarStubs, providedRoute);
      expect(wrapper.findAll(".palette-chip").length).toBeGreaterThan(0);

      Object.assign(route, { name: "root" });
      await nextTick();
      expect(wrapper.findAll(".palette-chip")).toHaveLength(0);

      Object.assign(route, { name: "embed" });
      await nextTick();
      expect(wrapper.findAll(".palette-chip")).toHaveLength(0);
    });

    it("saving the collection default takes the panels shown as palettes, even while all are hidden", async () => {
      (store as any).isLoggedIn = true;
      (store as any).saveDefaultPanelLayout = vi.fn();
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      vm.togglePalette("annotationPanel");
      paletteStub(wrapper, "Tools").vm.$emit("update:modelValue", false);
      hideAll(vm);
      await nextTick();
      expect(store.saveDefaultPanelLayout).not.toHaveBeenCalled();

      const { allCommands } = await import("@/commands/registry");
      allCommands.value
        .find((command) => command.id === "layout.saveCollectionDefault")!
        .run();
      expect(store.saveDefaultPanelLayout).toHaveBeenCalledTimes(1);
      expect(
        (store.saveDefaultPanelLayout as any).mock.calls[0][0].open,
      ).toEqual(["navigatorPanel", "layersPanel", "annotationPanel"]);
    });

    it("the collection default is what a first visit opens with, until I change it", async () => {
      (store as any).configuration = {
        id: "config-default",
        defaultPanelLayout: { version: 1, open: ["snapshotPanel"] },
      };
      (store as any).datasetView = {
        id: "view1",
        configurationId: "config-default",
      };
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      expect(vm.snapshotPanel).toBe(true);
      expect(vm.navigatorPanel).toBe(false);
      vm.togglePalette("toolsPanel");
      wrapper.unmount();

      const again = mountViewer().vm as any;
      expect(again.snapshotPanel).toBe(true);
      expect(again.toolsPanel).toBe(true);
    });

    it("does not take the previous collection's layout while the next one loads", async () => {
      // The store keeps the old configuration until the new one arrives.
      (store as any).configuration = {
        id: "config-old",
        defaultPanelLayout: { version: 1, open: ["snapshotPanel"] },
      };
      (store as any).datasetView = { id: "view-new", configurationId: "new" };
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      expect(vm.snapshotPanel).toBe(false);
      expect(vm.navigatorPanel).toBe(true);

      (store as any).configuration = {
        id: "new",
        defaultPanelLayout: { version: 1, open: ["settingsPanel"] },
      };
      await nextTick();
      expect(vm.settingsPanel).toBe(true);
      expect(vm.navigatorPanel).toBe(false);
    });

    it("waits for the view the route names before reading its collection", async () => {
      (store as any).configuration = {
        id: "config-old",
        defaultPanelLayout: { version: 1, open: ["snapshotPanel"] },
      };
      // Still the previous view: the route already names the next one.
      (store as any).datasetView = {
        id: "view-old",
        configurationId: "config-old",
      };
      const wrapper = mountComponent(
        { params: { datasetViewId: "view-new" } },
        renderAppBarStubs,
      );
      expect((wrapper.vm as any).snapshotPanel).toBe(false);
    });

    it("hide-all also hides the Timelapse palette and the Analyze drawer, and brings them back", async () => {
      const { default: timelapseStore } = await import("@/store/timelapse");
      timelapseStore.setShowMode(true);
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      vm.analyzePanel = true;
      await nextTick();
      const drawer = () => wrapper.findComponent({ name: "VNavigationDrawer" });
      expect(vm.timelapsePaletteShown).toBe(true);
      expect(drawer().props("modelValue")).toBe(true);

      const hideAll = vm.appHotkeys.find(
        (entry: any) => entry.bind === "mod+.",
      );
      hideAll.handler(document.body, new KeyboardEvent("keydown"));
      await nextTick();
      expect(vm.timelapsePaletteShown).toBe(false);
      expect(paletteStub(wrapper, "Time Lapse").props("modelValue")).toBe(
        false,
      );
      expect(drawer().props("modelValue")).toBe(false);
      // Masked, not turned off.
      expect(timelapseStore.showMode).toBe(true);
      expect(vm.analyzePanel).toBe(true);

      hideAll.handler(document.body, new KeyboardEvent("keydown"));
      await nextTick();
      expect(vm.timelapsePaletteShown).toBe(true);
      expect(drawer().props("modelValue")).toBe(true);
      timelapseStore.setShowMode(false);
    });

    it("opening a panel that hide-all masks ends hide-all", async () => {
      const { default: timelapseStore } = await import("@/store/timelapse");
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      const hideAll = vm.appHotkeys.find(
        (entry: any) => entry.bind === "mod+.",
      );

      hideAll.handler(document.body, new KeyboardEvent("keydown"));
      timelapseStore.setShowMode(true);
      await nextTick();
      expect(vm.timelapsePaletteShown).toBe(true);
      expect(vm.navigatorPanel).toBe(true);

      hideAll.handler(document.body, new KeyboardEvent("keydown"));
      vm.analyzePanel = true;
      await nextTick();
      expect(vm.navigatorPanel).toBe(true);

      // Closing one of them is not a reason to bring the panels back.
      hideAll.handler(document.body, new KeyboardEvent("keydown"));
      timelapseStore.setShowMode(false);
      vm.analyzePanel = false;
      await nextTick();
      expect(vm.navigatorPanel).toBe(false);
    });

    it("the AI button shows a masked AI panel instead of closing it", async () => {
      (store as any).isLoggedIn = true;
      (store as any).girderUser = { _id: "u1" };
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      vm.aiPanelOpen = true;
      const hideAll = vm.appHotkeys.find(
        (entry: any) => entry.bind === "mod+.",
      );
      hideAll.handler(document.body, new KeyboardEvent("keydown"));
      await nextTick();
      expect(vm.navigatorPanel).toBe(false);

      const { allCommands } = await import("@/commands/registry");
      allCommands.value
        .find((command) => command.id === "ai.togglePanel")!
        .run();
      expect(vm.aiPanelOpen).toBe(true);
      expect(vm.navigatorPanel).toBe(true);
    });

    it("surfaces at the top of the canvas start below the chip rows instead of beside them", async () => {
      const report = stubResizeObserver();
      try {
        const wrapper = mountViewer();
        const vm = wrapper.vm as any;
        const cssVar = (name: string) =>
          (wrapper.vm as any).$el.style.getPropertyValue(name);
        const belowOneRow = `${72 + 28 + 8}px`;
        expect(cssVar("--nimbus-below-chip-rows")).toBe(belowOneRow);
        expect(cssVar("--nimbus-action-panel-top")).toBe(belowOneRow);

        // The rows take no width from the canvas: a closed right column
        // leaves the right edge clear, and chips alone on the left do not
        // count as a palette there.
        expect(vm.rightEdgeClearance).toBe(16);
        for (const title of ["Navigator", "Layers", "Tools"]) {
          paletteStub(wrapper, title).vm.$emit("update:modelValue", false);
        }
        await nextTick();
        expect((wrapper.vm as any).$el.classList).not.toContain(
          "any-left-palette-open",
        );

        // Both rows are measured, and a row that wraps moves the band's end.
        const rows = wrapper.findAll(".palette-chips");
        expect(report.observed()).toEqual(rows.map((row) => row.element));
        report(rows[0].element, 300, 62);
        await nextTick();
        expect(cssVar("--nimbus-below-chip-rows")).toBe(`${72 + 62 + 8}px`);
        expect(cssVar("--nimbus-action-panel-top")).toBe(`${72 + 62 + 8}px`);
        // The connection panel stays its fixed distance below the object one.
        expect(cssVar("--nimbus-stacked-action-panel-top")).toBe(
          `${72 + 62 + 8 + 232}px`,
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("a tour step inside a palette that is not showing gets it opened", async () => {
      const { tourBus, TOUR_REVEAL_PANEL_EVENT } = await import(
        "@/plugins/tourBus"
      );
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      expect(paletteStub(wrapper, "Tools").props("panelId")).toBe("toolsPanel");
      vm.togglePalette("toolsPanel");
      vm.togglePalette("layersPanel");
      hideAll(vm);
      await nextTick();

      tourBus.emit(TOUR_REVEAL_PANEL_EVENT, "toolsPanel");
      tourBus.emit(TOUR_REVEAL_PANEL_EVENT, "layersPanel");
      tourBus.emit(TOUR_REVEAL_PANEL_EVENT, "noSuchPanel");
      tourBus.emit(TOUR_REVEAL_PANEL_EVENT, undefined);
      await nextTick();
      expect(vm.toolsPanel).toBe(true);
      expect(vm.layersPanel).toBe(true);

      // Not after the App is gone.
      wrapper.unmount();
      expect(() =>
        tourBus.emit(TOUR_REVEAL_PANEL_EVENT, "settingsPanel"),
      ).not.toThrow();
    });

    it("a tour step hidden only by hide-all gets the panels back", async () => {
      const { tourBus, TOUR_REVEAL_PANEL_EVENT } = await import(
        "@/plugins/tourBus"
      );
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      // Nothing to do while nothing is hidden.
      tourBus.emit(TOUR_REVEAL_PANEL_EVENT, undefined);
      expect(vm.navigatorPanel).toBe(true);

      const hideAll = vm.appHotkeys.find(
        (entry: any) => entry.bind === "mod+.",
      );
      hideAll.handler(document.body, new KeyboardEvent("keydown"));
      expect(vm.navigatorPanel).toBe(false);
      tourBus.emit(TOUR_REVEAL_PANEL_EVENT, undefined);
      expect(vm.navigatorPanel).toBe(true);
    });

    it("a resize of an unresized zone starts from its widest palette showing", async () => {
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      // Navigator 380, Layers 420, Tools 380.
      expect(paletteStub(wrapper, "Navigator").props("resizeRange")).toEqual({
        base: 420,
        min: 380,
        max: 460,
      });
      vm.togglePalette("layersPanel"); // closed: the widest showing is 380
      await nextTick();
      expect(paletteStub(wrapper, "Navigator").props("resizeRange").base).toBe(
        380,
      );
      // Once resized, the zone's own width.
      paletteStub(wrapper, "Navigator").vm.$emit("resize-end", 440);
      await nextTick();
      expect(paletteStub(wrapper, "Tools").props("resizeRange").base).toBe(440);
      // The right zone is its own.
      vm.togglePalette("annotationPanel");
      vm.togglePalette("filtersPanel");
      await nextTick();
      expect(paletteStub(wrapper, "Filters").props("resizeRange").base).toBe(
        512,
      );
    });

    it("tells each left palette its place among those showing", async () => {
      const wrapper = mountViewer();
      const place = (title: string) =>
        paletteStub(wrapper, title).props("stackPosition");
      expect(place("Layers")).toEqual({ position: 2, count: 3 });
      (wrapper.vm as any).togglePalette("navigatorPanel");
      await nextTick();
      expect(place("Layers")).toEqual({ position: 1, count: 2 });
      expect(place("Tools")).toEqual({ position: 2, count: 2 });
    });

    it("the arrow keys on a left palette's grip move it one place", async () => {
      const wrapper = mountViewer();
      paletteStub(wrapper, "Navigator").vm.$emit("reorder-step", 1);
      await nextTick();
      expect(storedArrangement().leftOrder).toEqual([
        "layersPanel",
        "navigatorPanel",
        "toolsPanel",
      ]);
      // Layers is closed: Tools steps past it to above Navigator.
      (wrapper.vm as any).togglePalette("layersPanel");
      paletteStub(wrapper, "Tools").vm.$emit("reorder-step", -1);
      await nextTick();
      expect(storedArrangement().leftOrder).toEqual([
        "layersPanel",
        "toolsPanel",
        "navigatorPanel",
      ]);
    });

    it("a closed panel with unseen job results is accented until it is shown", async () => {
      (store as any).annotationPanelBadge = true;
      (store as any).setAnnotationPanelBadge = vi.fn((value: boolean) => {
        (store as any).annotationPanelBadge = value;
      });
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      await nextTick();
      const objectBrowser = chip(wrapper, "annotationPanel");
      expect(objectBrowser.classes()).toContain("relevant");
      expect(objectBrowser.attributes("aria-label")).toBe(
        "Object Browser (new results)",
      );
      // No other chip is accented.
      expect(wrapper.findAll(".palette-chip.relevant")).toHaveLength(1);

      vm.togglePalette("annotationPanel");
      await nextTick();
      expect(store.setAnnotationPanelBadge).toHaveBeenCalledWith(false);
      // Shown: the chip is gone, and closed again it is not accented.
      expect(chip(wrapper, "annotationPanel").exists()).toBe(false);
      vm.togglePalette("annotationPanel");
      await nextTick();
      expect(chip(wrapper, "annotationPanel").classes()).not.toContain(
        "relevant",
      );
      expect(chip(wrapper, "annotationPanel").attributes("aria-label")).toBe(
        "Object Browser",
      );
    });

    it("results that arrive while the Object Browser is showing are not unseen", async () => {
      (store as any).setAnnotationPanelBadge = vi.fn((value: boolean) => {
        (store as any).annotationPanelBadge = value;
      });
      // A layout remembered with the browser open: open from the first frame.
      const first = mountViewer();
      (first.vm as any).togglePalette("annotationPanel");
      first.unmount();
      (store as any).setIsAnnotationPanelOpen = vi.fn();
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      expect(vm.annotationPanel).toBe(true);
      // The store is told at once, not at the first toggle.
      expect(store.setIsAnnotationPanelOpen).toHaveBeenCalledWith(true);

      // Even if a job raised the flag anyway, it does not outlast the tick.
      (store as any).annotationPanelBadge = true;
      await nextTick();
      expect((store as any).annotationPanelBadge).toBe(false);
      vm.togglePalette("annotationPanel");
      await nextTick();
      expect(chip(wrapper, "annotationPanel").classes()).not.toContain(
        "relevant",
      );
    });

    it("another dataset clears the accent", async () => {
      (store as any).setAnnotationPanelBadge = vi.fn((value: boolean) => {
        (store as any).annotationPanelBadge = value;
      });
      const wrapper = mountViewer();
      (store as any).annotationPanelBadge = true;
      await nextTick();
      expect(chip(wrapper, "annotationPanel").classes()).toContain("relevant");

      (store as any).dataset = { id: "ds2", name: "Another" };
      await nextTick();
      expect((store as any).annotationPanelBadge).toBe(false);
      expect(chip(wrapper, "annotationPanel").classes()).not.toContain(
        "relevant",
      );
    });

    it("gives the AI agent's tools the layout's owner while mounted", async () => {
      const { panelLayoutController } = await import(
        "@/utils/panelLayoutController"
      );
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      const controller = panelLayoutController()!;
      expect(controller.inViewer()).toBe(true);
      controller.applyOpenSet(["layersPanel", "filtersPanel", "analysisPanel"]);
      expect(vm.analysisPanel).toBe(true);
      expect(vm.navigatorPanel).toBe(false);
      controller.close("layersPanel");
      controller.open("toolsPanel");
      expect(controller.openPanels()).toEqual([
        "filtersPanel",
        "analysisPanel",
        "toolsPanel",
      ]);
      expect(controller.isAvailable("transcriptsPanel")).toBe(false);

      // A snapshot puts back what was open.
      const snapshot = JSON.parse(JSON.stringify(controller.layoutSnapshot()));
      controller.applyOpenSet(["navigatorPanel"]);
      controller.restoreLayout(snapshot);
      expect(controller.openPanels()).toEqual([
        "filtersPanel",
        "analysisPanel",
        "toolsPanel",
      ]);
      controller.restoreLayout({ layout: { open: "nonsense" } });
      controller.restoreLayout(null);
      expect(controller.openPanels()).toEqual([
        "filtersPanel",
        "analysisPanel",
        "toolsPanel",
      ]);

      // A snapshot taken under "hide all panels" puts that back too.
      const hideAll = vm.appHotkeys.find(
        (entry: any) => entry.bind === "mod+.",
      );
      hideAll.handler(document.body, new KeyboardEvent("keydown"));
      const hidden = JSON.parse(JSON.stringify(controller.layoutSnapshot()));
      controller.open("navigatorPanel"); // ends hide-all
      expect(controller.allHidden()).toBe(false);
      controller.restoreLayout(hidden);
      expect(controller.allHidden()).toBe(true);
      expect(controller.openPanels()).not.toContain("navigatorPanel");

      wrapper.unmount();
      expect(panelLayoutController()).toBeNull();
    });

    it("tells the Layers panel whether it is on screen", async () => {
      // The panel is the palette stub's slot content, which a shallow mount
      // renders only when asked.
      config.global.renderStubDefaultSlot = true;
      try {
        const wrapper = mountViewer();
        const layers = () => wrapper.findComponent({ name: "LayersPanel" });
        expect(layers().props("visible")).toBe(true);
        paletteStub(wrapper, "Layers").vm.$emit("update:modelValue", false);
        await nextTick();
        expect(layers().props("visible")).toBe(false);
      } finally {
        config.global.renderStubDefaultSlot = false;
      }
    });

    it("both zones keep a row's height for their chips, so toggling a panel moves no other", async () => {
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      const belowOneRow = 72 + 28 + 8;
      // Left: every panel open, so no chips, and the space is kept anyway.
      expect(vm.leftStack.navigatorPanel.top).toBe(belowOneRow);
      expect(vm.rightColumnTop).toBe(belowOneRow);
      vm.togglePalette("annotationPanel");
      vm.togglePalette("filtersPanel");
      await nextTick();
      expect(paletteStub(wrapper, "Filters").props("top")).toBe(belowOneRow);

      // The first left chip appears: Navigator does not move.
      paletteStub(wrapper, "Tools").vm.$emit("update:modelValue", false);
      await nextTick();
      expect(vm.leftStack.navigatorPanel.top).toBe(belowOneRow);
      expect(vm.rightColumnTop).toBe(belowOneRow);
    });

    it("the Timelapse palette starts below the taller chip row", async () => {
      const report = stubResizeObserver();
      try {
        const wrapper = mountViewer();
        const timelapseTop = () =>
          paletteStub(wrapper, "Time Lapse").props("top");
        expect(timelapseTop()).toBe(72 + 28 + 8);
        report(
          wrapper.get('.palette-chips[data-zone="right"]').element,
          400,
          62,
        );
        await nextTick();
        expect(timelapseTop()).toBe(72 + 62 + 8);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("the right chip row is wide enough for all its chips, within the space beside the left column", async () => {
      const wrapper = mountViewer();
      const maxWidth = (zone: string) =>
        (
          wrapper.get(`.palette-chips[data-zone="${zone}"]`)
            .element as HTMLElement
        ).style.maxWidth;
      expect(maxWidth("left")).toBe("420px");
      // The test window is 1024 wide: what is left beside the 420px column.
      expect(maxWidth("right")).toBe(`${1024 - (16 + 420 + 8) - 16}px`);
    });

    it("every chip's command id names a registered command", async () => {
      const { allCommands } = await import("@/commands/registry");
      const wrapper = mountViewer();
      const ids = wrapper
        .findAll(".palette-chip[data-command-id]")
        .map((element) => element.attributes("data-command-id"));
      expect(ids.length).toBeGreaterThanOrEqual(5);
      const registered = new Set(
        allCommands.value.map((command) => command.id),
      );
      expect(ids.filter((id) => !registered.has(id!))).toEqual([]);
    });

    it("starting a tour ends hide-all, so its steps have something to point at", async () => {
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      hideAll(vm);
      await nextTick();
      expect(vm.navigatorPanel).toBe(false);
      vm.handleTourStart("anyTour");
      await nextTick();
      expect(vm.navigatorPanel).toBe(true);
    });

    it("a wrapped chip row pushes its zone's palettes and the overview down", async () => {
      const report = stubResizeObserver();
      try {
        const wrapper = mountViewer();
        const vm = wrapper.vm as any;
        const overviewTop = () =>
          (wrapper.vm as any).$el.style.getPropertyValue(
            "--nimbus-overview-top",
          );
        expect(overviewTop()).toBe(`${72 + 28 + 8}px`);
        report(
          wrapper.get('.palette-chips[data-zone="right"]').element,
          400,
          62,
        );
        await nextTick();
        expect(vm.rightColumnTop).toBe(72 + 62 + 8);
        expect(paletteStub(wrapper, "Settings").props("top")).toBe(142);
        expect(overviewTop()).toBe("142px");

        // Opening a panel leaves the other chips, so the row stays measured.
        vm.togglePalette("snapshotPanel");
        await nextTick();
        expect(vm.rightColumnTop).toBe(142);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("the hide-all hotkey hides every palette and leaves one chip to bring them back", async () => {
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      vm.togglePalette("annotationPanel");
      hideAll(vm);
      await nextTick();
      for (const id of ["annotationPanel", "navigatorPanel", "toolsPanel"]) {
        expect(vm[id]).toBe(false);
      }
      expect(
        wrapper.findAll(".palette-chip").map((element) => element.text()),
      ).toEqual(["Show panels"]);

      await wrapper.get('[aria-label="Show all panels"]').trigger("click");
      expect(vm.annotationPanel).toBe(true);
      expect(vm.navigatorPanel).toBe(true);
      expect(wrapper.find('[aria-label="Show all panels"]').exists()).toBe(
        false,
      );
    });

    it("dragging a zone's edge resizes every palette in it, clamped to the viewport", async () => {
      const wrapper = mountViewer();
      const settings = () => paletteStub(wrapper, "Settings");
      const defaultWidth = settings().props("width");
      const defaultSnapshots = paletteStub(wrapper, "Snapshots").props("width");

      // The test window is 1024 wide; a zone may take 45% of it.
      settings().vm.$emit("resize", 5000);
      await nextTick();
      expect(settings().props("width")).toBe(460);
      expect(paletteStub(wrapper, "Snapshots").props("width")).toBe(460);
      // The left zone is untouched.
      expect(paletteStub(wrapper, "Layers").props("width")).toBe(420);

      settings().vm.$emit("resize-cancel");
      await nextTick();
      expect(settings().props("width")).toBe(defaultWidth);
      expect(
        window.localStorage.getItem("nimbus.ui.anonymous.layout.arrangement"),
      ).toBeNull();

      settings().vm.$emit("resize", 430);
      settings().vm.$emit("resize-end", 440);
      await nextTick();
      expect(settings().props("width")).toBe(440);
      expect(storedArrangement().widths).toEqual({ right: 440 });

      settings().vm.$emit("resize-reset");
      await nextTick();
      expect(settings().props("width")).toBe(defaultWidth);
      expect(paletteStub(wrapper, "Snapshots").props("width")).toBe(
        defaultSnapshots,
      );
      expect(storedArrangement().widths).toEqual({});
    });

    it("a resized left column moves the surfaces that clear it", async () => {
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      const timelapseLeft = paletteStub(wrapper, "Time Lapse").props("left");
      paletteStub(wrapper, "Layers").vm.$emit("resize-end", 450);
      await nextTick();
      expect(vm.leftColumn).toBe(450);
      for (const title of ["Navigator", "Layers", "Tools"]) {
        expect(paletteStub(wrapper, title).props("width")).toBe(450);
      }
      expect(paletteStub(wrapper, "Time Lapse").props("left")).toBe(
        timelapseLeft + 30,
      );
    });

    it("dropping a left palette lower moves it down the stack and is remembered", async () => {
      const wrapper = mountViewer();
      const vm = wrapper.vm as any;
      // Nothing is laid out here, so every palette's center is its top.
      paletteStub(wrapper, "Navigator").vm.$emit("reorder-end", 100);
      await nextTick();
      expect(storedArrangement().leftOrder).toEqual([
        "layersPanel",
        "toolsPanel",
        "navigatorPanel",
      ]);
      expect(Object.keys(vm.leftStack)).toEqual([
        "layersPanel",
        "toolsPanel",
        "navigatorPanel",
      ]);
    });
  });

  it("remembers the layout for the next page load", () => {
    const first = mountComponent();
    (first.vm as any).togglePalette("snapshotPanel");
    (first.vm as any).togglePalette("toolsPanel");
    first.unmount();

    const vm = mountComponent().vm as any;
    expect(vm.snapshotPanel).toBe(true);
    expect(vm.toolsPanel).toBe(false);
    expect(vm.navigatorPanel).toBe(true);
  });

  // -- Method: toggleHelpDialogUsingHotkey --
  it("toggleHelpDialogUsingHotkey opens the help panel", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.helpPanelIsOpen).toBe(false);
    vm.toggleHelpDialogUsingHotkey();
    expect(vm.helpPanelIsOpen).toBe(true);
  });

  it("toggleHelpDialogUsingHotkey closes the help panel when already open", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.helpPanelIsOpen = true;
    vm.toggleHelpDialogUsingHotkey();
    expect(vm.helpPanelIsOpen).toBe(false);
  });

  // -- appHotkeys --
  it("appHotkeys binds the help overlay to tab", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const tab = vm.appHotkeys.find((hotkey: any) => hotkey.bind === "tab");
    expect(typeof tab.handler).toBe("function");
  });

  it("appHotkeys toggles the command palette on mod+k and claims the key", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const hotkey = vm.appHotkeys.find((h: any) => h.bind === "mod+k");
    // Listed in the Tab help overlay.
    expect(hotkey.data.section).toBe("Global");
    const event = { preventDefault: vi.fn() };
    hotkey.handler(document.body, event);
    expect(vm.commandPaletteOpen).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    hotkey.handler(document.body, event);
    expect(vm.commandPaletteOpen).toBe(false);
  });

  it("opens the AI panel for a palette prompt, only when it may open", async () => {
    const { aiPromptRequest } = await import("@/commands/requests");
    (store as any).dataset = { id: "ds1", name: "Dataset" };
    const wrapper = mountComponent({ name: "datasetview" });
    const vm = wrapper.vm as any;
    aiPromptRequest.value = "count cells";
    await nextTick();
    expect(vm.aiPanelOpen).toBe(false); // logged out: the gate is closed
    expect(aiPromptRequest.value).toBe(null); // dropped, not left pending
    (store as any).isLoggedIn = true;
    (store as any).girderUser = { _id: "u1" };
    await nextTick();
    aiPromptRequest.value = "count cells";
    await nextTick();
    expect(vm.aiPanelOpen).toBe(true);
    aiPromptRequest.value = null;
    wrapper.unmount();
  });

  it("shows a compact search pill that opens the command palette", async () => {
    // Render v-btn slots (shallowMount drops them) so the label and hint show.
    (store as any).dataset = { id: "ds1", name: "Dataset" };
    const wrapper = mountComponent(
      { name: "datasetview" },
      {
        ...renderAppBarStubs,
        VBtn: { template: "<button><slot /></button>" },
      },
    );
    const pill = wrapper.get('[data-tour="command-palette-button"]');
    expect(pill.attributes("aria-label")).toBe("Search commands");
    expect(pill.get("kbd").text()).toBe(
      (wrapper.vm as any).commandPaletteHotkey,
    );
    expect((wrapper.vm as any).commandPaletteOpen).toBe(false);
    await pill.trigger("click");
    expect((wrapper.vm as any).commandPaletteOpen).toBe(true);
    wrapper.unmount();
  });

  // -- Computed: hasUncomputedProperties --
  it("hasUncomputedProperties returns false when no uncomputed entries", () => {
    (propertyStore as any).uncomputedCountByProperty = {};
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.hasUncomputedProperties).toBe(false);
  });

  it("hasUncomputedProperties returns true when there are uncomputed entries", () => {
    (propertyStore as any).uncomputedCountByProperty = {
      prop1: 2,
    };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.hasUncomputedProperties).toBe(true);
  });

  it("hasUncomputedProperties returns false when all counts are zero", () => {
    (propertyStore as any).uncomputedCountByProperty = {
      prop1: 0,
      prop2: 0,
    };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.hasUncomputedProperties).toBe(false);
  });

  // -- Computed: activeFilterCount / filtersTooltip --
  it("activeFilterCount mirrors the filters store", () => {
    (filterStore as any).activeFilterCount = 3;
    const wrapper = mountComponent({ name: "datasetview" });
    expect((wrapper.vm as any).activeFilterCount).toBe(3);
  });

  it("filtersTooltip omits the count when no filter is active", () => {
    const wrapper = mountComponent({ name: "datasetview" });
    expect((wrapper.vm as any).filtersTooltip).toBe(
      "Filter objects by tags, scope, properties, ID and region",
    );
  });

  it("filtersTooltip uses the singular form for one active filter", () => {
    (filterStore as any).activeFilterCount = 1;
    const wrapper = mountComponent({ name: "datasetview" });
    expect((wrapper.vm as any).filtersTooltip).toContain("(1 active filter)");
  });

  it("filtersTooltip uses the plural form for several active filters", () => {
    (filterStore as any).activeFilterCount = 4;
    const wrapper = mountComponent({ name: "datasetview" });
    expect((wrapper.vm as any).filtersTooltip).toContain("(4 active filters)");
  });

  it("filtersAriaLabel stays terse and gains the count when filters are on", () => {
    let wrapper = mountComponent({ name: "datasetview" });
    expect((wrapper.vm as any).filtersAriaLabel).toBe("Filters");
    (filterStore as any).activeFilterCount = 2;
    wrapper = mountComponent({ name: "datasetview" });
    expect((wrapper.vm as any).filtersAriaLabel).toBe("Filters (2 active)");
  });

  // -- Filter-count badge on the Filters chip --
  it("renders no badge on the Filters chip when no filter is active", () => {
    const wrapper = mountWithAppBar();
    expect(wrapper.find(".palette-chip-badge").exists()).toBe(false);
  });

  it("renders the active filter count on the Filters chip", () => {
    (filterStore as any).activeFilterCount = 3;
    const wrapper = mountWithAppBar();
    const badge = wrapper.find(".palette-chip-badge");
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe("3");
    // The badge belongs to the Filters chip, not a neighboring one, and the
    // count is mirrored into the label so it is not hidden from assistive
    // tech (aria-label overrides the chip's rendered content).
    expect(badge.element.closest("button")?.getAttribute("aria-label")).toBe(
      "Filters (3 active)",
    );
  });

  it("caps the badge at 9+ so it stays small", () => {
    (filterStore as any).activeFilterCount = 12;
    const wrapper = mountWithAppBar();
    expect(wrapper.find(".palette-chip-badge").text()).toBe("9+");
  });

  // -- Gate-count badge on the Analysis chip --
  //
  // Gates narrow the object set from a different panel, so the Filters badge
  // cannot speak for them: it counts only rows its own panel can show. Without
  // a badge here, a saved gate silently hid objects with nothing on screen to
  // say so — the palette can be closed and the gate still applies.
  it("renders no badge on the Analysis chip when no gate is active", () => {
    const wrapper = mountWithAppBar();
    expect(wrapper.find(".palette-chip-badge").exists()).toBe(false);
  });

  it("renders the active gate count on the Analysis chip", () => {
    (filterStore as any).activeAnalysisGateCount = 2;
    const wrapper = mountWithAppBar();
    const badge = wrapper.find(".palette-chip-badge");
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe("2");
    expect(badge.element.closest("button")?.getAttribute("aria-label")).toBe(
      "Analysis (2 gates active)",
    );
  });

  it("keeps the two badges independent", () => {
    (filterStore as any).activeFilterCount = 3;
    (filterStore as any).activeAnalysisGateCount = 1;
    const wrapper = mountWithAppBar();
    const badges = wrapper.findAll(".palette-chip-badge");
    expect(badges.map((b) => b.text())).toEqual(["3", "1"]);
    expect(
      badges.map((b) =>
        b.element.closest("button")?.getAttribute("aria-label"),
      ),
    ).toEqual(["Filters (3 active)", "Analysis (1 gate active)"]);
  });

  it("caps the gate badge at 9+ like the filters one", () => {
    (filterStore as any).activeAnalysisGateCount = 11;
    const wrapper = mountWithAppBar();
    expect(wrapper.find(".palette-chip-badge").text()).toBe("9+");
  });

  it("analysisTooltip names the gate count, singular and plural", () => {
    let wrapper = mountComponent({ name: "datasetview" });
    expect((wrapper.vm as any).analysisTooltip).not.toContain("active");
    (filterStore as any).activeAnalysisGateCount = 1;
    wrapper = mountComponent({ name: "datasetview" });
    expect((wrapper.vm as any).analysisTooltip).toContain("(1 gate active)");
    (filterStore as any).activeAnalysisGateCount = 3;
    wrapper = mountComponent({ name: "datasetview" });
    expect((wrapper.vm as any).analysisTooltip).toContain("(3 gates active)");
  });

  // -- Palette-open requests from components with no palette registry --
  //
  // The render-coverage HUD lives inside ImageViewer, far below the route
  // component, so it asks for a panel through the store rather than by event.
  it("opens the palettes a store request asks for, then clears the request", async () => {
    const wrapper = mountComponent({ name: "datasetview" });
    const vm = wrapper.vm as any;
    (store as any).paletteOpenRequests = ["analysisPanel", "filtersPanel"];
    await nextTick();
    // Both, not one: Filters is a companion that hosts alongside Analysis, so
    // a gate and a tag filter can be shown together.
    expect(vm.analysisPanel).toBe(true);
    expect(vm.filtersPanel).toBe(true);
    // Cleared, so asking for the same palette again is still seen as a change.
    expect(store.setPaletteOpenRequests).toHaveBeenCalledWith([]);
  });

  it("ignores an empty palette request", async () => {
    const wrapper = mountComponent({ name: "datasetview" });
    (store as any).paletteOpenRequests = [];
    await nextTick();
    expect((wrapper.vm as any).filtersPanel).toBe(false);
    expect(store.setPaletteOpenRequests).not.toHaveBeenCalled();
  });

  // -- Computed: filteredToursByCategory --
  it("filteredToursByCategory groups tours by category", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.availableTours = {
      tour1: { name: "Tour One", entryPoint: "root", category: "Basics" },
      tour2: {
        name: "Tour Two",
        entryPoint: "root",
        category: "Advanced",
      },
      tour3: { name: "Tour Three", entryPoint: "root", category: "Basics" },
    };
    const result = vm.filteredToursByCategory;
    expect(Object.keys(result)).toContain("Basics");
    expect(Object.keys(result)).toContain("Advanced");
    expect(Object.keys(result.Basics)).toHaveLength(2);
  });

  it("filteredToursByCategory filters by search text", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.availableTours = {
      tour1: { name: "Upload Data", entryPoint: "root", category: "Basics" },
      tour2: {
        name: "View Annotations",
        entryPoint: "root",
        category: "Basics",
      },
    };
    vm.tourSearch = "Upload";
    const result = vm.filteredToursByCategory;
    expect(Object.keys(result.Basics)).toHaveLength(1);
    expect(result.Basics.tour1).toBeDefined();
  });

  it("filteredToursByCategory hides dataset-only tours on non-dataset routes", () => {
    const wrapper = mountComponent({ name: "root" });
    const vm = wrapper.vm as any;
    vm.availableTours = {
      tour1: { name: "Home Tour", entryPoint: "root", category: "Basics" },
      tour2: {
        name: "Dataset Tour",
        entryPoint: "datasetview",
        category: "Basics",
      },
    };
    const result = vm.filteredToursByCategory;
    expect(Object.keys(result.Basics)).toHaveLength(1);
    expect(result.Basics.tour1).toBeDefined();
    expect(result.Basics.tour2).toBeUndefined();
  });

  // -- Method: handleTourStart --
  it("handleTourStart navigates when tour entryPoint differs from current route", () => {
    const wrapper = mountComponent({ name: "root" });
    const vm = wrapper.vm as any;
    vm.availableTours = {
      myTour: {
        name: "My Tour",
        entryPoint: "datasetview",
        category: "General",
      },
    };
    vm.handleTourStart("myTour");
    expect(mockRouter.push).toHaveBeenCalledWith({ name: "datasetview" });
  });

  it("handleTourStart does not navigate when already on the correct route", () => {
    const wrapper = mountComponent({ name: "datasetview" });
    const vm = wrapper.vm as any;
    vm.availableTours = {
      myTour: {
        name: "My Tour",
        entryPoint: "datasetview",
        category: "General",
      },
    };
    vm.handleTourStart("myTour");
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  // -- Method: fetchConfig --
  it("fetchConfig calls axios.get and sets tool templates", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.fetchConfig();
    await flushPromises();
    expect(axios.get).toHaveBeenCalledWith("config/templates.json");
    expect(store.setToolTemplateList).toHaveBeenCalledWith([
      { name: "Tool1", type: "create" },
    ]);
  });

  // -- Method: goHome --
  it("goHome pushes to root route", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.goHome();
    expect(mockRouter.push).toHaveBeenCalledWith({ name: "root" });
  });

  // -- Method: goToNewDataset --
  it("goToNewDataset navigates to newdataset with private folder", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.goToNewDataset();
    expect(store.api.getUserPrivateFolder).toHaveBeenCalled();
    expect(store.initializeUploadWorkflow).toHaveBeenCalled();
    expect(mockRouter.push).toHaveBeenCalledWith({ name: "newdataset" });
    expect(vm.isUploadLoading).toBe(false);
  });

  it("goToNewDataset handles error and still navigates", async () => {
    (store.api.getUserPrivateFolder as any).mockRejectedValue(
      new Error("network error"),
    );
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.goToNewDataset();
    expect(logError).toHaveBeenCalled();
    expect(store.initializeUploadWorkflow).toHaveBeenCalled();
    expect(mockRouter.push).toHaveBeenCalledWith({ name: "newdataset" });
    expect(vm.isUploadLoading).toBe(false);
  });

  it("goToNewDataset returns early when already loading", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.isUploadLoading = true;
    await vm.goToNewDataset();
    expect(store.api.getUserPrivateFolder).not.toHaveBeenCalled();
  });

  // -- Watcher: annotationPanel --
  it("watcher on annotationPanel calls setIsAnnotationPanelOpen", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.annotationPanel = true;
    await nextTick();
    expect(store.setIsAnnotationPanelOpen).toHaveBeenCalledWith(true);
  });

  it("a refused Object Browser request in embed mode does not leave the store open", async () => {
    // e.g. the render-coverage HUD (shown in embeds) asks for the Connections
    // tab. The embed refuses the palette; the store must agree, or the next
    // request after leaving embed is no change and never opens it.
    (store as any).isAnnotationPanelOpen = false;
    (store as any).setIsAnnotationPanelOpen = vi.fn((value: boolean) => {
      (store as any).isAnnotationPanelOpen = value;
    });
    const providedRoute = routeProvider();
    const route = providedRoute[routeLocationKey as symbol];
    Object.assign(route, { name: "datasetview", query: { embed: "1" } });
    const wrapper = mountComponent({}, {}, providedRoute);
    const vm = wrapper.vm as any;
    await nextTick();

    (store as any).isAnnotationPanelOpen = true;
    await nextTick();
    expect(vm.annotationPanel).toBe(false);
    expect((store as any).isAnnotationPanelOpen).toBe(false);

    Object.assign(route, { query: {} });
    await nextTick();
    (store as any).isAnnotationPanelOpen = true;
    await nextTick();
    expect(vm.annotationPanel).toBe(true);
    wrapper.unmount();
    (store as any).isAnnotationPanelOpen = false;
  });
});

describe("App genes dialog", () => {
  it("hosts the one genes dialog, bound to the shared open flag", async () => {
    // Every "Add genes" button opens this instance, so a running copy or
    // score job keeps polling after the dialog or tab that opened it closes.
    genesDialogOpen.value = false;
    // Render <v-app>'s children (shallowMount's stub would drop them).
    const wrapper = mountComponent(
      {},
      {
        VApp: { template: "<div><slot /></div>" },
      },
    );
    const dialogs = wrapper.findAllComponents(MaterializeGenesDialog);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].props("showActivator")).toBe(false);
    expect(dialogs[0].props("open")).toBe(false);
    genesDialogOpen.value = true;
    await nextTick();
    expect(dialogs[0].props("open")).toBe(true);
    genesDialogOpen.value = false;
  });
});
