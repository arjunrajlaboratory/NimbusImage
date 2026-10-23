import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick } from "vue";

vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  return { default: reactive({ dataset: { id: "ds1" } }) };
});

vi.mock("@/store/properties", () => ({
  isVirtualPropertyPath: (path: string[]) => path[0] === "spatial",
  default: { virtualPropertyPaths: [] as string[][] },
}));

vi.mock("@/store/spatial", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      hasTable: false,
      info: null as any,
      ensureInfo: vi.fn(),
    }),
  };
});

import store from "@/store";
import propertyStore from "@/store/properties";
import spatialStore from "@/store/spatial";
import GeneExpressionCard from "./GeneExpressionCard.vue";
import MaterializeGenesDialog from "@/components/AnnotationBrowser/MaterializeGenesDialog.vue";
import { genesDialogOpen } from "@/utils/genesDialog";

// Mounted cards watch the shared store mock; a leftover one would answer
// the next test's dataset change too.
enableAutoUnmount(afterEach);

function mountCard(props: { visible?: boolean } = {}) {
  return mount(GeneExpressionCard, { props });
}

describe("GeneExpressionCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (spatialStore as any).hasTable = false;
    (spatialStore as any).info = null;
    (propertyStore as any).virtualPropertyPaths = [];
    (store as any).dataset = { id: "ds1" };
    genesDialogOpen.value = false;
  });

  it("renders nothing without a spatial table", () => {
    const wrapper = mountCard();
    expect(wrapper.text()).toBe("");
  });

  it("explains where gene counts come from and offers Add genes", async () => {
    (spatialStore as any).hasTable = true;
    (spatialStore as any).info = { nObs: 5044, nVar: 274 };
    const wrapper = mountCard();
    await nextTick();
    expect(wrapper.text()).toContain("Gene expression");
    expect(wrapper.text()).toContain("5,044 cells × 274 genes");
    expect(wrapper.text()).toContain("not listed until you add them");
    expect(wrapper.text()).toContain("Add genes");
  });

  it("lists the genes already added, capped with a count of the rest", async () => {
    (spatialStore as any).hasTable = true;
    (spatialStore as any).info = { nObs: 1, nVar: 20 };
    (propertyStore as any).virtualPropertyPaths = [
      ...Array.from({ length: 10 }, (_, i) => ["spatial", `G${i}`]),
      ["other", "X"],
    ];
    const wrapper = mountCard();
    await nextTick();
    const chips = wrapper.findAll(".v-chip").map((chip) => chip.text());
    expect(chips).toEqual(["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7"]);
    expect(wrapper.text()).toContain("+2 more");
    expect(wrapper.text()).not.toContain("X");
  });

  it("asks for the table only while visible, and again per dataset", async () => {
    const wrapper = mountCard({ visible: false });
    await nextTick();
    expect(spatialStore.ensureInfo).not.toHaveBeenCalled();
    await wrapper.setProps({ visible: true });
    expect(spatialStore.ensureInfo).toHaveBeenCalledTimes(1);
    (store as any).dataset = { id: "ds2" };
    await nextTick();
    expect(spatialStore.ensureInfo).toHaveBeenCalledTimes(2);
  });

  it("opens the app-level genes dialog instead of hosting its own", async () => {
    // A dialog hosted here would unmount with "Measure objects" and stop a
    // running copy/score job's polling, so the card must only request it.
    (spatialStore as any).hasTable = true;
    (spatialStore as any).info = { nObs: 1, nVar: 2 };
    const wrapper = mountCard();
    await nextTick();
    expect(wrapper.findComponent(MaterializeGenesDialog).exists()).toBe(false);
    await wrapper.find("button").trigger("click");
    expect(genesDialogOpen.value).toBe(true);
  });

  it("treats an omitted visible prop as visible (the dialog's instance)", async () => {
    mountCard();
    await nextTick();
    expect(spatialStore.ensureInfo).toHaveBeenCalledTimes(1);
  });
});
