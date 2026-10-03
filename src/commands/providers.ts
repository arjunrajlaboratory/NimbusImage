import store from "@/store";
import propertyStore from "@/store/properties";
import { ITourMetadata } from "@/store/model";
import { boundKeys } from "@/utils/v-mousetrap";
import { createPathStringFromPathArray } from "@/utils/paths";
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

// Commands derived from data the app already loads. Each provider is a plain
// function read inside the registry's `computed`, so adding a tool, layer,
// snapshot, property or worker image adds its command with no extra wiring.
// None of them reads per-annotation state: these lists stay small.

export interface IProviderContext {
  // True on the dataset view with a dataset loaded — the only place the
  // panels, tools and layers these commands act on are mounted.
  inViewer: () => boolean;
}

/**
 * The hotkey currently bound (via v-mousetrap) with this help-overlay
 * description, as a hint. `boundKeys` holds no handlers, so it can only
 * annotate a command, never run one.
 */
export function hotkeyForDescription(description: string): string | undefined {
  for (const [key, data] of Object.entries(boundKeys.value)) {
    if (data.description === description) {
      return key;
    }
  }
  return undefined;
}

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
          store.setSelectedToolId(tool.id);
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
    return store.layers.map((layer): ICommand => {
      const channelName = dataset?.channelNames.get(layer.channel);
      return {
        id: `layer.toggle.${layer.id}`,
        title: `Toggle layer: ${layer.name}`,
        group: "Layers",
        keywords: channelName ? [channelName, "channel"] : ["channel"],
        description: layer.visible ? "Visible" : "Hidden",
        icon: layer.visible ? "mdi-eye" : "mdi-eye-off",
        hotkey: hotkeyForDescription(`Show/hide layer: ${layer.name}`),
        enabled: ctx.inViewer,
        run: () => store.toggleLayerVisibility(layer.id),
      };
    });
  };
}

export function snapshotCommands(ctx: IProviderContext): TCommandProvider {
  return () =>
    (store.configuration?.snapshots ?? []).map(
      (snapshot): ICommand => ({
        // Snapshots.vue keys a snapshot the same way.
        id: `snapshot.load.${snapshot.datasetViewId}:${snapshot.name}`,
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
        title: `Color by: ${
          propertyStore.getFullNameFromPath(path) ?? path.join(" / ")
        }`,
        group: "Properties",
        keywords: ["color", "colour", "colormap", "property"],
        icon: "mdi-palette",
        enabled: () => ctx.inViewer() && store.isLoggedIn,
        run: () => {
          colorByPropertyRequest.value = pathKey;
          store.setIsColorByPropertyDialogOpen(true);
        },
      };
    });
}

export interface IPanelController {
  isOpen: (id: PanelId) => boolean;
  toggle: (id: PanelId) => void;
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
        keywords: ["panel", "palette", "show", "hide"],
        icon: panel.icon,
        enabled: ctx.inViewer,
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
