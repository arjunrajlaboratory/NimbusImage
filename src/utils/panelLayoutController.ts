// The way to the viewer's panel layout for code that is not under App.vue's
// setup: the AI agent's tools run as plain functions, with no component to
// inject from. App.vue owns the layout (`usePanelLayout`) and registers this
// while it is mounted; everything goes through the same `open` / `close` /
// `applyOpenSet` as a click, so the placement rules and the saving apply.

import { PanelId } from "./panelRegistry";

export interface IPanelLayoutController {
  /** Whether panels can be shown at all: in the dataset viewer, not embedded. */
  inViewer: () => boolean;
  /** Open as a palette or minimized to a chip, in the order opened. */
  openPanels: () => PanelId[];
  /** The open panels that are minimized to a chip. */
  minimizedPanels: () => PanelId[];
  /** "Hide all panels" is on. */
  allHidden: () => boolean;
  /** Whether a panel exists for the open dataset. */
  isAvailable: (id: PanelId) => boolean;
  open: (id: PanelId) => void;
  close: (id: PanelId) => void;
  /** Show exactly these panels. */
  applyOpenSet: (ids: readonly PanelId[]) => void;
  /** The layout as it is now, to hand back to `restoreLayout` later. */
  layoutSnapshot: () => unknown;
  /** Put back a layout from `layoutSnapshot`. One that is not valid: ignored. */
  restoreLayout: (snapshot: unknown) => void;
}

let registered: IPanelLayoutController | null = null;

/** Register the layout's owner. Returns the function that unregisters it. */
export function registerPanelLayoutController(
  controller: IPanelLayoutController,
): () => void {
  registered = controller;
  return () => {
    // Only if it is still this one: a newer owner may have registered.
    if (registered === controller) {
      registered = null;
    }
  };
}

/** The layout's owner, or null when no viewer is mounted. */
export function panelLayoutController(): IPanelLayoutController | null {
  return registered;
}
