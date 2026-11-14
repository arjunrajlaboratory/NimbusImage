import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { effectScope, reactive } from "vue";
import { PanelId } from "./panelRegistry";
import {
  MAX_REMEMBERED_CONFIGURATIONS,
  usePanelLayout,
} from "./usePanelLayout";
import { setUiStateScope } from "./uiState";

const DEFAULT_OPEN: PanelId[] = ["navigatorPanel", "layersPanel", "toolsPanel"];

function stored(key: string, scope = "anonymous"): unknown {
  const raw = window.localStorage.getItem(`nimbus.ui.${scope}.${key}`);
  return raw === null ? null : JSON.parse(raw);
}

describe("usePanelLayout", () => {
  let scopes: ReturnType<typeof effectScope>[];
  let env: {
    inViewer: boolean;
    configurationId: string | null;
    collectionDefault: unknown;
    unavailable: PanelId[];
  };

  function mount() {
    const scope = effectScope();
    scopes.push(scope);
    return scope.run(() =>
      usePanelLayout({
        inViewer: () => env.inViewer,
        configurationId: () => env.configurationId,
        collectionDefault: () => env.collectionDefault,
        isAvailable: (id) => !env.unavailable.includes(id),
      }),
    )!;
  }

  // A fresh page load: every composable from before is gone.
  function reload() {
    for (const scope of scopes.splice(0)) {
      scope.stop();
    }
    return mount();
  }

  function shown(panels: ReturnType<typeof mount>): PanelId[] {
    return (Object.keys(panels.visible) as PanelId[])
      .filter((id) => panels.visible[id].value)
      .sort();
  }

  beforeEach(() => {
    window.localStorage.clear();
    setUiStateScope(null);
    scopes = [];
    env = reactive({
      inViewer: true,
      configurationId: "config-a" as string | null,
      collectionDefault: null as unknown,
      unavailable: [] as PanelId[],
    });
  });

  afterEach(() => {
    for (const scope of scopes.splice(0)) {
      scope.stop();
    }
  });

  describe("restore order", () => {
    it("falls back to the registry defaults when nothing is stored", () => {
      expect(shown(mount())).toEqual([...DEFAULT_OPEN].sort());
    });

    it("uses my last layout in a collection I have not visited", () => {
      const first = mount();
      first.toggle("layersPanel");
      first.open("snapshotPanel");

      env.configurationId = "config-b";
      expect(shown(reload())).toEqual([
        "navigatorPanel",
        "snapshotPanel",
        "toolsPanel",
      ]);
    });

    it("prefers the collection default over my last layout", () => {
      mount().open("snapshotPanel");

      env.configurationId = "config-b";
      env.collectionDefault = { version: 1, open: ["annotationPanel"] };
      expect(shown(reload())).toEqual(["annotationPanel"]);
    });

    it("prefers my own layout for the collection over its default", () => {
      env.collectionDefault = { version: 1, open: ["annotationPanel"] };
      const first = mount();
      first.open("settingsPanel");

      expect(shown(reload())).toEqual(["settingsPanel"]);
    });

    it("ignores an invalid collection default", () => {
      env.collectionDefault = { open: "everything" };
      expect(shown(mount())).toEqual([...DEFAULT_OPEN].sort());
    });

    it("keeps each collection's layout apart", () => {
      const panels = mount();
      panels.open("annotationPanel");
      env.configurationId = "config-b";
      panels.open("settingsPanel");

      env.configurationId = "config-a";
      expect(panels.visible.annotationPanel.value).toBe(true);
      expect(panels.visible.settingsPanel.value).toBe(false);
      env.configurationId = "config-b";
      expect(panels.visible.settingsPanel.value).toBe(true);
    });
  });

  describe("a collection that arrives after the route", () => {
    it("shows my last layout first, then the collection's own", () => {
      mount().open("snapshotPanel"); // config-a's layout, and my last
      env.configurationId = "config-b";
      const other = reload();
      other.open("settingsPanel"); // config-b's layout, and now my last

      env.configurationId = null;
      const panels = reload();
      expect(panels.visible.settingsPanel.value).toBe(true);
      env.configurationId = "config-a";
      expect(panels.visible.snapshotPanel.value).toBe(true);
      expect(panels.visible.settingsPanel.value).toBe(false);
    });

    it("keeps a change I made while it was loading, and stores it for the collection", () => {
      mount().open("snapshotPanel");

      env.configurationId = null;
      const panels = reload();
      panels.open("analysisPanel");
      env.configurationId = "config-a";
      expect(panels.visible.analysisPanel.value).toBe(true);
      expect(panels.visible.snapshotPanel.value).toBe(false);

      expect(reload().visible.analysisPanel.value).toBe(true);
    });

    it("a request that changes nothing while the collection loads does not override its layout", () => {
      mount().open("snapshotPanel"); // config-a's layout
      env.configurationId = "config-b";
      reload().open("settingsPanel"); // my last

      env.configurationId = null;
      const panels = reload();
      // e.g. a component asking for a panel that is already showing.
      panels.open("settingsPanel");
      env.configurationId = "config-a";
      expect(panels.visible.snapshotPanel.value).toBe(true);
    });

    it("does not restore again when the same collection is re-read", () => {
      env.collectionDefault = { version: 1, open: ["annotationPanel"] };
      const panels = mount();
      // Nothing of mine is stored for the collection, so a second restore
      // would show its default again and undo the hide.
      panels.toggleChromeHidden();
      // A sync replaces the configuration object: same id, new default.
      env.collectionDefault = { version: 1, open: ["snapshotPanel"] };
      expect(panels.chromeHidden.value).toBe(true);
      panels.toggleChromeHidden();
      expect(panels.visible.annotationPanel.value).toBe(true);
      expect(panels.visible.snapshotPanel.value).toBe(false);
      expect(window.localStorage.length).toBe(0);
    });

    it("keeps what is on screen while the next collection loads", () => {
      const panels = mount();
      panels.open("annotationPanel"); // config-a's layout, and my last
      env.configurationId = "config-b";
      panels.open("settingsPanel"); // config-b's layout, and now my last

      env.configurationId = null;
      expect(panels.visible.settingsPanel.value).toBe(true);
      env.configurationId = "config-a";
      expect(panels.visible.annotationPanel.value).toBe(true);
    });

    it("a switch to an unvisited collection uses my last layout, as a reload there would", () => {
      const panels = mount();
      panels.open("annotationPanel"); // config-a
      env.configurationId = "config-b";
      panels.open("settingsPanel"); // config-b, and my last
      env.configurationId = "config-a"; // shows config-a's own again
      expect(panels.visible.annotationPanel.value).toBe(true);

      env.configurationId = "config-c";
      expect(panels.visible.settingsPanel.value).toBe(true);
      expect(panels.visible.annotationPanel.value).toBe(false);
      env.configurationId = "config-c";
      expect(shown(reload())).toEqual(shown(panels));
    });

    it("a change made while the next collection loads goes to it, not the previous one", () => {
      const panels = mount();
      panels.open("annotationPanel"); // config-a
      const forA = JSON.stringify(stored("layout.byConfiguration"));

      env.configurationId = null;
      panels.open("settingsPanel");
      expect(JSON.stringify(stored("layout.byConfiguration"))).toBe(forA);
      env.configurationId = "config-b";
      expect(panels.visible.settingsPanel.value).toBe(true);
      expect(
        (stored("layout.byConfiguration") as [string, unknown][]).map(
          ([id]) => id,
        ),
      ).toEqual(["config-a", "config-b"]);
    });
  });

  describe("saving", () => {
    it("restoring writes nothing", () => {
      mount();
      expect(window.localStorage.length).toBe(0);
      env.collectionDefault = { version: 1, open: ["annotationPanel"] };
      env.configurationId = "config-b";
      expect(window.localStorage.length).toBe(0);
    });

    it("a change is stored at once, as my last layout and the collection's", () => {
      const panels = mount();
      panels.open("filtersPanel");
      const layout = {
        version: 1,
        open: [...DEFAULT_OPEN, "filtersPanel"],
      };
      expect(stored("layout.last")).toEqual(layout);
      expect(stored("layout.byConfiguration")).toEqual([["config-a", layout]]);
    });

    it("leaving the viewer hides every panel and stores nothing", () => {
      const panels = mount();
      panels.open("annotationPanel");
      const before = stored("layout.last");

      env.inViewer = false;
      expect(shown(panels)).toEqual([]);
      expect(stored("layout.last")).toEqual(before);

      env.inViewer = true;
      expect(panels.visible.annotationPanel.value).toBe(true);
    });

    it("refuses to open or apply a layout outside the viewer", () => {
      env.inViewer = false;
      const panels = mount();
      panels.open("annotationPanel");
      panels.toggle("settingsPanel");
      panels.applyOpenSet(["snapshotPanel"]);
      panels.reset();
      expect(panels.layout.value.open).toEqual([]);
      expect(window.localStorage.length).toBe(0);
    });

    it("keeps only the most recent collections", () => {
      const panels = mount();
      for (let i = 0; i < MAX_REMEMBERED_CONFIGURATIONS + 5; i++) {
        env.configurationId = `config-${i}`;
        panels.toggle("layersPanel");
      }
      const ids = (stored("layout.byConfiguration") as [string, unknown][]).map(
        ([id]) => id,
      );
      expect(ids).toHaveLength(MAX_REMEMBERED_CONFIGURATIONS);
      expect(ids[0]).toBe("config-5");
      expect(ids[ids.length - 1]).toBe(
        `config-${MAX_REMEMBERED_CONFIGURATIONS + 4}`,
      );
    });

    it("moves a revisited collection to most recent instead of repeating it", () => {
      const panels = mount();
      panels.toggle("layersPanel");
      env.configurationId = "config-b";
      panels.toggle("layersPanel");
      env.configurationId = "config-a";
      panels.toggle("toolsPanel");
      expect(
        (stored("layout.byConfiguration") as [string, unknown][]).map(
          ([id]) => id,
        ),
      ).toEqual(["config-b", "config-a"]);
    });

    it("survives a corrupt stored list", () => {
      window.localStorage.setItem(
        "nimbus.ui.anonymous.layout.byConfiguration",
        '{"config-a": 3}',
      );
      window.localStorage.setItem("nimbus.ui.anonymous.layout.last", "nope");
      const panels = mount();
      expect(shown(panels)).toEqual([...DEFAULT_OPEN].sort());
      panels.open("snapshotPanel");
      expect(reload().visible.snapshotPanel.value).toBe(true);
    });
  });

  describe("users", () => {
    it("keeps each user's layout apart, and restores when the user changes", () => {
      const panels = mount();
      panels.open("annotationPanel");

      setUiStateScope("user-1");
      expect(panels.visible.annotationPanel.value).toBe(false);
      panels.open("settingsPanel");
      expect(stored("layout.last", "user-1")).not.toBeNull();

      setUiStateScope(null);
      expect(panels.visible.annotationPanel.value).toBe(true);
      expect(panels.visible.settingsPanel.value).toBe(false);
    });
  });

  describe("visibility", () => {
    it("toggle closes a shown panel and opens a closed one by the placement rules", () => {
      const panels = mount();
      panels.toggle("annotationPanel");
      panels.toggle("settingsPanel");
      expect(panels.visible.settingsPanel.value).toBe(true);
      expect(panels.visible.annotationPanel.value).toBe(false);
      panels.toggle("settingsPanel");
      expect(panels.visible.settingsPanel.value).toBe(false);
    });

    it("writing a panel's ref opens it by the placement rules, or closes it", () => {
      const panels = mount();
      panels.visible.annotationPanel.value = true;
      panels.visible.settingsPanel.value = true;
      expect(panels.visible.settingsPanel.value).toBe(true);
      expect(panels.visible.annotationPanel.value).toBe(false);
      panels.visible.settingsPanel.value = false;
      expect(panels.layout.value.open).not.toContain("settingsPanel");
    });

    // There is no third state: a panel that is not on screen is closed (its
    // chip is how it comes back), and the layout holds only what is open.
    it("a closed panel leaves the layout, and stays closed on the next page load", () => {
      const panels = mount();
      panels.close("toolsPanel");
      expect(panels.layout.value).toEqual({
        version: 1,
        open: ["navigatorPanel", "layersPanel"],
      });
      expect(stored("layout.last")).toEqual(panels.layout.value);
      expect(reload().visible.toolsPanel.value).toBe(false);
    });

    it("hides an unavailable panel without changing or rewriting the layout", () => {
      const panels = mount();
      panels.open("transcriptsPanel");
      const before = stored("layout.last");

      env.unavailable = ["transcriptsPanel"];
      expect(panels.visible.transcriptsPanel.value).toBe(false);
      expect(stored("layout.last")).toEqual(before);

      env.unavailable = [];
      expect(panels.visible.transcriptsPanel.value).toBe(true);
    });

    it("hide-all hides every panel, restores the same set, and is not stored", () => {
      const panels = mount();
      panels.open("annotationPanel");
      panels.close("toolsPanel");
      const before = shown(panels);
      const layoutBefore = panels.layout.value;
      const storedBefore = stored("layout.last");

      panels.toggleChromeHidden();
      expect(shown(panels)).toEqual([]);
      expect(panels.layout.value).toBe(layoutBefore);
      expect(stored("layout.last")).toEqual(storedBefore);
      panels.toggleChromeHidden();
      expect(shown(panels)).toEqual(before);
      expect(shown(reload())).toEqual(before);
    });

    it("hide-all a second time, or opening a panel, shows the panels again", () => {
      const panels = mount();
      const before = shown(panels);
      panels.toggleChromeHidden();
      panels.toggleChromeHidden();
      expect(shown(panels)).toEqual(before);

      panels.toggleChromeHidden();
      panels.open("snapshotPanel");
      expect(shown(panels)).toEqual([...before, "snapshotPanel"].sort());
    });

    it("hide-all does not carry into the next visit", () => {
      const panels = mount();
      panels.toggleChromeHidden();
      env.inViewer = false;
      env.inViewer = true;
      expect(shown(panels)).toEqual([...DEFAULT_OPEN].sort());
    });
  });

  describe("presets", () => {
    it("applying an open set shows exactly it, by the placement rules", () => {
      const panels = mount();
      panels.applyOpenSet(["layersPanel", "annotationPanel", "filtersPanel"]);
      expect(shown(panels)).toEqual([
        "annotationPanel",
        "filtersPanel",
        "layersPanel",
      ]);
    });

    it("reset returns to the collection default, or the app's without one", () => {
      const panels = mount();
      panels.open("settingsPanel");
      panels.reset();
      expect(shown(panels)).toEqual([...DEFAULT_OPEN].sort());
      // Without a collection default the reset is my layout for it, or a
      // reload would bring back my last layout from somewhere else.
      expect(shown(reload())).toEqual([...DEFAULT_OPEN].sort());

      env.collectionDefault = { version: 1, open: ["snapshotPanel"] };
      const again = reload();
      again.reset();
      expect(shown(again)).toEqual(["snapshotPanel"]);
    });

    it("after a reset I follow the collection default, including one changed later", () => {
      env.collectionDefault = { version: 1, open: ["snapshotPanel"] };
      const panels = mount();
      panels.open("settingsPanel");
      panels.reset();
      expect(stored("layout.byConfiguration")).toEqual([]);

      env.collectionDefault = { version: 1, open: ["annotationPanel"] };
      expect(shown(reload())).toEqual(["annotationPanel"]);
    });

    it("hide-all outlasts a restore within the visit", () => {
      const panels = mount();
      panels.toggleChromeHidden();
      // Another view of the same collection: unknown, then known again.
      env.configurationId = null;
      env.configurationId = "config-a";
      expect(panels.chromeHidden.value).toBe(true);
      // A different collection arriving does not bring the panels back either.
      env.configurationId = "config-b";
      expect(shown(panels)).toEqual([]);
      panels.toggleChromeHidden();
      expect(shown(panels)).toEqual([...DEFAULT_OPEN].sort());
    });
  });

  describe("arrangement", () => {
    it("resetting the arrangement returns to default widths and order", () => {
      const panels = mount();
      panels.setZoneWidth("left", 500);
      panels.setLeftOrder(["toolsPanel"]);
      panels.resetArrangement();
      expect(reload().arrangement.value).toEqual({
        version: 1,
        leftOrder: ["navigatorPanel", "layersPanel", "toolsPanel"],
        widths: {},
      });
    });

    it("remembers zone widths and the left order across collections", () => {
      const panels = mount();
      panels.setZoneWidth("right", 611.6);
      panels.setLeftOrder(["toolsPanel", "navigatorPanel"]);

      env.configurationId = "config-b";
      const next = reload();
      expect(next.arrangement.value).toEqual({
        version: 1,
        leftOrder: ["toolsPanel", "navigatorPanel", "layersPanel"],
        widths: { right: 612 },
      });
      next.setZoneWidth("right", null);
      expect(reload().arrangement.value.widths).toEqual({});
    });
  });
});
