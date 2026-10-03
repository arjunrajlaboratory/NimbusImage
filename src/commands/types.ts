// The command palette's (⌘K) command model. See
// codebaseDocumentation/COMMAND_PALETTE.md.

export type TCommandGroup =
  | "Tools"
  | "Add tool"
  | "Panels"
  | "Layers"
  | "Snapshots"
  | "Properties"
  | "Actions"
  | "Help";

// Display order of the groups, both for result headers and for the
// empty-query overview.
export const COMMAND_GROUP_ORDER: readonly TCommandGroup[] = [
  "Tools",
  "Add tool",
  "Panels",
  "Layers",
  "Snapshots",
  "Properties",
  "Actions",
  "Help",
];

export interface ICommand {
  // Stable, e.g. "panel.toggle.filtersPanel", "tool.select.<toolId>",
  // "tool.add.worker:<image>". Recently-used memory is keyed on it.
  id: string;
  // What the row shows.
  title: string;
  group: TCommandGroup;
  // Extra match terms (synonyms, tags, channel names).
  keywords?: string[];
  // Secondary line; also matched, at a lower weight.
  description?: string;
  // mdi name, checked against @mdi/font 5.9.55 by mdiIconNames.test.ts.
  icon?: string;
  // Shown as a hint only; the palette never binds it.
  hotkey?: string;
  // Hidden from the palette while this returns false (e.g. requires login,
  // requires the dataset view).
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

// A provider derives commands from live state. Providers are read inside a
// `computed`, so the command list re-derives whenever the state they read
// changes — no event wiring needed when a tool, layer or worker is added.
export type TCommandProvider = () => ICommand[];
