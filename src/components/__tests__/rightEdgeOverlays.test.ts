import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A source-text test, deliberately.
 *
 * `rightEdgeClearX` is a pure function and its own unit tests cover it fully —
 * but the bug it exists for was never in the function. It was in the CALLER:
 * App.vue passed two of the six overlays that hold the right edge, so the
 * selection action panels were re-anchored out from under the Timelapse palette
 * and straight under whichever of the other four happened to be open. Reverting
 * the caller to its two-overlay version leaves every `paletteGeometry` test
 * green, which is exactly why this file exists.
 *
 * The failure mode is "someone adds a right-anchored palette and doesn't think
 * about the clearance list" — a coupling between two places in one file that no
 * behavioural test can see, because the new palette doesn't exist yet when the
 * test is written. Scanning the source is the only thing that catches it.
 *
 * `FloatingPalette` anchors right (`right: 16`) whenever `left` is unset, so
 * "omits `:left`" is the same question as "holds the right edge".
 */
const APP_VUE = readFileSync(resolve(__dirname, "../../App.vue"), "utf8");

/** `v-model` names of every <floating-palette> that does not set `:left`. */
function rightAnchoredPaletteModels(): string[] {
  const models: string[] = [];
  // Each element from "<floating-palette" up to the closing ">" of the open tag.
  const openTags = APP_VUE.match(/<floating-palette[\s\S]*?>/g) ?? [];
  for (const tag of openTags) {
    if (/:left=/.test(tag)) {
      continue;
    }
    const model = tag.match(/v-model="([A-Za-z0-9_]+)"/);
    if (model) {
      models.push(model[1]);
    }
  }
  return models;
}

/** The `rightEdgeClearX([...])` argument list, as source text. */
function clearanceListSource(): string {
  const start = APP_VUE.indexOf("rightEdgeClearX([");
  expect(start).toBeGreaterThan(-1);
  const end = APP_VUE.indexOf("])", start);
  expect(end).toBeGreaterThan(start);
  return APP_VUE.slice(start, end);
}

describe("right-edge overlay clearance", () => {
  it("finds the right-anchored palettes at all", () => {
    // Guards the scan itself: a regex that matches nothing would make every
    // assertion below vacuously true.
    const models = rightAnchoredPaletteModels();
    expect(models.length).toBeGreaterThanOrEqual(4);
    expect(models).toContain("annotationPanel");
  });

  it("passes every right-anchored palette to rightEdgeClearX", () => {
    const list = clearanceListSource();
    for (const model of rightAnchoredPaletteModels()) {
      expect(
        list,
        `${model} anchors to the right edge but is missing from the ` +
          `rightEdgeClearX([...]) list, so the selection action panels will be ` +
          `drawn underneath it in timelapse mode`,
      ).toContain(`${model}.value`);
    }
  });

  it("accounts for the AI panel, which is not a FloatingPalette", () => {
    // `position: fixed; right: 20px` at z-index 2001, so the palette scan above
    // cannot see it — and it is the overlay that caused the original regression.
    expect(clearanceListSource()).toContain("aiPanelOpen.value");
  });

  /**
   * The Analyze drawer must stay OUT, and that is a deduction from measurement,
   * not an oversight. A `v-navigation-drawer location="right"` shifts the layout
   * rather than floating over it, and the action panels are `position: absolute`
   * inside `.image` — which the drawer narrows. Measured with it open: container
   * 0–1204 and the panel at 533–708 (= 1204 − 496 − 175), i.e. a clearance for it
   * moves the panels LEFT, back under the Timelapse palette at 444–744.
   */
  it("does not give the layout-shifting Analyze drawer a clearance", () => {
    expect(clearanceListSource()).not.toContain("analyzePanel.value");
  });

  it("does not pass left-anchored palettes", () => {
    // Navigator / Layers / Tools / Timelapse sit on the LEFT; offsetting the
    // panels from the right edge for those would push them into the canvas for
    // no reason, and the Timelapse palette is the thing they are fleeing.
    const list = clearanceListSource();
    for (const model of ["navigatorPanel", "layersPanel", "toolsPanel"]) {
      expect(list).not.toContain(`${model}.value`);
    }
  });
});
