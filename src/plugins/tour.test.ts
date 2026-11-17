import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// What the mocked highlighting library was asked to show, by step title.
const highlighted = vi.hoisted(() => [] as string[]);
vi.mock("driver.js", () => ({
  driver: () =>
    new Proxy(
      {},
      {
        get: (_target, method) =>
          method === "highlight"
            ? (step: { popover?: { title?: string } }) =>
                highlighted.push(step.popover?.title ?? "")
            : () => undefined,
      },
    ),
}));

import { panelRevealRequest, tourStepAlreadyDone } from "./tour";
import { TOUR_REVEAL_PANEL_EVENT, tourBus } from "./tourBus";

// The tour's half of showing a step whose anchor is mounted but hidden: what
// it asks the app for. App.test.ts covers what the app does with the request.
describe("panelRevealRequest", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function anchorIn(html: string): Element {
    document.body.innerHTML = html;
    return document.querySelector("[data-tour]")!;
  }

  it("asks for nothing when the anchor is showing", () => {
    expect(
      panelRevealRequest(
        anchorIn(
          '<aside data-panel-id="toolsPanel"><button data-tour="add-tool"></button></aside>',
        ),
      ),
    ).toBeNull();
    expect(
      panelRevealRequest(anchorIn('<button data-tour="upload"></button>')),
    ).toBeNull();
  });

  it("names the palette that holds a hidden anchor", () => {
    expect(
      panelRevealRequest(
        anchorIn(
          '<aside data-panel-id="toolsPanel" style="display: none"><div><button data-tour="add-tool"></button></div></aside>',
        ),
      ),
    ).toEqual({ panelId: "toolsPanel" });
  });

  it("asks for the panels back when the anchor is hidden outside any palette", () => {
    expect(
      panelRevealRequest(
        anchorIn(
          '<aside style="display: none"><button data-tour="timelapse"></button></aside>',
        ),
      ),
    ).toEqual({ panelId: undefined });
  });

  it("names the palette even when something inside it is what hides the anchor", () => {
    expect(
      panelRevealRequest(
        anchorIn(
          '<aside data-panel-id="layersPanel"><div style="display: none"><button data-tour="layer"></button></div></aside>',
        ),
      ),
    ).toEqual({ panelId: "layersPanel" });
  });
});

// A step that waits for the click that opens a panel ("click here to open
// the object list") points at the panel's chip, which exists only while the
// panel is closed. With the panel already open the step is done.
describe("tourStepAlreadyDone", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const openObjectList = {
    element: '[data-tour="object-list-button"]',
    onTriggerEvent: "object-list-button",
  };

  it("is done when the anchor is gone and its palette is open", () => {
    document.body.innerHTML =
      '<aside data-tour-done="object-list-button"></aside>';
    expect(tourStepAlreadyDone(openObjectList)).toBe(true);
  });

  it("is not done while the anchor is there to click", () => {
    document.body.innerHTML =
      '<button data-tour="object-list-button"></button>' +
      '<aside data-tour-done="object-list-button"></aside>';
    expect(tourStepAlreadyDone(openObjectList)).toBe(false);
  });

  it("is not done for a step that does not wait for a click", () => {
    document.body.innerHTML =
      '<aside data-tour-done="object-list-button"></aside>';
    expect(tourStepAlreadyDone({ element: openObjectList.element })).toBe(
      false,
    );
  });

  it("is not done when the palette that would show it is not displayed", () => {
    document.body.innerHTML =
      '<aside data-tour-done="object-list-button" style="display: none"></aside>';
    expect(tourStepAlreadyDone(openObjectList)).toBe(false);
    document.body.innerHTML = "";
    expect(tourStepAlreadyDone(openObjectList)).toBe(false);
  });

  it("is not done for another anchor's palette", () => {
    document.body.innerHTML = '<aside data-tour-done="filters-button"></aside>';
    expect(tourStepAlreadyDone(openObjectList)).toBe(false);
  });
});

// The manager itself, with the highlighting library replaced: which step ends
// up shown, and what it asks the app for on the way.
describe("TourManager.showCurrentStep", () => {
  beforeEach(() => {
    highlighted.length = 0;
    document.body.innerHTML = "";
  });

  async function startTour(steps: Record<string, unknown>[]) {
    const { TourManager } = await import("./tour");
    const manager = new TourManager(
      {
        afterEach: vi.fn(),
        currentRoute: { value: { name: "datasetview" } },
        push: vi.fn(),
      } as any,
      { config: { globalProperties: {} } } as any,
    );
    vi.spyOn(manager, "loadTourConfig").mockResolvedValue({
      steps: steps.map((step) => ({ route: "datasetview", text: "", ...step })),
    } as any);
    await manager.startTour("anyTour");
    return manager;
  }

  it("skips a click-to-open step whose panel is already open", async () => {
    document.body.innerHTML =
      '<aside data-tour-done="object-list-button"></aside>' +
      '<button data-tour="analyze-button"></button>';
    const manager = await startTour([
      {
        id: "open-list",
        title: "Object Browser",
        element: '[data-tour="object-list-button"]',
        onTriggerEvent: "object-list-button",
        waitForElement: 20,
      },
      {
        id: "measure",
        title: "Measure",
        element: '[data-tour="analyze-button"]',
      },
    ]);
    expect(highlighted).toEqual(["Measure"]);
    manager.stopTour();
  });

  it("shows a click-to-open step whose chip is there", async () => {
    document.body.innerHTML =
      '<button data-tour="object-list-button"></button>';
    const manager = await startTour([
      {
        id: "open-list",
        title: "Object Browser",
        element: '[data-tour="object-list-button"]',
        onTriggerEvent: "object-list-button",
        waitForElement: 20,
      },
    ]);
    expect(highlighted).toEqual(["Object Browser"]);
    manager.stopTour();
  });

  it("asks for the panels back before waiting for an anchor that is not there", async () => {
    const asked: unknown[] = [];
    const listener = (panelId: unknown) => asked.push(panelId);
    tourBus.on(TOUR_REVEAL_PANEL_EVENT, listener);
    try {
      // The app answers by showing the chip, as ending hide-all would.
      tourBus.on(TOUR_REVEAL_PANEL_EVENT, () => {
        document.body.innerHTML =
          '<button data-tour="object-list-button"></button>';
      });
      const manager = await startTour([
        {
          id: "open-list",
          title: "Object Browser",
          element: '[data-tour="object-list-button"]',
          onTriggerEvent: "object-list-button",
          waitForElement: 200,
        },
      ]);
      expect(asked).toEqual([undefined]);
      expect(highlighted).toEqual(["Object Browser"]);
      manager.stopTour();
    } finally {
      tourBus.all.clear();
    }
  });

  it("asks for nothing when the anchor is there", async () => {
    const asked: unknown[] = [];
    tourBus.on(TOUR_REVEAL_PANEL_EVENT, (panelId) => asked.push(panelId));
    try {
      document.body.innerHTML =
        '<button data-tour="object-list-button"></button>';
      const manager = await startTour([
        {
          id: "open-list",
          title: "Object Browser",
          element: '[data-tour="object-list-button"]',
        },
      ]);
      expect(asked).toEqual([]);
      manager.stopTour();
    } finally {
      tourBus.all.clear();
    }
  });
});
