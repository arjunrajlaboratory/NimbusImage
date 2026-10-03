// The viewer's palettes (floating panels) and the rules for how they share the
// screen. App.vue owns the open/closed refs because the template and the
// ResizeObserver stacking bind to them; this module owns everything else about
// a palette, so other features (the command palette, layout persistence) can
// read the same definitions instead of re-listing them.
//
// The Timelapse palette and the AI panel are deliberately absent: their
// visibility is driven by other state (the timelapse mode, an env flag + login).
//
// Placement rules:
//   * Right zone is a mutually-exclusive column. A "primary" (Object Browser /
//     Analysis / Snapshots / Settings) owns it — opening one closes the others.
//     The "companion" (Filters) may share the column, but only alongside one of
//     its `hosts`; any other primary evicts it.
//   * Left zone (Navigator / Layers / Tools) is an independent vertical stack:
//     all three can be open at once and never evict each other.
//   * The two zones are independent of each other.

export type PanelId =
  | "annotationPanel"
  | "filtersPanel"
  | "analysisPanel"
  | "snapshotPanel"
  | "settingsPanel"
  | "navigatorPanel"
  | "toolsPanel"
  | "layersPanel";

export type PanelZone = "left" | "right";

export interface IPanelDefinition {
  id: PanelId;
  // Same string the FloatingPalette header shows.
  title: string;
  // The app-bar toggle's mdi icon.
  icon: string;
  zone: PanelZone;
  role: "primary" | "companion";
  // Companions only: primaries this companion may share the column with. A
  // companion evicts any primary NOT listed here.
  hosts?: PanelId[];
  // Opened on every entry to the dataset view.
  defaultOpen: boolean;
}

export const PANELS: readonly IPanelDefinition[] = [
  // Left stack, in top-to-bottom order.
  {
    id: "navigatorPanel",
    title: "Navigator",
    icon: "mdi-axis-arrow",
    zone: "left",
    role: "primary",
    defaultOpen: true,
  },
  {
    id: "layersPanel",
    title: "Layers",
    icon: "mdi-layers",
    zone: "left",
    role: "primary",
    defaultOpen: true,
  },
  {
    id: "toolsPanel",
    title: "Tools",
    icon: "mdi-tools",
    zone: "left",
    role: "primary",
    defaultOpen: true,
  },
  // Right column, in app-bar order.
  {
    id: "annotationPanel",
    title: "Object Browser",
    icon: "mdi-format-list-bulleted-square",
    zone: "right",
    role: "primary",
    defaultOpen: false,
  },
  // Filters hosts alongside both the Object Browser and the Analysis panel:
  // the Analysis panel's own guidance above the cap is "narrow the filters",
  // which would be self-defeating if opening Filters closed it.
  {
    id: "filtersPanel",
    title: "Filters",
    icon: "mdi-filter-variant",
    zone: "right",
    role: "companion",
    hosts: ["annotationPanel", "analysisPanel"],
    defaultOpen: false,
  },
  {
    id: "analysisPanel",
    title: "Analysis",
    icon: "mdi-chart-scatter-plot",
    zone: "right",
    role: "primary",
    defaultOpen: false,
  },
  {
    id: "snapshotPanel",
    title: "Snapshots",
    icon: "mdi-camera-outline",
    zone: "right",
    role: "primary",
    defaultOpen: false,
  },
  {
    id: "settingsPanel",
    title: "Settings",
    icon: "mdi-tune",
    zone: "right",
    role: "primary",
    defaultOpen: false,
  },
];

const PANELS_BY_ID = new Map<PanelId, IPanelDefinition>(
  PANELS.map((panel) => [panel.id, panel]),
);

/**
 * Each panel's definition by id, for templates: App.vue binds the palette
 * titles and app-bar toggle icons from here, so the "Open X" command and the
 * palette header can't drift apart.
 */
export const PANEL_BY_ID = Object.fromEntries(PANELS_BY_ID) as Readonly<
  Record<PanelId, IPanelDefinition>
>;

export const PANEL_IDS: readonly PanelId[] = PANELS.map((panel) => panel.id);

/**
 * Pure: the open set that results from opening `id` in `open`, with the
 * right-zone primary/companion eviction rules applied. An unknown id leaves
 * the set unchanged (it may come from an older or newer client).
 */
export function applyOpen(
  open: ReadonlySet<PanelId>,
  id: PanelId,
): Set<PanelId> {
  const def = PANELS_BY_ID.get(id);
  const next = new Set(open);
  if (!def) {
    return next;
  }
  // Only the right zone has mutex/companion relationships.
  if (def.zone === "right") {
    for (const otherId of open) {
      const other = PANELS_BY_ID.get(otherId);
      if (otherId === id || !other || other.zone !== "right") {
        continue;
      }
      if (def.role === "primary") {
        // A new primary clears every other primary, plus any companion that
        // doesn't host with it.
        if (other.role === "primary" || !(other.hosts ?? []).includes(id)) {
          next.delete(otherId);
        }
      } else if (
        other.role === "primary" &&
        !(def.hosts ?? []).includes(otherId)
      ) {
        // A companion evicts any primary that isn't one of its hosts.
        next.delete(otherId);
      }
    }
  }
  next.add(id);
  return next;
}
