import { describe, it, expect, vi, afterEach } from "vitest";
import { defineComponent, h, watch } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  return { default: reactive({ isLoggedIn: true }) };
});
vi.mock("@/store/properties", () => ({
  default: { computedPropertyPaths: [] },
}));
vi.mock("@/store/filters", () => ({
  default: { filteredAnnotations: [{ id: "a1" }, { id: "a2" }] },
}));

// Each data dialog does its on-open work (CSV preview, dimension labels) in a
// NON-immediate watcher on its open state, like the real ones. The stub
// counts how often that watcher fires.
const openings: Record<string, number> = {};
const lastAnnotations: Record<string, unknown> = {};
function dialogStub(name: string) {
  return defineComponent({
    name,
    props: { open: Boolean, annotations: { type: Array, default: undefined } },
    emits: ["update:open"],
    setup(props) {
      watch(
        () => props.open,
        (isOpen) => {
          if (isOpen) {
            openings[name] = (openings[name] ?? 0) + 1;
          }
        },
      );
      watch(
        () => props.annotations,
        (value) => (lastAnnotations[name] = value),
        { immediate: true },
      );
      return () => h("div");
    },
  });
}

vi.mock("@/components/AnnotationBrowser/AnnotationImport.vue", () => ({
  default: dialogStub("AnnotationImport"),
}));
vi.mock("@/components/AnnotationBrowser/AnnotationExport.vue", () => ({
  default: dialogStub("AnnotationExport"),
}));
vi.mock("@/components/AnnotationBrowser/AnnotationCSVDialog.vue", () => ({
  default: dialogStub("AnnotationCsvDialog"),
}));
vi.mock("@/components/AnnotationBrowser/IndexConversionDialog.vue", () => ({
  default: dialogStub("IndexConversionDialog"),
}));

import DataIOMenu from "./DataIOMenu.vue";
import store from "@/store";
import { allCommands } from "@/commands/registry";

enableAutoUnmount(afterEach);

function run(commandId: string) {
  return allCommands.value.find((command) => command.id === commandId)!.run();
}

describe("DataIOMenu", () => {
  it("opens each dialog after mounting it, so its on-open watcher fires the first time", async () => {
    const wrapper = mount(DataIOMenu);
    for (const id of Object.keys(openings)) delete openings[id];
    expect(
      wrapper.findComponent({ name: "AnnotationCsvDialog" }).exists(),
    ).toBe(false);
    await run("data.export.csv");
    await flushPromises();
    expect(openings.AnnotationCsvDialog).toBe(1);
    await run("data.export.indexConversions");
    await flushPromises();
    expect(openings.IndexConversionDialog).toBe(1);
  });

  it("registers a command per menu entry while mounted", () => {
    mount(DataIOMenu);
    const ids = allCommands.value.map((command) => command.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "data.import.json",
        "data.export.json",
        "data.export.csv",
        "data.export.indexConversions",
      ]),
    );
  });

  it("hands the CSV dialog the filtered list only while it is open", async () => {
    const wrapper = mount(DataIOMenu);
    await run("data.export.csv");
    await flushPromises();
    expect(lastAnnotations.AnnotationCsvDialog).toHaveLength(2);
    wrapper
      .findComponent({ name: "AnnotationCsvDialog" })
      .vm.$emit("update:open", false);
    await flushPromises();
    expect(lastAnnotations.AnnotationCsvDialog).toEqual([]);
  });

  it("its dialogs render no activator of their own", () => {
    // DataIOMenu opens them through v-model:open from outside its menu. An
    // activator slot left in place renders its fallback button wherever the
    // dialog is mounted (an empty #activator template does not suppress it,
    // because Vue renders the fallback for empty slot content).
    const dialogs = [
      "AnnotationImport",
      "AnnotationExport",
      "AnnotationCSVDialog",
      "IndexConversionDialog",
    ];
    for (const name of dialogs) {
      const source = readFileSync(
        join(__dirname, "AnnotationBrowser", `${name}.vue`),
        "utf8",
      );
      expect(source, name).not.toMatch(/v-slot:activator|#activator/);
    }
    const menu = readFileSync(join(__dirname, "DataIOMenu.vue"), "utf8");
    expect(menu).not.toMatch(/<template #activator \/>/);
  });

  it("offers Import only to logged-in users, in the menu and the palette alike", async () => {
    (store as any).isLoggedIn = false;
    const wrapper = mount(DataIOMenu, { attachTo: document.body });
    await wrapper.find("button").trigger("click");
    await flushPromises();
    const item = (id: string) =>
      document.querySelector(`[data-command-id="${id}"]`);
    expect(item("data.import.json")?.classList).toContain(
      "v-list-item--disabled",
    );
    expect(item("data.export.json")?.classList).not.toContain(
      "v-list-item--disabled",
    );
    const command = (id: string) => allCommands.value.find((c) => c.id === id)!;
    expect(command("data.import.json").enabled!()).toBe(false);
    expect(command("data.export.json").enabled!()).toBe(true);
    (store as any).isLoggedIn = true;
    expect(command("data.import.json").enabled!()).toBe(true);
  });
});
