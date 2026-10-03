import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { flushPromises, mount, VueWrapper } from "@vue/test-utils";

vi.mock("vue-router", () => ({
  useRoute: () => ({ name: "datasetview" }),
}));

vi.mock("@/store", () => ({
  default: { isLoggedIn: true, dataset: { id: "ds" } },
}));

vi.mock("@/store/properties", () => ({
  default: { fetchWorkerImageList: vi.fn().mockResolvedValue(undefined) },
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
import { ref } from "vue";
import { logError } from "@/utils/log";

// Stands in for v-dialog: renders while open. after-leave — which Vuetify's
// real dialog emits only once its leave transition has finished — is emitted
// by the test (`leave()`), so a test can tell "ran after the dialog left" from
// "ran a tick later".
const VDialogStub = defineComponent({
  props: { modelValue: Boolean },
  emits: ["update:modelValue", "afterLeave", "afterEnter"],
  setup(props, { slots }) {
    return () => (props.modelValue ? h("div", slots.default?.()) : null);
  },
});

async function leave() {
  wrapper.findComponent(VDialogStub).vm.$emit("afterLeave");
  await flushPromises();
}

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

async function press(key: string, modifiers: Record<string, boolean> = {}) {
  await wrapper.find("input").trigger("keydown", { key, ...modifiers });
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
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([false]);
    await leave();
    expect(runs).toEqual(["panel.filters"]);
    expect(recentCommandIds.value).toEqual(["panel.filters"]);
  });

  it("does not run the command until the dialog has left", async () => {
    mountPalette();
    await type("dapi");
    wrapper.vm.choose(wrapper.vm.commandRows[0].command);
    await flushPromises();
    expect(wrapper.props("modelValue")).toBe(false);
    // Closed, but the leave transition hasn't finished: nothing runs yet.
    expect(runs).toEqual([]);
    await leave();
    expect(runs).toEqual(["layer.dapi"]);
  });

  it("closing without choosing runs nothing", async () => {
    mountPalette();
    await type("dapi");
    await wrapper.setProps({ modelValue: false });
    await leave();
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

  it("keeps the highlighted command when the list re-derives under it", async () => {
    const extra = ref<ICommand[]>([]);
    const unregisterExtra = registerCommandProvider(() => extra.value);
    mountPalette();
    await type("open");
    await press("ArrowDown");
    expect(rowTitles()[wrapper.vm.activeIndex]).toBe("Open Filters");
    // A late arrival (the worker list landing) inserts a better match above.
    extra.value = [command("panel.aaa", "Open A", "Panels")];
    await nextTick();
    expect(rowTitles()[0]).toBe("Open A");
    expect(rowTitles()[wrapper.vm.activeIndex]).toBe("Open Filters");
    await press("Enter");
    await leave();
    expect(runs).toEqual(["panel.filters"]);
    unregisterExtra();
  });

  it("falls back to the first row when the highlighted command disappears", async () => {
    const gone = ref(false);
    const unregisterExtra = registerCommandProvider(() =>
      gone.value ? [] : [command("panel.zzz", "Open Zebra panel", "Panels")],
    );
    mountPalette();
    await type("open");
    // Longest title, so it sorts last; ArrowUp wraps to it.
    await press("ArrowUp");
    expect(rowTitles()[wrapper.vm.activeIndex]).toBe("Open Zebra panel");
    gone.value = true;
    await nextTick();
    expect(wrapper.vm.activeIndex).toBe(0);
    await press("Enter");
    await leave();
    expect(runs).toEqual(["panel.layers"]);
    unregisterExtra();
  });

  it("closes on its own toggle key typed in the search field", async () => {
    mountPalette();
    await type("dapi");
    const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    await press("k", mac ? { metaKey: true } : { ctrlKey: true });
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([false]);
    await leave();
    expect(runs).toEqual([]);
  });

  it("still runs the chosen command if reopened before it finished closing", async () => {
    mountPalette();
    await type("dapi");
    wrapper.vm.choose(wrapper.vm.commandRows[0].command);
    await flushPromises();
    // Reopened mid-transition: Vuetify cancels the leave, so after-leave
    // never comes.
    await wrapper.setProps({ modelValue: true });
    await flushPromises();
    expect(runs).toEqual(["layer.dapi"]);
  });

  it("logs, rather than leaks, a failed worker-list refresh", async () => {
    vi.mocked(propertyStore.fetchWorkerImageList).mockRejectedValueOnce(
      new Error("offline"),
    );
    mountPalette(false);
    await wrapper.setProps({ modelValue: true });
    await flushPromises();
    expect(logError).toHaveBeenCalled();
  });

  it("re-scores on each keystroke without re-running the providers", async () => {
    const provider = vi.fn(() => [command("cost.probe", "Cost probe")]);
    const unregisterProbe = registerCommandProvider(provider);
    mountPalette();
    await nextTick();
    const callsAfterOpen = provider.mock.calls.length;
    expect(callsAfterOpen).toBeGreaterThan(0);
    for (const query of ["c", "co", "cos", "cost", "cost p"]) {
      await type(query);
    }
    expect(rowTitles()).toEqual(["Cost probe"]);
    expect(provider.mock.calls.length).toBe(callsAfterOpen);
    unregisterProbe();
  });
});
