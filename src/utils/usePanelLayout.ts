// The reactive owner of the viewer's panel layout: one state object for which
// palettes are open or minimized, one for how the zones are arranged, and the
// rules for remembering both. App.vue binds its palettes to the refs this
// returns. See codebaseDocumentation/PANEL_LAYOUT_PERSISTENCE.md.
//
// What is remembered, per user, in localStorage (`@/utils/uiState`):
//   * `layout.last`            the layout most recently used, anywhere
//   * `layout.byConfiguration` the layout last used in each collection
//   * `layout.arrangement`     zone widths and the left stack's order
//
// Nothing here is written to the server, so it works the same for anonymous
// and read-only users and cannot race a configuration save.

import { computed, ref, shallowRef, watch, WritableComputedRef } from "vue";
import {
  IPanelDefinition,
  PANELS,
  PANEL_IDS,
  PanelId,
  PanelZone,
} from "./panelRegistry";
import {
  IPanelLayout,
  completeLeftOrder,
  defaultArrangement,
  defaultLayout,
  layoutWithAdded,
  layoutWithClosed,
  layoutWithMinimized,
  layoutWithOpen,
  layoutWithOpenSet,
  serializeLayout,
  validateArrangement,
  validateLayout,
} from "./panelLayout";
import {
  readUiState,
  uiStateScope,
  usePersistedUiState,
  writeUiState,
} from "./uiState";

const LAST_LAYOUT_KEY = "layout.last";
const LAYOUT_BY_CONFIGURATION_KEY = "layout.byConfiguration";
const ARRANGEMENT_KEY = "layout.arrangement";

// Most recently used collections whose layout is kept. Bounds the stored list
// for someone who opens thousands; a collection that falls off the end opens
// with the user's last layout instead of its own.
export const MAX_REMEMBERED_CONFIGURATIONS = 200;

// [configurationId, layout], oldest first. An array rather than an object so
// the order is the recency order whatever the ids look like.
type TLayoutByConfiguration = [string, unknown][];

function validateLayoutByConfiguration(
  raw: unknown,
): TLayoutByConfiguration | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  return raw.filter(
    (entry): entry is [string, unknown] =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "string",
  );
}

function readLayoutByConfiguration(): TLayoutByConfiguration {
  return (
    readUiState(LAYOUT_BY_CONFIGURATION_KEY, validateLayoutByConfiguration) ??
    []
  );
}

/** A collection default or workspace: only its open set is taken. */
function presetLayout(raw: unknown): IPanelLayout | null {
  const layout = validateLayout(raw);
  return layout && layoutWithOpenSet(layout.open);
}

export interface IPanelLayoutOptions {
  /** In the dataset viewer with its chrome (not the embed). */
  inViewer: () => boolean;
  /** The open collection's id, or null until it is known. */
  configurationId: () => string | null;
  /** The collection's `defaultPanelLayout`, unvalidated. */
  collectionDefault: () => unknown;
  /** Whether a panel can be shown for the open dataset. Default: always. */
  isAvailable?: (id: PanelId) => boolean;
}

