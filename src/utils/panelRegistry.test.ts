import { describe, it, expect } from "vitest";
import {
  PANELS,
  PANEL_IDS,
  PanelId,
  WORKSPACES,
  applyOpen,
  countBadge,
  isPanelAvailable,
  isPanelId,
  isPanelRelevant,
  panelBadge,
} from "./panelRegistry";

function open(ids: PanelId[], id: PanelId): PanelId[] {
  return [...applyOpen(new Set(ids), id)].sort();
}

describe("panelRegistry", () => {
  it("lists each panel once, with a known zone and role", () => {
    expect(new Set(PANEL_IDS).size).toBe(PANELS.length);
    for (const panel of PANELS) {
      expect(["left", "right"]).toContain(panel.zone);
      if (panel.role === "companion") {
        expect(panel.hosts?.length).toBeGreaterThan(0);
      }
    }
  });

  it("opens the left stack by default and nothing on the right", () => {
    expect(
      PANELS.filter((panel) => panel.defaultOpen).map((panel) => panel.id),
    ).toEqual(["navigatorPanel", "layersPanel", "toolsPanel"]);
  });

  it("every workspace is a set of panels the placement rules allow as is", () => {
    expect(new Set(WORKSPACES.map((workspace) => workspace.id)).size).toBe(
      WORKSPACES.length,
    );
    for (const workspace of WORKSPACES) {
      // Opening its panels one at a time must evict none of them: otherwise
      // the workspace would silently show fewer panels than it names.
      let open = new Set<PanelId>();
      for (const id of workspace.open) {
        open = applyOpen(open, id);
      }
      expect([...open], workspace.title).toEqual(workspace.open);
    }
  });

  it("knows a panel id from anything else, inherited names included", () => {
    expect(isPanelId("layersPanel")).toBe(true);
    for (const value of ["constructor", "toString", "sidePanel", 3, null]) {
      expect(isPanelId(value)).toBe(false);
    }
  });

  describe("status", () => {
    const quiet = {
      activeFilterCount: 0,
      activeAnalysisGateCount: 0,
      transcriptsReachable: false,
      hasUnseenJobResults: false,
    };

    it("a count badge is empty at zero and capped at 9+", () => {
      expect(countBadge(0)).toBeNull();
      expect(countBadge(3)).toBe("3");
      expect(countBadge(9)).toBe("9");
      expect(countBadge(10)).toBe("9+");
    });

    it("each badge counts only what its own panel shows", () => {
      const context = { ...quiet, activeFilterCount: 2 };
      expect(panelBadge("filtersPanel", context)).toBe("2");
      expect(panelBadge("analysisPanel", context)).toBeNull();
      expect(
        panelBadge("analysisPanel", { ...quiet, activeAnalysisGateCount: 12 }),
      ).toBe("9+");
      expect(panelBadge("layersPanel", context)).toBeNull();
    });

    it("only the Object Browser is accented, and only for unseen job results", () => {
      for (const id of PANEL_IDS) {
        expect(isPanelRelevant(id, quiet)).toBe(false);
        expect(
          isPanelRelevant(id, { ...quiet, hasUnseenJobResults: true }),
        ).toBe(id === "annotationPanel");
      }
    });

    it("only Transcripts depends on the dataset, and every other panel is always available", () => {
      for (const id of PANEL_IDS) {
        expect(isPanelAvailable(id, quiet)).toBe(id !== "transcriptsPanel");
        expect(
          isPanelAvailable(id, { ...quiet, transcriptsReachable: true }),
        ).toBe(true);
      }
    });
  });

  describe("applyOpen", () => {
    it("a primary evicts the other right-zone primary", () => {
      expect(open(["annotationPanel"], "snapshotPanel")).toEqual([
        "snapshotPanel",
      ]);
    });

    it("a primary keeps a companion that hosts with it", () => {
      expect(open(["filtersPanel"], "analysisPanel")).toEqual([
        "analysisPanel",
        "filtersPanel",
      ]);
    });

    it("a primary evicts a companion that doesn't host with it", () => {
      expect(
        open(["annotationPanel", "filtersPanel"], "settingsPanel"),
      ).toEqual(["settingsPanel"]);
    });

    it("a companion joins its host", () => {
      expect(open(["annotationPanel"], "filtersPanel")).toEqual([
        "annotationPanel",
        "filtersPanel",
      ]);
    });

    it("a companion evicts a primary that isn't its host", () => {
      expect(open(["snapshotPanel"], "filtersPanel")).toEqual(["filtersPanel"]);
    });

    it("left-zone palettes stack independently of each other and the right", () => {
      expect(
        open(
          ["navigatorPanel", "annotationPanel", "filtersPanel"],
          "toolsPanel",
        ),
      ).toEqual([
        "annotationPanel",
        "filtersPanel",
        "navigatorPanel",
        "toolsPanel",
      ]);
      expect(open(["navigatorPanel", "toolsPanel"], "settingsPanel")).toEqual([
        "navigatorPanel",
        "settingsPanel",
        "toolsPanel",
      ]);
    });

    it("leaves the set unchanged for an unknown id", () => {
      expect(
        open(["annotationPanel"], "timelapsePanel" as unknown as PanelId),
      ).toEqual(["annotationPanel"]);
    });

    it("does not mutate its input", () => {
      const input = new Set<PanelId>(["annotationPanel"]);
      applyOpen(input, "snapshotPanel");
      expect([...input]).toEqual(["annotationPanel"]);
    });
  });
});
