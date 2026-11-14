import { describe, it, expect, afterEach } from "vitest";
import { panelRevealRequest } from "./tour";

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
