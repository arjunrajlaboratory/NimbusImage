import { describe, it, expect } from "vitest";
import {
  completeLeftOrder,
  defaultArrangement,
  defaultLayout,
  layoutWithClosed,
  layoutWithMinimized,
  layoutWithOpen,
  layoutWithOpenSet,
  leftOrderAfterDrop,
  leftOrderAfterStep,
  validateArrangement,
  validateLayout,
} from "./panelLayout";

describe("panelLayout", () => {
  it("the default layout is the registry's defaultOpen panels", () => {
    expect(defaultLayout()).toEqual({
      version: 1,
      open: ["navigatorPanel", "layersPanel", "toolsPanel"],
      minimized: [],
    });
  });

  describe("validateLayout", () => {
    it("rejects anything that is not a layout", () => {
      for (const raw of [null, undefined, 3, "open", [], {}, { open: "x" }]) {
        expect(validateLayout(raw)).toBeNull();
      }
    });

    it("drops ids it does not know and repeats", () => {
      expect(
        validateLayout({
          open: ["layersPanel", "goneInThisVersion", 7, "layersPanel"],
          minimized: ["goneInThisVersion"],
        }),
      ).toEqual({ version: 1, open: ["layersPanel"], minimized: [] });
    });

    it("resolves two right-zone primaries to the last one", () => {
      expect(
        validateLayout({ open: ["annotationPanel", "settingsPanel"] })?.open,
      ).toEqual(["settingsPanel"]);
    });

    it("keeps a companion only with a host", () => {
      expect(
        validateLayout({ open: ["filtersPanel", "analysisPanel"] })?.open,
      ).toEqual(["filtersPanel", "analysisPanel"]);
      expect(
        validateLayout({ open: ["filtersPanel", "snapshotPanel"] })?.open,
      ).toEqual(["snapshotPanel"]);
    });

    it("reads a later format as nothing stored", () => {
      expect(validateLayout({ version: 2, open: ["toolsPanel"] })).toBeNull();
      expect(validateArrangement({ version: 2, widths: {} })).toBeNull();
    });

    it("accepts a layout with only an open set", () => {
      expect(validateLayout({ open: ["toolsPanel"] })).toEqual({
        version: 1,
        open: ["toolsPanel"],
        minimized: [],
      });
    });

    it("keeps minimized only for panels that are open", () => {
      expect(
        validateLayout({
          open: ["toolsPanel", "annotationPanel"],
          minimized: ["annotationPanel", "layersPanel"],
        })?.minimized,
      ).toEqual(["annotationPanel"]);
    });
  });

  describe("changes", () => {
    const base = layoutWithMinimized(
      layoutWithOpenSet(["toolsPanel", "annotationPanel", "filtersPanel"]),
      "annotationPanel",
    );

    it("minimizing keeps the panel open", () => {
      expect(base.open).toContain("annotationPanel");
      expect(base.minimized).toEqual(["annotationPanel"]);
    });

    it("minimizing a closed panel changes nothing", () => {
      expect(layoutWithMinimized(base, "settingsPanel")).toBe(base);
    });

    it("opening a minimized panel restores it", () => {
      expect(layoutWithOpen(base, "annotationPanel").minimized).toEqual([]);
    });

    it("opening a primary drops the minimized panel it evicts", () => {
      expect(layoutWithOpen(base, "settingsPanel")).toEqual({
        version: 1,
        open: ["toolsPanel", "settingsPanel"],
        minimized: [],
      });
    });

    it("closing a panel also clears its minimized flag", () => {
      expect(layoutWithClosed(base, "annotationPanel")).toEqual({
        version: 1,
        open: ["toolsPanel", "filtersPanel"],
        minimized: [],
      });
    });
  });

  describe("arrangement", () => {
    it("defaults to the registry order and no widths", () => {
      expect(defaultArrangement()).toEqual({
        version: 1,
        leftOrder: ["navigatorPanel", "layersPanel", "toolsPanel"],
        widths: {},
      });
    });

    it("completes a stored order with missing panels and drops strangers", () => {
      expect(completeLeftOrder(["toolsPanel", "annotationPanel"])).toEqual([
        "toolsPanel",
        "navigatorPanel",
        "layersPanel",
      ]);
    });

    describe("leftOrderAfterDrop", () => {
      const order = ["navigatorPanel", "layersPanel", "toolsPanel"] as const;
      const showing = [
        { id: "navigatorPanel", center: 100 },
        { id: "layersPanel", center: 300 },
        { id: "toolsPanel", center: 500 },
      ] as const;

      it("moves a palette down past the ones its center passed", () => {
        expect(
          leftOrderAfterDrop(order, "navigatorPanel", 350, showing),
        ).toEqual(["layersPanel", "navigatorPanel", "toolsPanel"]);
        expect(
          leftOrderAfterDrop(order, "navigatorPanel", 900, showing),
        ).toEqual(["layersPanel", "toolsPanel", "navigatorPanel"]);
      });

      it("moves a palette up, and leaves it when it did not pass a neighbor", () => {
        expect(leftOrderAfterDrop(order, "toolsPanel", 50, showing)).toEqual([
          "toolsPanel",
          "navigatorPanel",
          "layersPanel",
        ]);
        expect(leftOrderAfterDrop(order, "layersPanel", 320, showing)).toEqual(
          order,
        );
      });

      it("places relative to the palettes that are showing only", () => {
        // Layers is closed: dropping Navigator below Tools still ends last.
        expect(
          leftOrderAfterDrop(order, "navigatorPanel", 600, [
            { id: "navigatorPanel", center: 100 },
            { id: "toolsPanel", center: 500 },
          ]),
        ).toEqual(["layersPanel", "toolsPanel", "navigatorPanel"]);
      });
    });

    describe("leftOrderAfterStep", () => {
      const order = ["navigatorPanel", "layersPanel", "toolsPanel"] as const;
      const all = [...order];

      it("moves one place, and stops at either end", () => {
        expect(leftOrderAfterStep(order, "layersPanel", -1, all)).toEqual([
          "layersPanel",
          "navigatorPanel",
          "toolsPanel",
        ]);
        expect(leftOrderAfterStep(order, "layersPanel", 1, all)).toEqual([
          "navigatorPanel",
          "toolsPanel",
          "layersPanel",
        ]);
        expect(leftOrderAfterStep(order, "navigatorPanel", -1, all)).toEqual(
          order,
        );
        expect(leftOrderAfterStep(order, "toolsPanel", 1, all)).toEqual(order);
      });

      it("steps past a palette that is not showing, so every press moves it on screen", () => {
        // Layers is closed: Navigator's neighbor on screen is Tools.
        expect(
          leftOrderAfterStep(order, "navigatorPanel", 1, [
            "navigatorPanel",
            "toolsPanel",
          ]),
        ).toEqual(["toolsPanel", "layersPanel", "navigatorPanel"]);
      });
    });

    it("validates widths and order, and rejects a non-object", () => {
      expect(validateArrangement("wide")).toBeNull();
      expect(
        validateArrangement({
          leftOrder: ["layersPanel"],
          widths: { left: 500, right: "big", top: 3 },
        }),
      ).toEqual({
        version: 1,
        leftOrder: ["layersPanel", "navigatorPanel", "toolsPanel"],
        widths: { left: 500 },
      });
      expect(validateArrangement({ widths: { right: -4 } })?.widths).toEqual(
        {},
      );
    });
  });
});
