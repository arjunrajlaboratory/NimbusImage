import store from "@/store";
import { IProviderContext } from "@/commands/context";
import { TCommandGroup } from "@/commands/types";
import { goToLocation, setVisibleLayers } from "./operations";

// A declarative list of palette actions that take an argument typed in the
// query ("z 12", "show only dapi"). src/actions/parse.ts instantiates them per
// keystroke. Each names the agent tool that performs the same operation
// (`agentTool`), so the two dispatchers stay in step; both call the shared
// operations in ./operations.ts.

export type TDimension = "xy" | "z" | "time";

export interface IChoice {
  value: string;
  label: string;
  // Extra match terms, scored with the same machinery as palette commands.
  keywords?: string[];
}

export type TParam =
  // A 1-based number as the Navigator sliders show it (the user types 12 for
  // the 12th entry); run() receives the 0-based index.
  | { kind: "index"; dimension: TDimension }
  | { kind: "choice"; choices: () => IChoice[] };

export interface IParamAction {
  id: string;
  group: TCommandGroup;
  icon: string;
  // Normalized trigger phrases ("go to z"); the longest matching one wins.
  phrases: string[];
  param: TParam;
  // Name of the agent tool (executors.ts registry) doing the same operation.
  agentTool: "set_location" | "set_layer_visibility";
  // Row title for the user-facing value (1-based number, or a choice label).
  title: (label: string) => string;
  // Same rule as the layer commands: only on the viewer.
  enabled: (ctx: IProviderContext) => boolean;
  run: (value: number | string) => void | Promise<void>;
}

export const DIMENSION_LABELS: Record<TDimension, string> = {
  xy: "XY",
  z: "Z",
  time: "time",
};

function indexAction(
  dimension: TDimension,
  icon: string,
  phrases: string[],
): IParamAction {
  return {
    id: `navigate.${dimension}`,
    group: "Navigate",
    icon,
    phrases,
    param: { kind: "index", dimension },
    agentTool: "set_location",
    title: (label) => `Go to ${DIMENSION_LABELS[dimension]} ${label}`,
    enabled: (ctx) => ctx.inViewer(),
    run: async (value) => {
      await goToLocation({ [dimension]: value as number });
    },
  };
}

export const PARAM_ACTIONS: readonly IParamAction[] = [
  indexAction("z", "mdi-layers-outline", [
    "z",
    "go to z",
    "slice",
    "go to slice",
  ]),
  indexAction("time", "mdi-clock-outline", [
    "t",
    "time",
    "timepoint",
    "frame",
    "go to t",
    "go to time",
    "go to timepoint",
    "go to frame",
  ]),
  indexAction("xy", "mdi-crosshairs-gps", [
    "xy",
    "position",
    "go to xy",
    "go to position",
  ]),
  {
    id: "layers.showOnly",
    group: "Layers",
    icon: "mdi-eye-outline",
    phrases: ["show only", "only", "solo", "isolate"],
    param: {
      kind: "choice",
      choices: () =>
        store.layers.map((layer) => {
          const channelName = store.dataset?.channelNames.get(layer.channel);
          return {
            value: layer.id,
            label: layer.name,
            keywords: channelName ? [channelName, "channel"] : ["channel"],
          };
        }),
    },
    agentTool: "set_layer_visibility",
    title: (label) => `Show only layer: ${label}`,
    enabled: (ctx) => ctx.inViewer(),
    run: async (layerId) => {
      await setVisibleLayers([layerId as string]);
      // Same rule as toggleLayerVisibility: persist only when logged in.
      if (store.isLoggedIn) {
        await store.syncConfiguration("layers");
      }
    },
  },
];
