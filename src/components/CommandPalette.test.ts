import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { mount, VueWrapper } from "@vue/test-utils";

vi.mock("vue-router", () => ({
  useRoute: () => ({ name: "datasetview" }),
}));

vi.mock("@/store", () => ({
  default: { isLoggedIn: true, dataset: { id: "ds" } },
}));

vi.mock("@/store/properties", () => ({
  default: { fetchWorkerImageList: vi.fn() },
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
}));

// The store-derived providers are covered by providers.test.ts; here the
// palette is driven by commands the test registers directly.
vi.mock("@/commands/providers", () => ({
  toolCommands: () => () => [],
  addToolCommands: () => () => [],
  layerCommands: () => () => [],
  snapshotCommands: () => () => [],
  propertyCommands: () => () => [],
}));

import CommandPalette from "./CommandPalette.vue";
import propertyStore from "@/store/properties";
import { registerCommandProvider } from "@/commands/registry";
import { recentCommandIds } from "@/commands/recent";
import { ICommand } from "@/commands/types";

// Stands in for v-dialog: renders while open and emits after-leave when it
// closes, which is when Vuetify's real dialog finishes its leave transition.
const VDialogStub = defineComponent({
  props: { modelValue: Boolean },
  emits: ["update:modelValue", "afterLeave", "afterEnter"],
  watch: {
    modelValue(open: boolean) {
      this.$emit(open ? "afterEnter" : "afterLeave");
    },
  },
  setup(props, { slots }) {
    return () => (props.modelValue ? h("div", slots.default?.()) : null);
  },
});

const runs: string[] = [];
function command(id: string, title: string, group: any = "Actions"): ICommand {
  return { id, title, group, run: () => void runs.push(id) };
}

let unregister: () => void;
let wrapper: VueWrapper<any>;

function mountPalette(open = true) {
  wrapper = mount(CommandPalette, {
    props: {
      modelValue: open,
      "onUpdate:modelValue": (value: boolean) =>
        wrapper.setProps({ modelValue: value }),
    },
    global: { stubs: { VDialog: VDialogStub } },
  });
  return wrapper;
}

async function type(query: string) {
  await wrapper.find("input").setValue(query);
}

async function press(key: string) {
  await wrapper.find("input").trigger("keydown", { key });
}

function rowTitles() {
  return wrapper.findAll("[data-command-row]").map((row) => row.text());
}

beforeEach(() => {
  runs.length = 0;
  recentCommandIds.value = [];
  unregister = registerCommandProvider(() => [
    command("panel.filters", "Open Filters", "Panels"),
    command("panel.layers", "Open Layers", "Panels"),
    command("layer.dapi", "Toggle layer: DAPI", "Layers"),
    { ...command("hidden", "Hidden thing"), enabled: () => false },
  ]);
});

afterEach(() => {
  wrapper?.unmount();
  unregister();
});

describe("CommandPalette", () => {
  it("filters as you type and hides disabled commands", async () => {
    mountPalette();
    await type("open");
    // Equal scores: the shorter title first.
    expect(rowTitles()).toEqual(["Open Layers", "Open Filters"]);
    await type("hidden");
    expect(rowTitles()).toEqual([]);
    expect(wrapper.text()).toContain("No matching commands");
  });

  it("arrow keys move the active row and Enter runs it after closing", async () => {
    mountPalette();
    await type("open");
    await press("ArrowDown");
    expect(wrapper.vm.activeIndex).toBe(1);
    await press("ArrowDown");
    // Wraps around.
    expect(wrapper.vm.activeIndex).toBe(0);
    await press("ArrowUp");
    expect(wrapper.vm.activeIndex).toBe(1);
    await press("Enter");
    await nextTick();
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([false]);
    expect(runs).toEqual(["panel.filters"]);
    expect(recentCommandIds.value).toEqual(["panel.filters"]);
  });

  it("does not run the command until the dialog has left", async () => {
    mountPalette();
    await type("dapi");
    // Close without letting the stub's after-leave fire.
    wrapper.vm.choose(wrapper.vm.commandRows[0].command);
    expect(runs).toEqual([]);
    await nextTick();
    await nextTick();
    expect(runs).toEqual(["layer.dapi"]);
  });

  it("closing without choosing runs nothing", async () => {
    mountPalette();
    await type("dapi");
    await wrapper.setProps({ modelValue: false });
    await nextTick();
    expect(runs).toEqual([]);
  });

  it("shows recent commands first on an empty query", async () => {
    recentCommandIds.value = ["layer.dapi"];
    mountPalette();
    await nextTick();
    const headers = wrapper.findAll(".v-list-subheader").map((h) => h.text());
    expect(headers[0]).toBe("Recent");
    expect(rowTitles()[0]).toBe("Toggle layer: DAPI");
    // ...and not again under its own group.
    expect(rowTitles().filter((t) => t === "Toggle layer: DAPI")).toHaveLength(
      1,
    );
  });

  it("resets the query and refreshes the worker list each time it opens", async () => {
    mountPalette(false);
    await wrapper.setProps({ modelValue: true });
    await type("dapi");
    await wrapper.setProps({ modelValue: false });
    await wrapper.setProps({ modelValue: true });
    expect(wrapper.vm.query).toBe("");
    expect(propertyStore.fetchWorkerImageList).toHaveBeenCalledTimes(2);
  });
});
