// The viewer's panel layout as data: which palettes are open or minimized
// (`IPanelLayout`, remembered per collection) and how the zones are arranged
// (`IPanelArrangement`, one per user). Pure functions only; the reactive
// owner is `usePanelLayout`. See codebaseDocumentation/
// PANEL_LAYOUT_PERSISTENCE.md.

import {
  PANELS,
  PANEL_BY_ID,
  PanelId,
  PanelZone,
  applyOpen,
} from "./panelRegistry";

export interface IPanelLayout {
  version: 1;
  // The open set in the order opened, not a boolean per panel, so a panel
  // added later falls back to its registry `defaultOpen`. Includes minimized
  // panels: a minimized panel is open, shown as a chip.
  open: PanelId[];
  // Always a subset of `open`.
  minimized: PanelId[];
}

export interface IPanelArrangement {
  version: 1;
  // Every left-zone panel, top to bottom.
  leftOrder: PanelId[];
  // A zone's width in px once the user has resized it. Absent: each palette
  // keeps its own default width.
  widths: Partial<Record<PanelZone, number>>;
}

const LEFT_PANEL_IDS: readonly PanelId[] = PANELS.filter(
  (panel) => panel.zone === "left",
).map((panel) => panel.id);

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

// A stored value from a later format is not this one with extra fields: it
// reads as nothing stored. A value with no version (a hand-written workspace
// or collection default) is read as the current format.
function isReadableVersion(version: unknown): boolean {
  return version === undefined || version === 1;
}

/** The known panel ids in `raw`, in order, once each. Not an array: null. */
function knownPanelIds(raw: unknown): PanelId[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  return [
    ...new Set(
      raw.filter(
        (id): id is PanelId => typeof id === "string" && id in PANEL_BY_ID,
      ),
    ),
  ];
}

/** The layout with every `defaultOpen` panel open. */
export function defaultLayout(): IPanelLayout {
  return layoutWithOpenSet(
    PANELS.filter((panel) => panel.defaultOpen).map((panel) => panel.id),
  );
}

/**
 * A layout showing exactly `ids`, as far as the placement rules allow: the
 * ids are opened one at a time through `applyOpen`, so a list with two
 * right-zone primaries (a hand-edited or stale layout) keeps the last one.
 */
export function layoutWithOpenSet(ids: readonly PanelId[]): IPanelLayout {
  let open = new Set<PanelId>();
  for (const id of ids) {
    open = applyOpen(open, id);
  }
  return { version: 1, open: [...open], minimized: [] };
}

/**
 * A stored layout, cleaned: unknown ids (an older or newer client) are
 * dropped and the placement rules are re-applied. Null when `raw` is not a
 * layout at all.
 */
export function validateLayout(raw: unknown): IPanelLayout | null {
  if (!isRecord(raw) || !isReadableVersion(raw.version)) {
    return null;
  }
  const openIds = knownPanelIds(raw.open);
  if (!openIds) {
    return null;
  }
  const layout = layoutWithOpenSet(openIds);
  // Optional: a collection default and a workspace carry only `open`.
  const minimized = knownPanelIds(raw.minimized) ?? [];
  layout.minimized = minimized.filter((id) => layout.open.includes(id));
  return layout;
}

/** `layout` with `id` opened and shown; its zone's rules evict as needed. */
export function layoutWithOpen(
  layout: IPanelLayout,
  id: PanelId,
): IPanelLayout {
  const open = [...applyOpen(new Set(layout.open), id)];
  return {
    version: 1,
    open,
    minimized: layout.minimized.filter(
      (other) => other !== id && open.includes(other),
    ),
  };
}

export function layoutWithClosed(
  layout: IPanelLayout,
  id: PanelId,
): IPanelLayout {
  return {
    version: 1,
    open: layout.open.filter((other) => other !== id),
    minimized: layout.minimized.filter((other) => other !== id),
  };
}

/** `layout` with the open panel `id` collapsed to a chip. Closed: unchanged. */
export function layoutWithMinimized(
  layout: IPanelLayout,
  id: PanelId,
): IPanelLayout {
  if (!layout.open.includes(id) || layout.minimized.includes(id)) {
    return layout;
  }
  return { ...layout, minimized: [...layout.minimized, id] };
}

/** One string per distinct layout, for change detection and comparison. */
export function serializeLayout(layout: IPanelLayout): string {
  return JSON.stringify([layout.open, layout.minimized]);
}

export function defaultArrangement(): IPanelArrangement {
  return { version: 1, leftOrder: LEFT_PANEL_IDS.slice(), widths: {} };
}

/**
 * `order` as a complete left-zone order: unknown and right-zone ids dropped,
 * and any left panel it omits (one added since it was stored) appended in
 * registry order.
 */
export function completeLeftOrder(order: readonly PanelId[]): PanelId[] {
  const known = order.filter((id) => LEFT_PANEL_IDS.includes(id));
  return [...known, ...LEFT_PANEL_IDS.filter((id) => !known.includes(id))];
}

export function validateArrangement(raw: unknown): IPanelArrangement | null {
  if (!isRecord(raw) || !isReadableVersion(raw.version)) {
    return null;
  }
  const widths: IPanelArrangement["widths"] = {};
  if (isRecord(raw.widths)) {
    for (const zone of ["left", "right"] as const) {
      const width = raw.widths[zone];
      if (typeof width === "number" && Number.isFinite(width) && width > 0) {
        widths[zone] = width;
      }
    }
  }
  return {
    version: 1,
    leftOrder: completeLeftOrder(knownPanelIds(raw.leftOrder) ?? []),
    widths,
  };
}

/**
 * The left order after `draggedId` is dropped with its center at
 * `draggedCenter` (px from the top): it goes just before the first showing
 * palette whose center is lower, or to the end when none is.
 */
export function leftOrderAfterDrop(
  order: readonly PanelId[],
  draggedId: PanelId,
  draggedCenter: number,
  showing: readonly { id: PanelId; center: number }[],
): PanelId[] {
  const others = completeLeftOrder(order).filter((id) => id !== draggedId);
  const below = showing
    .filter((panel) => panel.id !== draggedId && panel.center > draggedCenter)
    .map((panel) => panel.id);
  const index = others.findIndex((id) => below.includes(id));
  const at = index === -1 ? others.length : index;
  return [...others.slice(0, at), draggedId, ...others.slice(at)];
}
