import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

// Mock the toolSuggestions store: a plain mutable object the tests
// reassign before each mount.
vi.mock("@/store/toolSuggestions", () => ({
  default: {
    status: "idle",
    suggestions: [] as any[],
    errorMessage: null as string | null,
    dismissed: false,
    acceptSuggestion: vi.fn(),
    acceptAllSuggestions: vi.fn(),
    suggestForCurrentConfiguration: vi.fn(),
    setDismissed: vi.fn(),
  },
}));

import ToolSuggestions from "./ToolSuggestions.vue";
import toolSuggestionsStore from "@/store/toolSuggestions";

function makeResolved(
  id: string,
  confidence?: "low" | "medium" | "high",
  channelName?: string,
) {
  return {
    suggestion: {
      toolId: `catalog:${id}`,
      reason: `Reason for ${id}`,
      confidence,
      channelName,
    },
    catalogEntry: {
      id: `catalog:${id}`,
      name: `Tool ${id}`,
      kind: "manual" as const,
      description: "",
    },
    tool: {
      id,
      name: `Tool ${id}`,
      hotkey: null,
      type: "create" as const,
      template: {
        name: "Create",
        type: "create" as const,
        description: "",
        interface: [],
      },
      values: {},
    },
  };
}

function mountComponent() {
  return mount(ToolSuggestions);
}

describe("ToolSuggestions.vue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(toolSuggestionsStore, {
      status: "idle",
      suggestions: [],
      errorMessage: null,
      dismissed: false,
    });
  });

  describe("visible", () => {
    it("is hidden when dismissed, even with suggestions present", () => {
      Object.assign(toolSuggestionsStore, {
        status: "done",
        suggestions: [makeResolved("a", "high")],
        dismissed: true,
      });
      const wrapper = mountComponent();
      expect((wrapper.vm as any).visible).toBe(false);
    });

    it("is visible while loading", () => {
      Object.assign(toolSuggestionsStore, { status: "loading" });
      const wrapper = mountComponent();
      expect((wrapper.vm as any).visible).toBe(true);
    });

    it("is visible on error", () => {
      Object.assign(toolSuggestionsStore, {
        status: "error",
        errorMessage: "Could not generate suggestions.",
      });
      const wrapper = mountComponent();
      expect((wrapper.vm as any).visible).toBe(true);
    });

    it("is visible when done with a non-empty suggestion list", () => {
      Object.assign(toolSuggestionsStore, {
        status: "done",
        suggestions: [makeResolved("a", "high")],
      });
      const wrapper = mountComponent();
      expect((wrapper.vm as any).visible).toBe(true);
    });

    it("is hidden when done with an empty suggestion list", () => {
      Object.assign(toolSuggestionsStore, { status: "done", suggestions: [] });
      const wrapper = mountComponent();
      expect((wrapper.vm as any).visible).toBe(false);
    });
  });

  describe("user actions", () => {
    it("accept() calls toolSuggestionsStore.acceptSuggestion with the resolved suggestion", () => {
      const resolved = makeResolved("a", "high");
      Object.assign(toolSuggestionsStore, {
        status: "done",
        suggestions: [resolved],
      });
      const wrapper = mountComponent();
      (wrapper.vm as any).accept(resolved);
      expect(toolSuggestionsStore.acceptSuggestion).toHaveBeenCalledWith(
        resolved,
      );
    });

    it("acceptAll() calls toolSuggestionsStore.acceptAllSuggestions", () => {
      Object.assign(toolSuggestionsStore, {
        status: "done",
        suggestions: [makeResolved("a", "high")],
      });
      const wrapper = mountComponent();
      (wrapper.vm as any).acceptAll();
      expect(toolSuggestionsStore.acceptAllSuggestions).toHaveBeenCalledTimes(
        1,
      );
    });

    it("dismiss() calls toolSuggestionsStore.setDismissed(true)", () => {
      const wrapper = mountComponent();
      (wrapper.vm as any).dismiss();
      expect(toolSuggestionsStore.setDismissed).toHaveBeenCalledWith(true);
    });

    it("refresh() reruns suggestions for the current configuration", () => {
      const wrapper = mountComponent();
      (wrapper.vm as any).refresh();
      expect(
        toolSuggestionsStore.suggestForCurrentConfiguration,
      ).toHaveBeenCalledTimes(1);
    });
  });

  describe("confidence sorting and chips", () => {
    it("sortedSuggestions orders high -> medium -> low -> undefined, without mutating the store array", () => {
      const low = makeResolved("low", "low");
      const high = makeResolved("high", "high");
      const medium = makeResolved("medium", "medium");
      const none = makeResolved("none");
      const originalOrder = [low, none, medium, high];
      Object.assign(toolSuggestionsStore, {
        status: "done",
        suggestions: originalOrder,
      });

      const wrapper = mountComponent();
      const sorted = (wrapper.vm as any).sortedSuggestions;

      expect(sorted.map((resolved: any) => resolved.tool.id)).toEqual([
        "high",
        "medium",
        "low",
        "none",
      ]);
      // The store's own array must be left in its original order.
      expect(
        toolSuggestionsStore.suggestions.map(
          (resolved: any) => resolved.tool.id,
        ),
      ).toEqual(["low", "none", "medium", "high"]);
    });

    it("renders a confidence chip for each suggestion with a confidence, in high -> medium -> low order", () => {
      const low = makeResolved("low", "low");
      const high = makeResolved("high", "high");
      const medium = makeResolved("medium", "medium");
      Object.assign(toolSuggestionsStore, {
        status: "done",
        suggestions: [low, high, medium],
      });

      const wrapper = mountComponent();
      const chips = wrapper.findAll(".suggestion-confidence");

      expect(chips).toHaveLength(3);
      expect(chips.map((chip) => chip.text())).toEqual([
        "high",
        "medium",
        "low",
      ]);
    });

    it("confidenceColor maps each confidence level to a theme color", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.confidenceColor("high")).toBe("success");
      expect(vm.confidenceColor("medium")).toBe("warning");
      expect(vm.confidenceColor("low")).toBe("secondary");
    });
  });
});
