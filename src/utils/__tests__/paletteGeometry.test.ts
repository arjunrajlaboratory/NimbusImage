import { describe, it, expect } from "vitest";
import {
  ACTION_PANEL_MAX_WIDTH,
  AI_PANEL_INSET,
  AI_PANEL_WIDTH,
  LEFT_COLUMN_PALETTE_WIDTHS,
  LEFT_COLUMN_WIDTH,
  LEFT_PALETTE_CLEAR_X,
  PALETTE_INSET,
  RIGHT_PALETTE_WIDTHS,
  RIGHT_OF_LEFT_COLUMN,
  PALETTE_GAP,
  TIMELAPSE_PALETTE_RIGHT,
  TIMELAPSE_PALETTE_WIDTH,
  ZONE_MIN_WIDTH,
  actionPanelClearsTimelapsePalette,
  clampZoneWidth,
  leftColumnWidth,
  leftPaletteClearX,
  paletteWidth,
  rightOfLeftColumn,
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

describe("actionPanelClearsTimelapsePalette", () => {
  /**
   * In timelapse mode the selection panels move to the right edge to escape the
   * Timelapse palette (x 444–744). On a narrow viewport the two meet: at 1280px
   * with the Object Browser open — exactly the state "Show tracks" produces — a
   * panel anchored 544px from the right spans x 416–736, inside the palette,
   * which wins on z-index (1006 vs 1000). The caller drops the panels below the
   * palette when this returns false.
   */
  it("reports no clearance at 1280px with the Object Browser open", () => {
    const clear = overlayClearX(RIGHT_PALETTE_WIDTHS.objectBrowser); // 544
    expect(actionPanelClearsTimelapsePalette(1280, clear)).toBe(false);
  });

  it("reports clearance on a wide viewport", () => {
    const clear = overlayClearX(RIGHT_PALETTE_WIDTHS.objectBrowser);
    expect(actionPanelClearsTimelapsePalette(1684, clear)).toBe(true);
  });

  // 1440 is a common laptop width, so the threshold has to be checked, not
  // assumed to sit below anything real.
  it("reports no clearance at 1440px with the Object Browser open", () => {
    const clear = overlayClearX(RIGHT_PALETTE_WIDTHS.objectBrowser);
    expect(actionPanelClearsTimelapsePalette(1440, clear)).toBe(false);
  });

  it("has more room when nothing holds the right edge", () => {
    expect(actionPanelClearsTimelapsePalette(1280, PALETTE_INSET)).toBe(true);
  });

  // The panel must clear the palette's far edge, not its near one.
  it("measures against the palette's right edge", () => {
    expect(TIMELAPSE_PALETTE_RIGHT).toBe(
      RIGHT_OF_LEFT_COLUMN + TIMELAPSE_PALETTE_WIDTH,
    );
    const justEnough =
      TIMELAPSE_PALETTE_RIGHT + PALETTE_GAP + ACTION_PANEL_MAX_WIDTH;
    expect(actionPanelClearsTimelapsePalette(justEnough, 0)).toBe(true);
    expect(actionPanelClearsTimelapsePalette(justEnough - 1, 0)).toBe(false);
  });
});

describe("resizable zones", () => {
  it("keeps each palette's own width until its zone is resized", () => {
    expect(paletteWidth("right", 512, undefined, 1440)).toBe(512);
    expect(paletteWidth("right", 512, 600, 1440)).toBe(600);
    expect(paletteWidth("right", 400, 600, 1440)).toBe(600);
  });

  it("never lets a zone go narrower than its palettes were laid out for", () => {
    expect(ZONE_MIN_WIDTH.left).toBe(
      Math.min(...Object.values(LEFT_COLUMN_PALETTE_WIDTHS)),
    );
    expect(ZONE_MIN_WIDTH.right).toBe(
      Math.min(...Object.values(RIGHT_PALETTE_WIDTHS)),
    );
  });

  it("clamps a zone to its minimum and to a share of the viewport", () => {
    expect(clampZoneWidth("left", 10, 1440)).toBe(ZONE_MIN_WIDTH.left);
    expect(clampZoneWidth("right", 5000, 1440)).toBe(648);
    expect(clampZoneWidth("right", 500.4, 1440)).toBe(500);
  });

  it("clamps a stored width when it is used, not only when it is dragged", () => {
    // Saved on a wide monitor, opened on a laptop.
    expect(paletteWidth("right", 512, 900, 1280)).toBe(576);
    // A viewport too small for the fraction still gets the minimum.
    expect(paletteWidth("left", 420, 900, 500)).toBe(ZONE_MIN_WIDTH.left);
  });

  it("matches the unresized constants when no width is set", () => {
    const column = leftColumnWidth(undefined, 1440);
    expect(column).toBe(LEFT_COLUMN_WIDTH);
    expect(rightOfLeftColumn(column)).toBe(RIGHT_OF_LEFT_COLUMN);
    expect(leftPaletteClearX(column)).toBe(LEFT_PALETTE_CLEAR_X);
  });

  it("moves both left clearances with a resized column", () => {
    const column = leftColumnWidth(500, 1440);
    expect(column).toBe(500);
    expect(rightOfLeftColumn(column)).toBe(PALETTE_INSET + 500 + PALETTE_GAP);
    expect(leftPaletteClearX(column)).toBeGreaterThan(PALETTE_INSET + 500);
  });

  it("asks whether the action panels clear the Timelapse palette where it now is", () => {
    const narrowColumn = rightOfLeftColumn(320) + TIMELAPSE_PALETTE_WIDTH;
    const wideColumn = rightOfLeftColumn(640) + TIMELAPSE_PALETTE_WIDTH;
    expect(actionPanelClearsTimelapsePalette(1280, 16, narrowColumn)).toBe(
      true,
    );
    expect(actionPanelClearsTimelapsePalette(1280, 16, wideColumn)).toBe(false);
  });
});
