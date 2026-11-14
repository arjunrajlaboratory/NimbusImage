import mitt from "mitt";
export const tourBus = mitt();

/**
 * Emitted by the tour manager when a step's anchor is mounted but not
 * showing. The payload is the id of the palette that holds it
 * (`data-panel-id` on a FloatingPalette), or undefined when it is hidden some
 * other way. App.vue, which owns the palettes, opens that palette, or ends
 * "hide all panels".
 */
export const TOUR_REVEAL_PANEL_EVENT = "tour:reveal-panel";
