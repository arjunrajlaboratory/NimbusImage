import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount, flushPromises } from "@vue/test-utils";

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
import App from "./App.vue";
import store from "@/store";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import axios from "axios";
import { logError } from "@/utils/log";

const mockRoute = {
  name: "root",
  params: {},
};

const mockRouter = {
  push: vi.fn(),
};

function mountComponent(
  routeOverrides: Record<string, any> = {},
  extraStubs: Record<string, any> = {},
) {
  return shallowMount(App, {
    global: {
      mocks: {
        $loadAllTours: vi.fn().mockResolvedValue({}),
        $startTour: vi.fn(),
      },
      provide: {
        ...routeProvider({ ...mockRoute, ...routeOverrides }),
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
}

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
    (propertyStore as any).uncomputedCountByProperty = {};
    (filterStore as any).activeFilterCount = 0;
    (filterStore as any).activeAnalysisGateCount = 0;
    (axios.get as any) = vi
      .fn()
      .mockResolvedValue({ data: [{ name: "Tool1", type: "create" }] });
    mockRouter.push = vi.fn();
  });

  // -- Computed: routeName --
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

  // -- Method: closeAllPalettes --
  it("closeAllPalettes closes every palette", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.togglePalette("annotationPanel");
    vm.togglePalette("filtersPanel");
    vm.closeAllPalettes();
    expect(vm.annotationPanel).toBe(false);
    expect(vm.filtersPanel).toBe(false);
    expect(vm.snapshotPanel).toBe(false);
    expect(vm.settingsPanel).toBe(false);
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
  it("appHotkeys binds to tab key", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.appHotkeys.bind).toBe("tab");
    expect(typeof vm.appHotkeys.handler).toBe("function");
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

  // -- Filter-count badge on the Filters button --
  it("renders no badge on the Filters button when no filter is active", () => {
    const wrapper = mountWithAppBar();
    expect(wrapper.find(".palette-ibtn-badge").exists()).toBe(false);
  });

  it("renders the active filter count on the Filters button", () => {
    (filterStore as any).activeFilterCount = 3;
    const wrapper = mountWithAppBar();
    const badge = wrapper.find(".palette-ibtn-badge");
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe("3");
    // The badge belongs to the Filters button, not a neighbouring palette one,
    // and the count is mirrored into the label so it is not hidden from
    // assistive tech (aria-label overrides the button's rendered content).
    expect(badge.element.closest("button")?.getAttribute("aria-label")).toBe(
      "Filters (3 active)",
    );
  });

  it("caps the badge at 9+ so it stays inside the icon button", () => {
    (filterStore as any).activeFilterCount = 12;
    const wrapper = mountWithAppBar();
    expect(wrapper.find(".palette-ibtn-badge").text()).toBe("9+");
  });

  // -- Gate-count badge on the Analysis button --
  //
  // Gates narrow the object set from a different panel, so the Filters badge
  // cannot speak for them: it counts only rows its own panel can show. Without
  // a badge here, a saved gate silently hid objects with nothing on screen to
  // say so — the palette can be closed and the gate still applies.
  it("renders no badge on the Analysis button when no gate is active", () => {
    const wrapper = mountWithAppBar();
    expect(wrapper.find(".palette-ibtn-badge").exists()).toBe(false);
  });

  it("renders the active gate count on the Analysis button", () => {
    (filterStore as any).activeAnalysisGateCount = 2;
    const wrapper = mountWithAppBar();
    const badge = wrapper.find(".palette-ibtn-badge");
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe("2");
    expect(badge.element.closest("button")?.getAttribute("aria-label")).toBe(
      "Analysis plots (2 gates active)",
    );
  });

  it("keeps the two badges independent", () => {
    (filterStore as any).activeFilterCount = 3;
    (filterStore as any).activeAnalysisGateCount = 1;
    const wrapper = mountWithAppBar();
    const badges = wrapper.findAll(".palette-ibtn-badge");
    expect(badges.map((b) => b.text())).toEqual(["3", "1"]);
    expect(
      badges.map((b) =>
        b.element.closest("button")?.getAttribute("aria-label"),
      ),
    ).toEqual(["Filters (3 active)", "Analysis plots (1 gate active)"]);
  });

  it("caps the gate badge at 9+ like the filters one", () => {
    (filterStore as any).activeAnalysisGateCount = 11;
    const wrapper = mountWithAppBar();
    expect(wrapper.find(".palette-ibtn-badge").text()).toBe("9+");
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

  // -- Watcher: routeName --
  it("closeAllPalettes clears open palettes (run when leaving datasetview)", () => {
    const wrapper = mountComponent({ name: "datasetview" });
    const vm = wrapper.vm as any;
    vm.togglePalette("annotationPanel");
    expect(vm.annotationPanel).toBe(true);
    // datasetChanged() calls closeAllPalettes when the route is not datasetview.
    vm.closeAllPalettes();
    expect(vm.annotationPanel).toBe(false);
  });
});
