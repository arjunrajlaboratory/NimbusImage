import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { flushPromises, mount, VueWrapper } from "@vue/test-utils";

vi.mock("vue-router", () => ({
  useRoute: () => ({ name: "datasetview" }),
}));

vi.mock("@/store", () => ({
  default: {
    isLoggedIn: true,
    dataset: { id: "ds", xy: [0], z: Array.from({ length: 10 }), time: [0] },
    layers: [],
  },
}));

const goToLocation = vi.hoisted(() => vi.fn());
vi.mock("@/actions/operations", () => ({
  goToLocation,
  setVisibleLayers: vi.fn(),
  selectTool: vi.fn(),
}));

vi.mock("@/store/properties", () => ({
  default: {
    fetchWorkerImageList: vi.fn().mockResolvedValue(undefined),
    computedPropertyPaths: [["p1", "Area"]],
    getPropertyById: () => null,
  },
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
  propertyListCommands: () => () => [],
  propertyFilterCommands: () => () => [],
}));

import CommandPalette from "./CommandPalette.vue";
import propertyStore from "@/store/properties";
import { registerCommandProvider } from "@/commands/registry";
import { recentCommandIds } from "@/commands/recent";
import { ICommand } from "@/commands/types";
import { ref } from "vue";
import { logError } from "@/utils/log";
import { aiPromptRequest } from "@/commands/requests";

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

