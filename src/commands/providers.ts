import store from "@/store";
import { selectTool } from "@/actions/operations";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import { MAX_DISPLAYED_PROPERTY_PATHS } from "@/store/constants";
import { ITourMetadata } from "@/store/model";
import { boundHotkey } from "./hotkeys";
import { createPathStringFromPathArray, findIndexOfPath } from "@/utils/paths";
import { snapshotKey } from "@/utils/snapshotKey";
import { PANELS, PanelId } from "@/utils/panelRegistry";
import {
  buildToolTypeSelection,
  buildToolTypeSubmenus,
  categoryName,
} from "@/tools/creation/toolTypeCatalog";
import {
  colorByPropertyRequest,
  snapshotLoadRequest,
  toolCreationRequest,
} from "./requests";
import { ICommand, TCommandProvider } from "./types";
import { IProviderContext } from "./context";

// Commands derived from data the app already loads. Each provider is a plain
// function read inside the registry's `computed`, so adding a tool, layer,
// snapshot, property or worker image adds its command with no extra wiring.
// None of them reads per-annotation state: these lists stay small.

export function toolCommands(ctx: IProviderContext): TCommandProvider {
  return () =>
    store.tools.map(
      (tool): ICommand => ({
        id: `tool.select.${tool.id}`,
        title: `Use tool: ${tool.name}`,
        group: "Tools",
        keywords: [
          ...(tool.values?.annotation?.tags ?? []),
          tool.template?.name ?? "",
        ],
        icon: "mdi-cursor-default-click-outline",
        hotkey: tool.hotkey ?? undefined,
        enabled: () => ctx.inViewer() && store.isLoggedIn,
        run: () => {
          store.requestPaletteOpen(["toolsPanel"]);
          selectTool(tool.id);
        },
      }),
    );
}

/**
 * "Add tool: …" for every card in the Add-new-tool dialog: worker images (from
 * their Docker labels) and template tools. Running one opens tool creation
 * pre-selected, never a silently built tool: worker tools need channel and
 * parameter choices, and the dialog is where the user makes them.
 */
export function addToolCommands(ctx: IProviderContext): TCommandProvider {
  return () => {
    const submenus = buildToolTypeSubmenus(
      store.toolTemplateList,
      propertyStore.workerImageList,
      store.availableToolShapes,
    );
    const commands: ICommand[] = [];
    for (const submenu of submenus) {
      const category = categoryName(submenu);
      for (const item of submenu.items) {
        const augmented = { ...item, submenu };
        commands.push({
          id: submenu.isWorker
            ? `tool.add.worker:${item.image}`
            : `tool.add.template:${submenu.template.type}:${item.text}`,
          title: `Add tool: ${item.text}…`,
          group: "Add tool",
          keywords: ["new", "create", category],
          description: item.description || category,
          icon: submenu.isWorker ? "mdi-auto-fix" : "mdi-plus",
          enabled: () => ctx.inViewer() && store.isLoggedIn,
          run: () => {
            store.requestPaletteOpen(["toolsPanel"]);
            toolCreationRequest.value = buildToolTypeSelection(augmented);
          },
        });
      }
    }
    return commands;
  };
}

export function layerCommands(ctx: IProviderContext): TCommandProvider {
  return () => {
    const dataset = store.dataset;
    return store.layers.map((layer, index): ICommand => {
      const channelName = dataset?.channelNames.get(layer.channel);
      return {
        id: `layer.toggle.${layer.id}`,
        // Named for what it will do, like every state-flipping command; the
        // eye icon shows the current state. A "Visible"/"Hidden" description
        // was searchable, so "visible dapi" found (and hid) a visible layer.
        title: `${layer.visible ? "Hide" : "Show"} layer: ${layer.name}`,
        group: "Layers",
        keywords: [...(channelName ? [channelName] : []), "channel", "toggle"],
        icon: layer.visible ? "mdi-eye" : "mdi-eye-off",
        // DisplayLayer binds each layer's position (1-based) as its toggle;
        // checking the description too keeps a stale binding from showing.
        // Looking the key up by description alone would give every layer
        // sharing a name the first one's key.
        hotkey: boundHotkey(`${index + 1}`, `Show/hide layer: ${layer.name}`),
        // Single mode keeps exactly one layer visible: toggling the visible
        // one leaves it visible, so "Hide layer" would do nothing there.
        enabled: () =>
          ctx.inViewer() && !(store.layerMode === "single" && layer.visible),
        run: () => store.toggleLayerVisibility(layer.id),
      };
    });
  };
}

export function snapshotCommands(ctx: IProviderContext): TCommandProvider {
  return () =>
    (store.configuration?.snapshots ?? []).map(
      (snapshot): ICommand => ({
        id: `snapshot.load.${snapshotKey(snapshot)}`,
        title: `Go to snapshot: ${snapshot.name}`,
        group: "Snapshots",
        keywords: snapshot.tags ?? [],
        description: snapshot.description || undefined,
        icon: "mdi-camera-outline",
        enabled: ctx.inViewer,
        run: () => {
          store.requestPaletteOpen(["snapshotPanel"]);
          snapshotLoadRequest.value = snapshot;
        },
      }),
    );
}

