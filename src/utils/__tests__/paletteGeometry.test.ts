import { describe, it, expect } from "vitest";
import {
  AI_PANEL_INSET,
  AI_PANEL_WIDTH,
  LEFT_COLUMN_PALETTE_WIDTHS,
  LEFT_COLUMN_WIDTH,
  LEFT_PALETTE_CLEAR_X,
  PALETTE_INSET,
  RIGHT_PALETTE_WIDTHS,
  RIGHT_OF_LEFT_COLUMN,
  overlayClearX,
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
  it("is just the inset when nothing is open", () => {
    expect(rightEdgeClearX([])).toBe(PALETTE_INSET);
    expect(
      rightEdgeClearX([
        { open: false, width: RIGHT_PALETTE_WIDTHS.objectBrowser },
        { open: false, width: AI_PANEL_WIDTH, inset: AI_PANEL_INSET },
      ]),
    ).toBe(PALETTE_INSET);
  });

  it("clears a single open overlay", () => {
    expect(
      rightEdgeClearX([
        { open: true, width: RIGHT_PALETTE_WIDTHS.objectBrowser },
      ]),
    ).toBe(overlayClearX(RIGHT_PALETTE_WIDTHS.objectBrowser));
  });

  /**
   * The regression this function exists for. The offset was originally keyed off
   * the Object Browser alone (an `object-browser-open` class), so with the AI
   * panel open the selection action panels sat underneath it — `.ai-panel` is
   * `z-index: 2001` against their 1000, and it is mutually exclusive with neither
   * timelapse mode nor the Browser. Measured live at 1684×857: 6 of the two
   * panels' 8 buttons failed `elementFromPoint`, including Deselect All, the only
   * non-destructive way to dismiss them.
   */
  it("clears the AI panel, which uses its own larger inset", () => {
    expect(
      rightEdgeClearX([
        { open: true, width: AI_PANEL_WIDTH, inset: AI_PANEL_INSET },
      ]),
    ).toBe(overlayClearX(AI_PANEL_WIDTH, AI_PANEL_INSET));
  });

  /**
   * The SECOND round of the same bug. Fixing the AI panel by adding one more
   * named boolean still ignored Settings, Snapshots, Filters and the Analyze
   * drawer — every one of them right-anchored, none mutually exclusive with
   * timelapse mode, all outranking the selection panels on z-index. Each of
   * these must move the panels on its own.
   */
  it.each([
    ["objectBrowser", RIGHT_PALETTE_WIDTHS.objectBrowser],
    ["filters", RIGHT_PALETTE_WIDTHS.filters],
    ["settings", RIGHT_PALETTE_WIDTHS.settings],
    ["snapshots", RIGHT_PALETTE_WIDTHS.snapshots],
    ["analyze", RIGHT_PALETTE_WIDTHS.analyze],
  ])("clears %s on its own", (_name, width) => {
    expect(rightEdgeClearX([{ open: true, width }])).toBeGreaterThan(
      PALETTE_INSET,
    );
    expect(rightEdgeClearX([{ open: true, width }])).toBe(overlayClearX(width));
  });

  /**
   * Max, not sum: the overlays share the right edge rather than queueing along
   * it, so summing would push the panels needlessly far over the canvas — and on
   * a narrow viewport, into the Timelapse palette they were moved to avoid.
   */
  it("takes the largest clearance when several are open, never their sum", () => {
    const overlays = [
      { open: true, width: RIGHT_PALETTE_WIDTHS.objectBrowser },
      { open: true, width: RIGHT_PALETTE_WIDTHS.filters },
      { open: true, width: AI_PANEL_WIDTH, inset: AI_PANEL_INSET },
    ];
    const expected = Math.max(
      overlayClearX(RIGHT_PALETTE_WIDTHS.objectBrowser),
      overlayClearX(RIGHT_PALETTE_WIDTHS.filters),
      overlayClearX(AI_PANEL_WIDTH, AI_PANEL_INSET),
    );
    expect(rightEdgeClearX(overlays)).toBe(expected);
    expect(rightEdgeClearX(overlays)).toBeLessThan(
      overlays.reduce((sum, o) => sum + overlayClearX(o.width, o.inset), 0),
    );
  });

  it("ignores the closed ones when picking the max", () => {
    // A closed wide overlay must not win over an open narrow one.
    expect(
      rightEdgeClearX([
        { open: false, width: AI_PANEL_WIDTH, inset: AI_PANEL_INSET },
        { open: true, width: RIGHT_PALETTE_WIDTHS.filters },
      ]),
    ).toBe(overlayClearX(RIGHT_PALETTE_WIDTHS.filters));
  });
});