function mountPalette(open = true, attachTo?: HTMLElement) {
  wrapper = mount(CommandPalette, {
    attachTo,
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

  it("ignores Enter that confirms an IME composition", async () => {
    mountPalette();
    await type("dapi");
    await press("Enter", { isComposing: true });
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    await leave();
    expect(runs).toEqual([]);
  });

  it("keeps focus in the search field on Tab", async () => {
    mountPalette();
    const input = wrapper.find("input");
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      cancelable: true,
      bubbles: true,
    });
    input.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(
      wrapper
        .findAll("[data-command-row]")
        .every((row) => row.attributes("tabindex") === "-1"),
    ).toBe(true);
  });

  it("keeps focus in the search field when the list is pressed", async () => {
    mountPalette();
    for (const target of [
      wrapper.find(".command-palette-list"),
      wrapper.find("[data-command-row]"),
    ]) {
      const event = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      });
      target.element.dispatchEvent(event);
      // A prevented mousedown moves no focus; a row's click still fires.
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it("stops its own toggle key, so the app-wide binding can't reopen it", async () => {
    // Attached, so an unstopped event really would bubble to the document.
    mountPalette(true, document.body);
    const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const reachedDocument = vi.fn();
    document.addEventListener("keydown", reachedDocument);
    const input = wrapper.find("input").element;
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        bubbles: true,
        cancelable: true,
        ...(mac ? { metaKey: true } : { ctrlKey: true }),
      }),
    );
    document.removeEventListener("keydown", reachedDocument);
    expect(reachedDocument).not.toHaveBeenCalled();
  });

  it("moves the highlight on real pointer movement only", async () => {
    mountPalette();
    await type("open");
    await press("ArrowDown");
    const chosen = rowTitles()[wrapper.vm.activeIndex];
    const rows = wrapper.findAll("[data-command-row]");
    // First move over row 0 takes the highlight...
    await rows[0].trigger("mousemove", { clientX: 10, clientY: 10 });
    expect(wrapper.vm.activeIndex).toBe(0);
    await press("ArrowDown");
    expect(rowTitles()[wrapper.vm.activeIndex]).toBe(chosen);
    // ...but a mousemove at the same spot (the list scrolled under a resting
    // pointer) does not take it back.
    await rows[0].trigger("mousemove", { clientX: 10, clientY: 10 });
    expect(rowTitles()[wrapper.vm.activeIndex]).toBe(chosen);
  });

  it("puts a typed parameterized command first and runs it after the dialog leaves", async () => {
    goToLocation.mockClear();
    unregister();
    unregister = registerCommandProvider(() => [
      command("panel.zoom", "Open Z stack zoom", "Panels"),
    ]);
    mountPalette();
    await type("z 3");
    expect(rowTitles()[0]).toContain("Go to Z 3");
    await press("Enter");
    expect(goToLocation).not.toHaveBeenCalled();
    await leave();
    // The typed 3 is the 3rd slice: index 2.
    expect(goToLocation).toHaveBeenCalledWith({ z: 2 });
  });

  it("lists a typed command and ranked matches of its group under one header", async () => {
    unregister();
    unregister = registerCommandProvider(() => [
      command("bookmark.z3", "Bookmark z 3", "Navigate"),
    ]);
    mountPalette();
    await type("z 3");
    const headers = wrapper
      .findAll(".v-list-subheader")
      .map((header) => header.text());
    expect(headers.filter((label) => label === "Navigate")).toHaveLength(1);
    expect(rowTitles()[0]).toContain("Go to Z 3");
    expect(rowTitles()[1]).toContain("Bookmark z 3");
  });

  it("rotates dataset-based example queries in the placeholder while open, and stops when closed", async () => {
    vi.useFakeTimers();
    // Objects are hidden, so only "Show objects" exists: the fixed
    // "hide objects" example must be dropped, "show objects" kept.
    const unregisterState = registerCommandProvider(() => [
      command("objects.toggleDraw", "Show objects"),
      {
        ...command("property.list.p1.Area", "Show in object list: Area"),
        keywords: ["column", "add"],
      },
      command("panel.toggle.annotationPanel", "Open Object Browser"),
      {
        ...command("analysis.measure", "Measure objects…"),
        aliases: ["measure"],
      },
    ]);
    try {
      mountPalette();
      const placeholder = () =>
        wrapper.find("input").attributes("placeholder") ?? "";
      const first = placeholder();
      expect(first).toMatch(/^Try: /);
      vi.advanceTimersByTime(4000);
      await nextTick();
      expect(placeholder()).not.toBe(first);
      // Every example comes from this dataset: 10 slices, an Area property.
      const all = new Set<string>();
      for (let i = 0; i < 6; i++) {
        placeholder()
          .replace("Try: ", "")
          .split(" · ")
          .forEach((example) => all.add(example));
        vi.advanceTimersByTime(4000);
        await nextTick();
      }
      expect(all).toContain("z 3");
      expect(all).toContain("add column Area");
      expect(all).toContain("show objects");
      expect(all).not.toContain("hide objects");
      // Nothing here answers the minimap examples.
      expect(all).not.toContain("hide minimap");
      await wrapper.setProps({ modelValue: false });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      unregisterState();
      vi.useRealTimers();
    }
  });

  it("does not record a generated command as recent", async () => {
    mountPalette();
    await type("z 3");
    await press("Enter");
    await leave();
    expect(goToLocation).toHaveBeenCalled();
    expect(recentCommandIds.value).toEqual([]);
    await wrapper.setProps({ modelValue: true });
    await type("open filters");
    await press("Enter");
    await leave();
    expect(recentCommandIds.value).toEqual(["panel.filters"]);
  });

  it("keeps highlighting a generated command by id", async () => {
    mountPalette();
    await type("z 3");
    expect(wrapper.vm.activeCommandId).toBe(null);
    expect(wrapper.vm.commandRows[wrapper.vm.activeIndex].command.id).toBe(
      "navigate.z:2",
    );
  });

  it("asks Nimbus AI from the field's button or mod+Enter, even with no match", async () => {
    const unregisterAi = registerCommandProvider(() => [
      command("ai.togglePanel", "Open Nimbus AI panel"),
    ]);
    try {
      mountPalette();
      const button = () => wrapper.find("[data-ask-ai]");
      // Not a list row: the list holds only matching commands.
      await type("open");
      expect(rowTitles().some((title) => title.includes("Ask Nimbus AI"))).toBe(
        false,
      );
      await type("");
      expect(button().attributes("disabled")).toBeDefined();
      await type("  count the cells  ");
      expect(rowTitles()).toEqual([]);
      expect(wrapper.text()).toContain("to ask Nimbus AI");
      await button().trigger("click");
      await leave();
      expect(aiPromptRequest.value).toBe("count the cells");
      expect(recentCommandIds.value).toEqual([]);

      aiPromptRequest.value = null;
      await wrapper.setProps({ modelValue: true });
      // "open" matches commands; mod+Enter still goes to the AI, not to the
      // highlighted row.
      await type("open");
      const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
      await press("Enter", mac ? { metaKey: true } : { ctrlKey: true });
      await leave();
      expect(aiPromptRequest.value).toBe("open");
      expect(runs).toEqual([]);
    } finally {
      aiPromptRequest.value = null;
      unregisterAi();
    }
  });

  it("shows no Ask Nimbus AI button where the AI panel can't open", async () => {
    mountPalette();
    await type("open");
    expect(wrapper.find("[data-ask-ai]").exists()).toBe(false);
    const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    await press("Enter", mac ? { metaKey: true } : { ctrlKey: true });
    await leave();
    expect(aiPromptRequest.value).toBe(null);
    expect(wrapper.text()).not.toContain("to ask Nimbus AI");
  });
});
