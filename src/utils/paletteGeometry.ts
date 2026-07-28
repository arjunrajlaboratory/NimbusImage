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

/** Width of the Object Browser palette, which anchors to the right edge. */
export const OBJECT_BROWSER_WIDTH = 512;

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

/**
 * "Safe left" for a canvas-anchored surface while any left palette is open.
 * Exposed as `--nimbus-left-palette-clear-x`.
 */
export const LEFT_PALETTE_CLEAR_X =
  PALETTE_INSET + LEFT_COLUMN_WIDTH + CANVAS_SURFACE_GAP;

/** Right offset that clears the Object Browser. */
export const OBJECT_BROWSER_CLEAR_X =
  PALETTE_INSET + OBJECT_BROWSER_WIDTH + PALETTE_INSET;

/** Right offset that clears the AI panel. */
export const AI_PANEL_CLEAR_X = AI_PANEL_INSET + AI_PANEL_WIDTH + PALETTE_INSET;

/**
 * How far from the right edge a surface must sit to clear every right-edge
 * overlay that is currently open.
 *
 * Takes the largest clearance rather than summing: the overlays share the right
 * edge, they don't queue along it. Returns the bare inset when nothing is open.
 *
 * Height is deliberately ignored. The AI panel is bottom-anchored and 680px
 * tall, so on a very tall viewport it sits below the surfaces that consult this
 * and the offset is unnecessary — but applying it anyway only moves them further
 * over empty canvas, whereas measuring would mean reading layout on every
 * resize to save nothing a user would notice.
 */
export function rightEdgeClearX(open: {
  objectBrowser?: boolean;
  aiPanel?: boolean;
}): number {
  return Math.max(
    PALETTE_INSET,
    open.objectBrowser ? OBJECT_BROWSER_CLEAR_X : 0,
    open.aiPanel ? AI_PANEL_CLEAR_X : 0,
  );
}
