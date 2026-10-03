import { describe, it, expect } from "vitest";
import {
  PANELS,
  PANEL_IDS,
  PanelId,
  applyOpen,
  getPanel,
  isPanelId,
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

  it("isPanelId / getPanel recognise registered ids only", () => {
    expect(isPanelId("filtersPanel")).toBe(true);
    expect(isPanelId("timelapsePanel")).toBe(false);
    expect(getPanel("filtersPanel")?.title).toBe("Filters");
  });
});
