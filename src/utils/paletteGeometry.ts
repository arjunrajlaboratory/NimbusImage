/**
 * Single source of truth for floating-palette geometry and the clearances
 * derived from it.
 *
 * These numbers used to be written three times over: the `:width` bindings on
 * each `<floating-palette>` in App.vue, a `LEFT_COLUMN_WIDTH = 420` copy of the
 * Layers width used to place the Timelapse palette, and
 * `--nimbus-left-palette-clear-x: 446px` hardcoded in style.scss. Both copies
 * have already gone wrong: a stale one put the Timelapse palette 32px on top of
 * Layers, and 444 landing 2px from 446 is what drew the selection action panels
 * underneath the Timelapse palette.
 *
 * App.vue projects the derived values into CSS custom properties on `<v-app>`,
 * so the stylesheets read the same numbers this module computes rather than
 * their own transcription of them.
 */

/** Inset of a palette from the viewport edge it is anchored to. */
export const PALETTE_INSET = 16;

/** Gap between two adjacent or stacked palettes. */
export const PALETTE_GAP = 8;

/**
 * Gap a canvas-anchored surface keeps from a palette's edge.
 *
 * Deliberately NOT `PALETTE_GAP`: the bottom-left button cluster, the progress
 * bars and the selection panels were tuned to 10px against the palette column,
 * and palette-to-palette stacking to 8px. The two were previously the same
 * number written twice with different values, which read as a bug; they are
 * separate on purpose.
 */
export const CANVAS_SURFACE_GAP = 10;

/**
 * Widths of the left-column palettes. All three, because the column's footprint
 * is the widest of them and not the Navigator's — assuming otherwise is the
 * mistake that overlapped Layers.
 */
export const LEFT_COLUMN_PALETTE_WIDTHS = {
  navigator: 380,
  layers: 420,
  tools: 380,
} as const;

/**
 * Widths of the right-edge palettes. `FloatingPalette` defaults to `right: 16`
 * with no `left`, so EVERY palette that omits `:left` lands here — which is all
 * of these. Analyze is a `v-navigation-drawer location="right"` rather than a
 * palette, and sits flush to the edge (see `RIGHT_EDGE_OVERLAY_INSETS`).
 */
export const RIGHT_PALETTE_WIDTHS = {
  objectBrowser: 512,
  filters: 480,
  settings: 480,
  snapshots: 480,
  analyze: 480,
  analysis: 560,
} as const;

/** Kept as its own name: the Object Browser is referenced by several callers. */
export const OBJECT_BROWSER_WIDTH = RIGHT_PALETTE_WIDTHS.objectBrowser;

/**
 * AiPanel.vue's fixed footprint. Its own scoped CSS owns these values; they are
 * mirrored here only so the surfaces that must clear it can be positioned
 * without measuring the DOM. Keep in sync with `.ai-panel` in AiPanel.vue.
 */
export const AI_PANEL_WIDTH = 520;
export const AI_PANEL_INSET = 20;

/** Footprint of the whole left column: its inset plus its widest member. */
export const LEFT_COLUMN_WIDTH = Math.max(
  ...Object.values(LEFT_COLUMN_PALETTE_WIDTHS),
);

/** Left anchor for a palette placed immediately right of the left column. */
export const RIGHT_OF_LEFT_COLUMN =
  PALETTE_INSET + LEFT_COLUMN_WIDTH + PALETTE_GAP;

/** Width of the Timelapse palette, which is anchored there. */
export const TIMELAPSE_PALETTE_WIDTH = 300;

/** x of the Timelapse palette's right edge. */
export const TIMELAPSE_PALETTE_RIGHT =
  RIGHT_OF_LEFT_COLUMN + TIMELAPSE_PALETTE_WIDTH;

/**
 * `max-width` of the selection action panels, from their scoped CSS. Used as the
 * conservative bound when asking whether they fit somewhere — they are
 * `width: max-content`, so the real width is usually smaller, but a placement
 * decision must hold for the widest content they can hold.
 */
