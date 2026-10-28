import { ICommand, TCommandGroup } from "./types";

// Palette commands for boolean settings ("Show minimap" / "Hide minimap"),
// declared as a table next to the switches they mirror. The title names what
// running the command will do, so it flips with the setting.

export interface IToggleEntry {
  id: string;
  // Read and write the setting, usually the component's own v-model computed.
  setting: { value: boolean };
  // Titles for running the command while the setting is off / on.
  turnOn: string;
  turnOff: string;
  // Match terms for both directions; they must not assert either state.
  keywords?: string[];
  // Match terms only while running it turns the setting on / off
  // ("filtered" only while it turns filtering on).
  turnOnKeywords?: string[];
  turnOffKeywords?: string[];
  icon?: string;
  enabled?: () => boolean;
}

export function toggleCommands(
  entries: readonly IToggleEntry[],
  options: {
    group?: TCommandGroup;
    // A gate for every entry (e.g. `useInViewer()`), ANDed with each
    // entry's own `enabled`.
    when?: () => boolean;
  } = {},
): ICommand[] {
  const { group = "Actions", when } = options;
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.setting.value ? entry.turnOff : entry.turnOn,
    group,
    keywords: [
      ...(entry.keywords ?? []),
      ...((entry.setting.value
        ? entry.turnOffKeywords
        : entry.turnOnKeywords) ?? []),
      "setting",
      "toggle",
    ],
    icon: entry.icon ?? "mdi-toggle-switch-outline",
    enabled: () => (when?.() ?? true) && (entry.enabled?.() ?? true),
    run: () => {
      entry.setting.value = !entry.setting.value;
    },
  }));
}
