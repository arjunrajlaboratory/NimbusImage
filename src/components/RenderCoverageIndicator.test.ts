/**
 * The HUD is where users look when they suspect missing data, so what it says
 * about active filters/gates — and what clicking that says-so does — is pinned
 * here. The counts it prints are computed AFTER filters and gates; a restored
 * lasso gate once made it read "Showing 826 of 826 in view" in a viewport that
 * visibly held thousands, with the only cue a badge on a far-away palette icon.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { IActiveConstraint } from "@/utils/activeConstraints";

const mocks = vi.hoisted(() => ({
  requestPaletteOpen: vi.fn(),
  constraints: [] as IActiveConstraint[],
  stubs: new Map<string, unknown>(),
  viewportRenderedCount: 826,
  viewportAnnotationCount: 826,
  stubOnlyMode: true,
  // The component only reads .length, so a real array is not needed.
  filteredAnnotationCount: 289469,
}));

vi.mock("@/store", () => ({
  default: {
    requestPaletteOpen: mocks.requestPaletteOpen,
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    get stubOnlyMode() {
      return mocks.stubOnlyMode;
    },
    get annotationStubs() {
      return mocks.stubs;
    },
    get viewportRenderedCount() {
      return mocks.viewportRenderedCount;
    },
    get viewportAnnotationCount() {
      return mocks.viewportAnnotationCount;
    },
    visibilityConfig: { stubThreshold: 50000 },
  },
}));

vi.mock("@/store/filters", () => ({
  default: {
    get activeConstraints() {
      return mocks.constraints;
    },
    get filteredAnnotations() {
      return { length: mocks.filteredAnnotationCount };
    },
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    getFullNameFromPath: (path: string[]) =>
      ({ "p.Area": "Area", "p.PECAM1": "PECAM1" })[path.join(".")] ?? null,
  },
}));

import RenderCoverageIndicator from "./RenderCoverageIndicator.vue";

const GATE_CONSTRAINT: IActiveConstraint = {
  source: "analysis",
  kind: "gate",
  xAxis: { type: "property", path: ["p", "Area"] },
  yAxis: { type: "property", path: ["p", "PECAM1"] },
};

const TAG_CONSTRAINT: IActiveConstraint = { source: "filters", kind: "tag" };

function mountIndicator() {
  return shallowMount(RenderCoverageIndicator, {
    global: {
      stubs: {
        VMenu: { template: "<div><slot name='activator' :props='{}' /></div>" },
        VBtn: true,
        VCard: true,
        VCardTitle: true,
        VCardText: true,
        VisibilitySettings: true,
      },
    },
  });
}

describe("RenderCoverageIndicator", () => {
  beforeEach(() => {
    // Cleared, never reassigned: the module factory captured this very spy,
    // so a fresh vi.fn() here would leave the component calling the old one.
    mocks.requestPaletteOpen.mockClear();
    mocks.constraints = [];
    mocks.stubOnlyMode = true;
    mocks.viewportRenderedCount = 826;
    mocks.viewportAnnotationCount = 826;
  });

  it("says nothing about constraints when none is active", () => {
    const wrapper = mountIndicator();
    expect(wrapper.text()).toContain("Showing 826 of 826 in view");
    expect(wrapper.find(".render-coverage__constraints").exists()).toBe(false);
  });

  it("appends the constraint count next to the counts it explains", () => {
    mocks.constraints = [GATE_CONSTRAINT];
    const wrapper = mountIndicator();
    const suffix = wrapper.find(".render-coverage__constraints");
    expect(suffix.text()).toBe("(1 filter applied)");
    // On the same line as the number that reads like data loss, not on a
    // palette icon at the edge of the window — and reading as one sentence,
    // which template whitespace handling is free to break.
    expect(wrapper.find(".render-coverage__label").text()).toBe(
      "Showing 826 of 826 in view (1 filter applied)",
    );
  });

  it("shows how many objects pass next to the total when narrowed", () => {
    mocks.constraints = [GATE_CONSTRAINT];
    const suffix = mountIndicator().find(".render-coverage__suffix");
    // One line: the total AND the narrowed population, so the user can read
    // both without opening a panel. (The mock's stub map is empty → 0 total.)
    expect(suffix.text()).toBe(
      `0 total annotations (${(289469).toLocaleString()} passing filters)`,
    );
  });

  it("keeps the total line bare when nothing is narrowing the set", () => {
    const suffix = mountIndicator().find(".render-coverage__suffix");
    expect(suffix.text()).toBe("0 total annotations");
  });

  it("names the active constraints in its tooltip", () => {
    mocks.constraints = [GATE_CONSTRAINT, TAG_CONSTRAINT];
    const suffix = mountIndicator().find(".render-coverage__constraints");
    expect(suffix.text()).toBe("(2 filters applied)");
    expect(suffix.attributes("title")).toBe(
      "Objects are narrowed by 1 lasso gate on Area × PECAM1; 1 tag filter. " +
        "Click to open Analysis and Filters.",
    );
    // aria-label carries the same sentence: the suffix's own text is only a
    // count, which tells a screen-reader user nothing about what to clear.
    expect(suffix.attributes("aria-label")).toBe(suffix.attributes("title"));
  });

  it("opens the panel that owns the constraint when clicked", async () => {
    mocks.constraints = [TAG_CONSTRAINT];
    await mountIndicator()
      .find(".render-coverage__constraints")
      .trigger("click");
    expect(mocks.requestPaletteOpen).toHaveBeenCalledWith(["filtersPanel"]);
  });

  it("opens Analysis before Filters so the companion stacks beside it", async () => {
    mocks.constraints = [GATE_CONSTRAINT, TAG_CONSTRAINT];
    await mountIndicator()
      .find(".render-coverage__constraints")
      .trigger("click");
    expect(mocks.requestPaletteOpen).toHaveBeenCalledWith([
      "analysisPanel",
      "filtersPanel",
    ]);
  });

  it("shows the constraint suffix outside stub mode too", () => {
    // Client mode with the render budget clipping the view: the counts are
    // filtered here as well, so the cue must not be gated on stub mode.
    mocks.stubOnlyMode = false;
    mocks.viewportRenderedCount = 100;
    mocks.viewportAnnotationCount = 45000;
    mocks.constraints = [TAG_CONSTRAINT];
    const wrapper = mountIndicator();
    expect(wrapper.find(".render-coverage").exists()).toBe(true);
    expect(wrapper.find(".render-coverage__constraints").text()).toBe(
      "(1 filter applied)",
    );
  });
});
