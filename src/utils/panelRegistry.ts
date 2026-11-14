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
//     Analysis / Transcripts / Snapshots / Settings) owns it — opening one closes the others.
//     The "companion" (Filters) may share the column, but only alongside one of
//     its `hosts`; any other primary evicts it.
//   * Left zone (Navigator / Layers / Tools) is an independent vertical stack:
//     all three can be open at once and never evict each other.
//   * The two zones are independent of each other.

export type PanelId =
  | "annotationPanel"
  | "filtersPanel"
  | "analysisPanel"
  | "transcriptsPanel"
  | "snapshotPanel"
  | "settingsPanel"
  | "navigatorPanel"
  | "toolsPanel"
  | "layersPanel";

export type PanelZone = "left" | "right";

// The facts a panel's status depends on. Small and cheap on purpose: these
// are read reactively on every change, so they are counts and flags the
// stores already keep, never something computed over the annotations.
export interface IPanelContext {
  // Filters narrowing the object set, as the Filters panel shows them.
  activeFilterCount: number;
  // Gates narrowing the object set, as the Analysis panel shows them.
  activeAnalysisGateCount: number;
  // The dataset has a transcript store, or the lookup is running or failed
  // (so the failure can be read and retried from the panel).
  transcriptsReachable: boolean;
  // A job finished successfully while the Object Browser was not showing,
  // so it holds objects or measurements the user has not seen. Cleared when
  // the browser is shown and when the dataset changes.
  hasUnseenJobResults: boolean;
}

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
  // What users call the panel; the "Open X" command's aliases.
  aliases: string[];
  // A short status shown on the panel's app-bar toggle and on its chip while
  // it is minimized, so what a closed panel is doing stays visible. Null:
  // nothing to show.
  badge?: (context: IPanelContext) => string | null;
  // Whether the panel exists for the open dataset. Omitted: always. An
  // unavailable panel is hidden, with its toggle, command and chip; the
  // layout that says it is open is left alone.
  available?: (context: IPanelContext) => boolean;
  // Whether the panel holds something new that the user has not looked at.
  // While true and the panel is not on screen, its toggle and chip carry an
  // accent. This only points; nothing opens by itself. Keep the rules few
  // and causal (the user did something, and its result is in this panel):
  // an accent that is often on is an accent nobody reads.
  relevant?: (context: IPanelContext) => boolean;
}

/** A count as badge text: nothing for zero, capped so it fits the toggle. */
export function countBadge(count: number): string | null {
  if (count <= 0) {
    return null;
  }
  return count > 9 ? "9+" : `${count}`;
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
    aliases: ["navigation", "position", "dimensions"],
  },
  {
    id: "layersPanel",
    title: "Layers",
    icon: "mdi-layers",
    zone: "left",
    role: "primary",
    defaultOpen: true,
    aliases: ["channels", "contrast"],
  },
  {
    id: "toolsPanel",
    title: "Tools",
    icon: "mdi-tools",
    zone: "left",
    role: "primary",
    defaultOpen: true,
    aliases: ["toolset"],
  },
  // Right column, in app-bar order.
  {
    id: "annotationPanel",
    title: "Object Browser",
    icon: "mdi-format-list-bulleted-square",
    zone: "right",
    role: "primary",
    defaultOpen: false,
    aliases: [
      "objects",
      "object list",
      "annotations",
      "annotation list",
      "list",
      "table",
    ],
    // The one accent so far: a worker or measurement the user started has
    // finished, and its results are listed here.
    relevant: (context) => context.hasUnseenJobResults,
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
    aliases: ["filter"],
    // Filters apply with the panel closed, so the count is how the user can
    // tell the object set is narrowed.
    badge: (context) => countBadge(context.activeFilterCount),
  },
  {
    id: "analysisPanel",
    title: "Analysis",
    icon: "mdi-chart-scatter-plot",
    zone: "right",
    role: "primary",
    defaultOpen: false,
    aliases: ["measurements", "properties", "plots", "charts"],
    // Gates also apply with the panel closed and are restored from the saved
    // configuration. The Filters badge cannot cover them: each badge counts
    // only what its own panel can show.
    badge: (context) => countBadge(context.activeAnalysisGateCount),
  },
  // Only offered for a dataset with a registered transcript store.
  {
    id: "transcriptsPanel",
    title: "Transcripts",
    icon: "mdi-dots-hexagon",
    zone: "right",
    role: "primary",
    defaultOpen: false,
    aliases: ["genes", "spatial"],
    available: (context) => context.transcriptsReachable,
  },
  {
    id: "snapshotPanel",
    title: "Snapshots",
    icon: "mdi-camera-outline",
    zone: "right",
    role: "primary",
    defaultOpen: false,
    aliases: ["bookmarks", "views"],
  },
  {
    id: "settingsPanel",
    title: "Settings",
    icon: "mdi-tune",
    zone: "right",
    role: "primary",
    defaultOpen: false,
    aliases: ["preferences", "options", "display settings"],
  },
];

// A workspace is a named set of open panels for one kind of work, applied in
// one step from the command palette. It names only what is open: widths and
// the left stack's order stay the user's own. Each set must already satisfy
// the placement rules below (at most one right-zone primary, Filters only
// with a host); panelRegistry.test.ts checks that.
export interface IWorkspace {
  id: string;
  title: string;
  // What it is for, shown under the command.
  description: string;
  open: PanelId[];
  aliases: string[];
}

export const WORKSPACES: readonly IWorkspace[] = [
  {
    id: "annotate",
    title: "Annotate",
    description: "Navigator, Layers and Tools, for drawing and segmenting",
    open: ["navigatorPanel", "layersPanel", "toolsPanel"],
    aliases: ["draw", "segment", "default layout"],
  },
  {
    id: "analyze",
    title: "Analyze",
    description:
      "Layers, Filters and the Object Browser, for working through objects",
    open: ["layersPanel", "filtersPanel", "annotationPanel"],
    aliases: ["objects", "table", "browse objects"],
  },
  {
    id: "plot",
    title: "Plot",
    description: "Layers, Filters and Analysis, for plots and gates",
    open: ["layersPanel", "filtersPanel", "analysisPanel"],
    aliases: ["scatter", "histogram", "gate"],
  },
  {
    id: "review",
    title: "Review",
    description: "Navigator and Snapshots, for stepping through saved views",
    open: ["navigatorPanel", "snapshotPanel"],
    aliases: ["present", "bookmarks"],
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

export function panelBadge(id: PanelId, context: IPanelContext): string | null {
  return PANELS_BY_ID.get(id)?.badge?.(context) ?? null;
}

export function isPanelRelevant(id: PanelId, context: IPanelContext): boolean {
  return PANELS_BY_ID.get(id)?.relevant?.(context) ?? false;
}

export function isPanelAvailable(id: PanelId, context: IPanelContext): boolean {
  return PANELS_BY_ID.get(id)?.available?.(context) ?? true;
}

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
