import { describe, it, expect, afterEach } from "vitest";
import { panelRevealRequest, tourStepAlreadyDone } from "./tour";

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