export function usePanelLayout(options: IPanelLayoutOptions) {
  const isAvailable = options.isAvailable ?? (() => true);

  // Replaced whole on every change, never mutated in place, so a change
  // cannot update `open` and leave `minimized` behind.
  const layout = shallowRef<IPanelLayout>(layoutWithOpenSet([]));
  const arrangement = usePersistedUiState(
    ARRANGEMENT_KEY,
    defaultArrangement,
    validateArrangement,
  );
  // "Hide all panels" is a view of the layout, not a change to it: it is not
  // remembered and the layout underneath is what comes back.
  const chromeHidden = ref(false);

  // The serialized layout that storage already holds for where we are. A
  // restore sets it, so restoring never writes the layout straight back.
  let persisted = serializeLayout(layout.value);

  // One visit to the viewer, from entry until the route leaves or the user
  // changes. Null outside the viewer.
  let stay: null | {
    scope: string;
    // The user changed the layout before the collection was known. Their
    // change must win over the collection's layout when it arrives.
    changedBeforeConfiguration: boolean;
  } = null;

  function show(next: IPanelLayout) {
    persisted = serializeLayout(next);
    layout.value = next;
    chromeHidden.value = false;
  }

  function save() {
    writeUiState(LAST_LAYOUT_KEY, layout.value);
    const configurationId = options.configurationId();
    if (configurationId) {
      writeUiState(
        LAYOUT_BY_CONFIGURATION_KEY,
        [
          ...readLayoutByConfiguration().filter(
            ([id]) => id !== configurationId,
          ),
          [configurationId, layout.value],
        ].slice(-MAX_REMEMBERED_CONFIGURATIONS),
      );
    }
  }

  // The layout this user or this collection has for `configurationId`:
  // their own for it first, then the collection's default.
  function layoutForConfiguration(configurationId: string) {
    const own = readLayoutByConfiguration().find(
      ([id]) => id === configurationId,
    );
    return (
      (own && validateLayout(own[1])) ??
      presetLayout(options.collectionDefault())
    );
  }

  // Restore once per (user, collection). The collection can arrive after the
  // route does, so a visit may restore twice: first the user's last layout,
  // then the collection's own once it is known.
  watch(
    () =>
      options.inViewer()
        ? `${uiStateScope.value}|${options.configurationId() ?? ""}`
        : null,
    (token) => {
      if (token === null) {
        stay = null;
        chromeHidden.value = false;
        return;
      }
      const configurationId = options.configurationId();
      const forConfiguration = configurationId
        ? layoutForConfiguration(configurationId)
        : null;
      if (!stay || stay.scope !== uiStateScope.value) {
        stay = { scope: uiStateScope.value, changedBeforeConfiguration: false };
        show(
          forConfiguration ??
            readUiState(LAST_LAYOUT_KEY, validateLayout) ??
            defaultLayout(),
        );
      } else if (stay.changedBeforeConfiguration) {
        // Their change stands, and is now this collection's layout too.
        save();
      } else if (forConfiguration) {
        show(forConfiguration);
      }
      if (configurationId) {
        stay.changedBeforeConfiguration = false;
      }
    },
    { immediate: true, flush: "sync" },
  );

  // Sync, so a change is stored before anything else can happen to the page.
  // Leaving the viewer never changes the layout (visibility is derived from
  // `inViewer`), so there is no "all closed" for this to save by mistake.
  watch(
    () => serializeLayout(layout.value),
    (serialized) => {
      if (!options.inViewer() || serialized === persisted) {
        return;
      }
      persisted = serialized;
      save();
    },
    { flush: "sync" },
  );

  function change(next: IPanelLayout) {
    if (stay && !options.configurationId()) {
      stay.changedBeforeConfiguration = true;
    }
    layout.value = next;
  }

  /** In the open set, shown or minimized. */
  function isOpen(id: PanelId): boolean {
    return options.inViewer() && layout.value.open.includes(id);
  }

  /** Actually on screen as a palette. */
  function isVisible(id: PanelId): boolean {
    return (
      isOpen(id) &&
      !chromeHidden.value &&
      !layout.value.minimized.includes(id) &&
      isAvailable(id)
    );
  }

  /** Open `id` and show it. Refused outside the viewer (and in the embed). */
  function open(id: PanelId) {
    if (!options.inViewer()) {
      return;
    }
    chromeHidden.value = false;
    change(layoutWithOpen(layout.value, id));
  }

  function close(id: PanelId) {
    change(layoutWithClosed(layout.value, id));
  }

  /** Close a palette that is showing; otherwise open, restore or reveal it. */
  function toggle(id: PanelId) {
    if (isVisible(id)) {
      close(id);
    } else {
      open(id);
    }
  }

  function minimize(id: PanelId) {
    change(layoutWithMinimized(layout.value, id));
  }

  /** Show exactly `ids` (a workspace or a collection default). */
  function applyOpenSet(ids: readonly PanelId[]) {
    if (!options.inViewer()) {
      return;
    }
    chromeHidden.value = false;
    change(layoutWithOpenSet(ids));
  }

  /** Back to the collection's default, or the app's when it has none. */
  function reset() {
    if (!options.inViewer()) {
      return;
    }
    chromeHidden.value = false;
    change(presetLayout(options.collectionDefault()) ?? defaultLayout());
  }

  function toggleChromeHidden() {
    if (options.inViewer()) {
      chromeHidden.value = !chromeHidden.value;
    }
  }

  function setZoneWidth(zone: PanelZone, width: number | null) {
    const widths = { ...arrangement.value.widths };
    if (width === null) {
      delete widths[zone];
    } else {
      widths[zone] = Math.round(width);
    }
    arrangement.value = { ...arrangement.value, widths };
  }

  function setLeftOrder(order: readonly PanelId[]) {
    arrangement.value = {
      ...arrangement.value,
      leftOrder: completeLeftOrder(order),
    };
  }

  // One writable ref per panel for `v-model` and the template. Reading gives
  // "on screen"; writing true adds the panel as is (the placement rules are
  // `open`'s job), writing false closes it.
  const visible = Object.fromEntries(
    PANEL_IDS.map((id) => [
      id,
      computed({
        get: () => isVisible(id),
        set: (value: boolean) => {
          if (value) {
            change(layoutWithAdded(layout.value, id));
          } else {
            close(id);
          }
        },
      }),
    ]),
  ) as Record<PanelId, WritableComputedRef<boolean>>;

  /** The panels shown as chips, in registry order. */
  const minimizedPanels = computed<IPanelDefinition[]>(() =>
    options.inViewer() && !chromeHidden.value
      ? PANELS.filter(
          (panel) =>
            layout.value.minimized.includes(panel.id) && isAvailable(panel.id),
        )
      : [],
  );

  return {
    layout,
    arrangement,
    chromeHidden,
    visible,
    minimizedPanels,
    isOpen,
    isVisible,
    open,
    close,
    toggle,
    minimize,
    applyOpenSet,
    reset,
    toggleChromeHidden,
    setZoneWidth,
    setLeftOrder,
  };
}
