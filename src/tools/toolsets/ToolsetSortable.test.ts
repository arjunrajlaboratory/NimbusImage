import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

// Uses the REAL vuedraggable (Toolset.test.ts stubs it), so these assert the
// options Sortable actually received rather than props on a stub.
vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      selectedTool: null,
      tools: [],
      configuration: { tools: [] },
      isLoggedIn: true,
      setSelectedToolId: vi.fn(),
      setToolOrder: vi.fn(),
      getLayerFromId: vi.fn(),
    }),
  };
});
vi.mock("@/store/annotation", () => ({ default: {} }));
vi.mock("@/store/properties", () => ({ default: {} }));
vi.mock("@/store/toolSuggestions", () => ({
  default: {
    status: "idle",
    dismissed: false,
    setDismissed: vi.fn(),
    suggestForCurrentConfiguration: vi.fn(),
  },
}));

import store from "@/store";
import Toolset from "./Toolset.vue";

function mountWithTools() {
  (store as any).configuration = {
    tools: [
      {
        id: "a1",
        name: "a1",
        type: "create",
        values: {},
        hotkey: null,
        template: {},
      },
    ],
  };
  return mount(Toolset, {
    global: {
      stubs: {
        ToolCreation: true,
        ToolTypeSelection: true,
        ToolItem: true,
        AnnotationWorkerMenu: true,
        SamToolMenu: true,
        CircleToDotMenu: true,
      },
    },
  });
}

function sortableOf(wrapper: ReturnType<typeof mountWithTools>) {
  return (wrapper.findComponent({ name: "draggable" }).vm as any)._sortable;
}

describe("Toolset sortable sections", () => {
  beforeEach(() => {
    (store as any).isLoggedIn = true;
  });

  it("drags only by the grip", () => {
    expect(sortableOf(mountWithTools()).option("handle")).toBe(
      ".tool-item__drag-handle",
    );
  });

  it("disables dragging when logged out", () => {
    (store as any).isLoggedIn = false;
    expect(sortableOf(mountWithTools()).option("disabled")).toBe(true);
  });

  it("enables dragging when logged in", () => {
    expect(sortableOf(mountWithTools()).option("disabled")).toBe(false);
  });
});
