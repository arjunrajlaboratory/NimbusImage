import mitt from "mitt";
export const tourBus = mitt();

/**
 * Emitted by the tour manager with a panel id (`data-panel-id` on a
 * FloatingPalette) when a step's anchor is inside a palette that is not
 * showing. App.vue, which owns the palettes, opens it.
 */
export const TOUR_REVEAL_PANEL_EVENT = "tour:reveal-panel";
