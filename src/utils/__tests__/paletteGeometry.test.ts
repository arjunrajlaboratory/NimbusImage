import { describe, it, expect } from "vitest";
import {
  AI_PANEL_CLEAR_X,
  LEFT_COLUMN_PALETTE_WIDTHS,
  LEFT_COLUMN_WIDTH,
  LEFT_PALETTE_CLEAR_X,
  OBJECT_BROWSER_CLEAR_X,
  PALETTE_INSET,
  RIGHT_OF_LEFT_COLUMN,
  rightEdgeClearX,
} from "@/utils/paletteGeometry";

describe("left column geometry", () => {
  /**
   * The column's footprint is its WIDEST member, not the Navigator's width.
   * Taking the Navigator's (380) put the Timelapse palette, anchored just right
   * of the column, 32px on top of Layers (420).
   */
  it("takes the widest left palette, not the first one", () => {
    expect(LEFT_COLUMN_WIDTH).toBe(
      Math.max(...Object.values(LEFT_COLUMN_PALETTE_WIDTHS)),
    );
    expect(LEFT_COLUMN_WIDTH).toBeGreaterThan(
      LEFT_COLUMN_PALETTE_WIDTHS.navigator,
    );
  });

  /**
   * The two derived offsets used to be transcribed separately — 444 computed in
   * App.vue, 446 hardcoded in style.scss — and the 2px between them is what let
   * the Timelapse palette land on top of the selection action panels. They stay
   * different (palette-to-palette gap vs canvas-surface gap) but must both come
   * off the same column width, so a width change moves them together.
   */
  it("derives both clearances from the widest palette, not just each other", () => {
    // Against the palette widths, NOT against LEFT_COLUMN_WIDTH: comparing to
    // the same constant they are built from makes this pass however wrong that
    // constant is, which is exactly the bug it is supposed to catch.
    const columnEdge =
      PALETTE_INSET + Math.max(...Object.values(LEFT_COLUMN_PALETTE_WIDTHS));
    for (const offset of [RIGHT_OF_LEFT_COLUMN, LEFT_PALETTE_CLEAR_X]) {
      // Outside the column (the failure that overlapped Layers) but still
      // adjacent to it rather than adrift.
      expect(offset).toBeGreaterThanOrEqual(columnEdge);
      expect(offset).toBeLessThanOrEqual(columnEdge + 16);
    }
    // Their gaps differ on purpose (palette stacking vs canvas surfaces); what
    // must not happen is the two being derived independently and drifting.
    expect(Math.abs(RIGHT_OF_LEFT_COLUMN - LEFT_PALETTE_CLEAR_X)).toBeLessThan(
      8,
    );
  });
});

describe("rightEdgeClearX", () => {
  it("is just the inset when no right-edge overlay is open", () => {
    expect(rightEdgeClearX({})).toBe(PALETTE_INSET);
    expect(rightEdgeClearX({ objectBrowser: false, aiPanel: false })).toBe(
      PALETTE_INSET,
    );
  });

  it("clears the Object Browser when only it is open", () => {
    expect(rightEdgeClearX({ objectBrowser: true })).toBe(
      OBJECT_BROWSER_CLEAR_X,
    );
  });

  /**
   * The regression this whole function exists for. The offset used to be keyed
   * off the Object Browser alone, via an `object-browser-open` class, so with the
   * AI panel open the selection action panels sat underneath it — `.ai-panel` is
   * `z-index: 2001` against their 1000, and it is mutually exclusive with
   * neither timelapse mode nor the Browser. Measured live at 1684×857: 6 of the
   * two panels' 8 buttons failed `elementFromPoint`, including Deselect All,
   * which is the only non-destructive way to dismiss them.
   */
  it("clears the AI panel when only it is open", () => {
    expect(rightEdgeClearX({ aiPanel: true })).toBe(AI_PANEL_CLEAR_X);
    expect(rightEdgeClearX({ aiPanel: true })).toBeGreaterThan(PALETTE_INSET);
  });

  /**
   * Max, not sum: the overlays share the right edge rather than queueing along
   * it, so summing would push the panels needlessly far over the canvas (and on
   * a narrow viewport, into the Timelapse palette they were moved to avoid).
   */
  it("takes the largest clearance when several are open, never their sum", () => {
    const both = rightEdgeClearX({ objectBrowser: true, aiPanel: true });
    expect(both).toBe(Math.max(OBJECT_BROWSER_CLEAR_X, AI_PANEL_CLEAR_X));
    expect(both).toBeLessThan(OBJECT_BROWSER_CLEAR_X + AI_PANEL_CLEAR_X);
  });
});
