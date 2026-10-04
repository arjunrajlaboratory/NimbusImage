import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { readFileSync } from "fs";
import { join } from "path";

// Coverage: every app-bar control names its ⌘K palette command, and the name
// resolves to a command App.vue actually registers. Adding a control without a
// command (or renaming one) fails here instead of silently dropping the
// feature from the palette. Its own file so no earlier mount in the same
// module can have registered the ids already.

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      isLoggedIn: true,
      girderUser: { _id: "u1" },
      dataset: { id: "ds" },
      setToolTemplateList: vi.fn(),
      setIsAnnotationPanelOpen: vi.fn(),
      isAnnotationPanelOpen: false,
      paletteOpenRequests: [] as string[],
      setPaletteOpenRequests: vi.fn(),
    }),
  };
});

vi.mock("@/store/properties", () => ({
  default: { uncomputedCountByProperty: {} },
}));

vi.mock("@/store/filters", () => ({
  default: { activeFilterCount: 0, activeAnalysisGateCount: 0 },
}));

vi.mock("axios", () => ({
  default: { get: vi.fn().mockResolvedValue({ data: [] }) },
}));

vi.mock("@/utils/v-mousetrap", async () => {
  const { ref } = await import("vue");
  return { default: vi.fn(), boundKeys: ref({}) };
});

import { routeProvider, routerProvider } from "@/test/helpers";
import App from "./App.vue";
import { allCommands } from "@/commands/registry";

const template = readFileSync(join(__dirname, "App.vue"), "utf8").split(
  "<script setup",
)[0];

describe("App.vue command palette coverage", () => {
  it("gives every app-bar palette toggle a data-command-id", () => {
    const toggles = template.match(/class="palette-ibtn"/g) ?? [];
    const toggleIds =
      template.match(
        /data-command-id="(panel\.toggle\.[a-zA-Z]+|view\.toggle[a-zA-Z0-9]+)"/g,
      ) ?? [];
    expect(toggles.length).toBeGreaterThan(0);
    expect(toggleIds.length).toBe(toggles.length);
  });

  it("registers a command for every data-command-id in the template", () => {
    expect(allCommands.value).toEqual([]);
    const wrapper = shallowMount(App, {
      global: {
        provide: {
          ...routeProvider({ name: "datasetview", params: {} }),
          ...routerProvider({ push: vi.fn() }),
        },
        stubs: { "router-view": true },
      },
    });
    const declared = [...template.matchAll(/data-command-id="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(declared.length).toBeGreaterThan(10);
    const registered = new Set(allCommands.value.map((command) => command.id));
    expect(declared.filter((id) => !registered.has(id))).toEqual([]);
    wrapper.unmount();
    // ...and App.vue's registrations go away with it.
    expect(allCommands.value).toEqual([]);
  });
});
