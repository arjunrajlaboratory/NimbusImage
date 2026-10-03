import { computed, getCurrentInstance, onBeforeUnmount, shallowRef } from "vue";
import { ICommand, TCommandProvider } from "./types";

// Every source of commands, as providers. A static command registered with
// `useCommand` is just a provider returning that one command, so there is one
// list and one rule for when it re-derives.
const providers = shallowRef<readonly TCommandProvider[]>([]);

/**
 * Add a provider; returns the function that removes it. Prefer
 * `useCommandProvider` / `useCommand` inside components, which remove it on
 * unmount.
 */
export function registerCommandProvider(provider: TCommandProvider) {
  // Replace rather than mutate, so the `computed` below re-runs.
  providers.value = [...providers.value, provider];
  return () => {
    providers.value = providers.value.filter((p) => p !== provider);
  };
}

/**
 * Every registered command, enabled or not, de-duplicated by id (the first
 * registration wins). Re-derives only when a provider's inputs change, never
 * per keystroke; scoring is the only per-keystroke work.
 */
export const allCommands = computed((): ICommand[] => {
  const seen = new Set<string>();
  const commands: ICommand[] = [];
  for (const provider of providers.value) {
    for (const command of provider()) {
      if (seen.has(command.id)) {
        continue;
      }
      seen.add(command.id);
      commands.push(command);
    }
  }
  return commands;
});

/** The commands whose `enabled()` currently allows them. */
export const enabledCommands = computed((): ICommand[] =>
  allCommands.value.filter((command) => command.enabled?.() ?? true),
);

function unregisterOnUnmount(unregister: () => void) {
  if (getCurrentInstance()) {
    onBeforeUnmount(unregister);
  }
}

/**
 * Register a provider for the lifetime of the calling component. Use it for
 * commands derived from state the component owns (App.vue's palette refs).
 */
export function useCommandProvider(provider: TCommandProvider) {
  const unregister = registerCommandProvider(provider);
  unregisterOnUnmount(unregister);
  return unregister;
}

/**
 * Register static action(s) next to the control that performs them, for the
 * lifetime of the calling component. Pass a getter when the title or other
 * fields depend on reactive state.
 */
export function useCommand(
  commands: ICommand | ICommand[] | (() => ICommand | ICommand[]),
) {
  const read = typeof commands === "function" ? commands : () => commands;
  return useCommandProvider(() => {
    const value = read();
    return Array.isArray(value) ? value : [value];
  });
}