export function propertyCommands(ctx: IProviderContext): TCommandProvider {
  return () =>
    propertyStore.computedPropertyPaths.map((path): ICommand => {
      const pathKey = createPathStringFromPathArray(path);
      return {
        id: `property.colorBy.${pathKey}`,
        title: `Color by: ${propertyLabel(path)}`,
        group: "Properties",
        keywords: ["color", "colour", "colormap", "property"],
        icon: "mdi-palette",
        // Same rule as the generic "Color objects by property…" command and
        // its app-bar button: anyone in the viewer may open the dialog, whose
        // Apply is what requires a login.
        enabled: ctx.inViewer,
        run: () => {
          colorByPropertyRequest.value = pathKey;
          store.setIsColorByPropertyDialogOpen(true);
        },
      };
    });
}

function propertyLabel(path: string[]) {
  return propertyStore.getFullNameFromPath(path) ?? path.join(" / ");
}

/**
 * "Show in object list: …" / "Hide from object list: …" for every property
 * value path, so "list area" finds the Area columns. Same toggle as the
 * Object Browser's column picker; the save it schedules is skipped for
 * anonymous viewers, so no login gate. "Show in" is withheld once the list
 * holds MAX_DISPLAYED_PROPERTY_PATHS columns, where the toggle adds nothing.
 */
export function propertyListCommands(ctx: IProviderContext): TCommandProvider {
  return () => {
    const displayed = propertyStore.displayedPropertyPaths;
    const isFull = displayed.length >= MAX_DISPLAYED_PROPERTY_PATHS;
    return propertyStore.computedPropertyPaths.map((path): ICommand => {
      const isShown = findIndexOfPath(path, displayed) >= 0;
      return {
        id: `property.list.${createPathStringFromPathArray(path)}`,
        title: `${isShown ? "Hide from" : "Show in"} object list: ${propertyLabel(path)}`,
        group: "Properties",
        // Only the direction it will go: "add column area" must not find
        // the command that removes it.
        keywords: [
          "column",
          "table",
          "browser",
          "property",
          isShown ? "remove" : "add",
        ],
        icon: isShown
          ? "mdi-table-column-remove"
          : "mdi-table-column-plus-after",
        enabled: () => ctx.inViewer() && (isShown || !isFull),
        run: () => {
          if (!isShown) {
            // The Objects tab, not just the panel: on the Measurements or
            // Connections tab the new column would stay out of sight.
            store.openAnnotationBrowserTab("objects");
          }
          propertyStore.togglePropertyPathVisibility(path);
        },
      };
    });
  };
}

/**
 * "Add filter: …" / "Stop filtering by: …" for every property value path: adds or
 * removes that property's histogram filter, as the Filters panel's picker does.
 */
export function propertyFilterCommands(
  ctx: IProviderContext,
): TCommandProvider {
  return () => {
    const filtered = filterStore.filterPaths;
    return propertyStore.computedPropertyPaths.map((path): ICommand => {
      const isFiltered = findIndexOfPath(path, filtered) >= 0;
      return {
        id: `property.filter.${createPathStringFromPathArray(path)}`,
        // Removing never says "filter": "filter area" must not find (and run)
        // the command that removes Area's filter.
        title: isFiltered
          ? `Stop filtering by: ${propertyLabel(path)}`
          : `Add filter: ${propertyLabel(path)}`,
        group: "Properties",
        keywords: [
          "range",
          "histogram",
          "threshold",
          "property",
          isFiltered ? "unfilter" : "filter",
        ],
        icon: isFiltered
          ? "mdi-filter-remove-outline"
          : "mdi-filter-plus-outline",
        enabled: ctx.inViewer,
        run: () => {
          if (!isFiltered) {
            store.requestPaletteOpen(["filtersPanel"]);
          }
          filterStore.togglePropertyPathFiltering(path);
        },
      };
    });
  };
}

export interface IPanelController {
  isOpen: (id: PanelId) => boolean;
  toggle: (id: PanelId) => void;
  // Panels that only exist for some datasets (Transcripts); omitted → all.
  isAvailable?: (id: PanelId) => boolean;
}

/**
 * "Open X" / "Close X" for every registered palette. The controller is the
 * owner of the open/closed state (App.vue); toggling through it applies the
 * same companion rules as the app-bar buttons.
 */
export function panelCommands(
  ctx: IProviderContext,
  controller: IPanelController,
): TCommandProvider {
  return () =>
    PANELS.map((panel): ICommand => {
      const isOpen = controller.isOpen(panel.id);
      return {
        id: `panel.toggle.${panel.id}`,
        title: `${isOpen ? "Close" : "Open"} ${panel.title}`,
        group: "Panels",
        // The verb of what running it will do: "show filters" must not find
        // "Close Filters".
        keywords: ["panel", "palette", isOpen ? "hide" : "show"],
        aliases: [panel.title, ...panel.aliases],
        icon: panel.icon,
        enabled: () =>
          ctx.inViewer() && (controller.isAvailable?.(panel.id) ?? true),
        run: () => controller.toggle(panel.id),
      };
    });
}

/** "Tour: …" for every tour that can start from the current route. */
export function tourCommands(
  tours: () => Record<string, ITourMetadata>,
  isAvailable: (tour: ITourMetadata) => boolean,
  start: (tourId: string) => void,
): TCommandProvider {
  return () =>
    Object.entries(tours())
      .filter(([, tour]) => isAvailable(tour))
      .map(
        ([tourId, tour]): ICommand => ({
          id: `tour.start.${tourId}`,
          title: `Tour: ${tour.name}`,
          group: "Help",
          keywords: ["tour", "tutorial", "guide", "help", tour.category ?? ""],
          icon: "mdi-map-marker-path",
          run: () => start(tourId),
        }),
      );
}