export const ACTION_PANEL_MAX_WIDTH = 320;

/** Top of the action panels when nothing forces them lower. */
export const ACTION_PANEL_TOP = 72;

/**
 * Vertical distance from the annotation action panel's top to the connection
 * panel's, when both are shown. AnnotationActionPanel has a fixed six-button
 * body, so its height is deterministic; measured live at 223px.
 */
export const STACKED_ACTION_PANEL_OFFSET = 232;

/**
 * Does the right-anchored action panel clear the Timelapse palette horizontally?
 *
 * In timelapse mode the panels move to the right edge to get out from under that
 * palette. On a narrow viewport the two meet in the middle: at 1280px with the
 * Object Browser also open (exactly what "Show tracks" produces) a panel anchored
 * 544px from the right has its right edge at x=736, inside the palette's 444–744,
 * and the palette wins on z-index (1006 vs 1000). Below roughly 1500px there is
 * no horizontal placement that clears both, so the caller drops the panels below
 * the palette instead.
 */
export function actionPanelClearsTimelapsePalette(
  viewportWidth: number,
  rightClearX: number,
): boolean {
  const panelLeft = viewportWidth - rightClearX - ACTION_PANEL_MAX_WIDTH;
  return panelLeft >= TIMELAPSE_PALETTE_RIGHT + PALETTE_GAP;
}

/**
 * "Safe left" for a canvas-anchored surface while any left palette is open.
 * Exposed as `--nimbus-left-palette-clear-x`.
 */
export const LEFT_PALETTE_CLEAR_X =
  PALETTE_INSET + LEFT_COLUMN_WIDTH + CANVAS_SURFACE_GAP;

/**
 * One right-edge overlay's footprint.
 *
 * `inset` defaults to `PALETTE_INSET` because that is `FloatingPalette`'s own
 * default (`right: 16` whenever `left` is unset). The only exception is the AI
 * panel, whose scoped CSS uses 20.
 */
export interface IRightEdgeOverlay {
  open: boolean;
  width: number;
  inset?: number;
}

/**
 * Insets for the overlays that don't use `FloatingPalette`'s default.
 *
 * The Analyze drawer is absent on purpose: it is not an overlay at all. A
 * `v-navigation-drawer location="right"` shifts the layout, narrowing the
 * container the action panels are positioned inside, so it needs no clearance —
 * giving it one double-counts and moves them left instead of right.
 */
export const RIGHT_EDGE_OVERLAY_INSETS = {
  aiPanel: AI_PANEL_INSET,
} as const;

/** How far from the right edge ONE overlay's far side sits, plus a gap. */
export function overlayClearX(width: number, inset = PALETTE_INSET): number {
  return inset + width + PALETTE_INSET;
}

/**
 * How far from the right edge a surface must sit to clear every right-edge
 * overlay that is currently open.
 *
 * Takes the largest clearance rather than summing: the overlays share the right
 * edge, they don't queue along it. Returns the bare inset when nothing is open.
 *
 * Takes a LIST rather than named booleans. The named-boolean version knew about
 * the Object Browser and the AI panel and silently ignored Settings, Snapshots
 * and Filters — all right-anchored, none mutually exclusive with timelapse mode,
 * each outranking the selection panels on z-index (1006 vs their 1000). Naming
 * the occupants in the signature is what let three of them be forgotten; a list
 * makes "did you pass all of them?" a question the caller must answer.
 *
 * Height is deliberately ignored. The AI panel is bottom-anchored and 680px
 * tall, so on a very tall viewport it sits below the surfaces that consult this
 * and the offset is unnecessary — but applying it anyway only moves them further
 * over empty canvas, whereas measuring would mean reading layout on every
 * resize to save nothing a user would notice.
 */
export function rightEdgeClearX(overlays: IRightEdgeOverlay[]): number {
  return Math.max(
    PALETTE_INSET,
    ...overlays
      .filter((overlay) => overlay.open)
      .map((overlay) => overlayClearX(overlay.width, overlay.inset)),
  );
}
