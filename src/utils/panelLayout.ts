// The viewer's panel layout as data: which palettes are open
// (`IPanelLayout`, remembered per collection) and how the zones are arranged
// (`IPanelArrangement`, one per user). Pure functions only; the reactive
// owner is `usePanelLayout`. See codebaseDocumentation/
// PANEL_LAYOUT_PERSISTENCE.md.

import {
  PANELS,
  isPanelId,
  PanelId,
  PanelZone,
  applyOpen,
} from "./panelRegistry";

export interface IPanelLayout {
  version: 1;
  // The open set in the order opened, not a boolean per panel, so a panel
  // added later falls back to its registry `defaultOpen`.
  open: PanelId[];
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
  return [...new Set(raw.filter(isPanelId))];
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
  return { version: 1, open: [...open] };
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
  return layoutWithOpenSet(openIds);
}

/** `layout` with `id` opened and shown; its zone's rules evict as needed. */
export function layoutWithOpen(
  layout: IPanelLayout,
  id: PanelId,
): IPanelLayout {
  return { version: 1, open: [...applyOpen(new Set(layout.open), id)] };
}

export function layoutWithClosed(
  layout: IPanelLayout,
  id: PanelId,
): IPanelLayout {
  return { version: 1, open: layout.open.filter((other) => other !== id) };
}

/** One string per distinct layout, for change detection and comparison. */
export function serializeLayout(layout: IPanelLayout): string {
  return JSON.stringify(layout.open);
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

/**
 * The left order after `id` moves one place up (-1) or down (1) among the
 * palettes that are showing: it swaps with the showing palette next to it,
 * so one key press is always one visible step. At the end of the stack:
 * unchanged.
 */
export function leftOrderAfterStep(
  order: readonly PanelId[],
  id: PanelId,
  direction: -1 | 1,
  showing: readonly PanelId[],
): PanelId[] {
  const next = completeLeftOrder(order);
  const stack = next.filter((other) => other === id || showing.includes(other));
  const neighbor = stack[stack.indexOf(id) + direction];
  if (neighbor === undefined) {
    return next;
  }
  const from = next.indexOf(id);
  const to = next.indexOf(neighbor);
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
