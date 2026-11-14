// Per-browser memory for presentation state: which panels are open, column
// widths, a panel's active tab. See codebaseDocumentation/
// PANEL_LAYOUT_PERSISTENCE.md, Part 2.
//
// Rules this module exists to enforce:
//   * It never throws. localStorage can be blocked or full, and what is in it
//     may be corrupt or written by another client version; every failure
//     falls back to the caller's default and the value lives in memory.
//   * Every read is validated by the caller. Nothing trusts a stored shape.
//   * Keys are scoped by user. Logout reloads the page, which discards the
//     stores but not localStorage, so an unscoped key would hand one account's
//     layout to the next person at the browser.
//   * It only touches keys under its own prefix. `nimbus.girderToken` is the
//     user's live session.

import { Ref, ref, watch } from "vue";

const KEY_PREFIX = "nimbus.ui.";
const ANONYMOUS_SCOPE = "anonymous";

/** Whose state is being read and written: a user id, or "anonymous". */
export const uiStateScope = ref(ANONYMOUS_SCOPE);

export function setUiStateScope(userId: string | null | undefined): void {
  uiStateScope.value = userId || ANONYMOUS_SCOPE;
}

function storageKey(key: string): string {
  return `${KEY_PREFIX}${uiStateScope.value}.${key}`;
}

/**
 * The stored value for `key` in the current scope, cleaned by `validate`, or
 * null when there is none, it is unreadable, or `validate` rejects it.
 */
export function readUiState<T>(
  key: string,
  validate: (raw: unknown) => T | null,
): T | null {
  try {
    const stored = window.localStorage.getItem(storageKey(key));
    return stored === null ? null : validate(JSON.parse(stored));
  } catch {
    return null;
  }
}

/** Store `value` for `key` in the current scope. A failed write is dropped. */
export function writeUiState(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(storageKey(key), JSON.stringify(value));
  } catch {
    // Blocked or full storage: the value stays in memory for this session.
  }
}

export function removeUiState(key: string): void {
  try {
    window.localStorage.removeItem(storageKey(key));
  } catch {
    // Nothing to remove from storage that cannot be reached.
  }
}

/**
 * A ref backed by localStorage. It reads once at creation and again when the
 * scope (the logged-in user) changes, and writes synchronously on change.
 *
 * `validate` returns the cleaned value, or null to fall back to
 * `defaultValue()`. The default is a function so each fallback gets its own
 * object.
 *
 * Call it from a component's setup (or an effect scope) so its watchers are
 * disposed with their owner.
 */
export function usePersistedUiState<T>(
  key: string,
  defaultValue: () => T,
  validate: (raw: unknown) => T | null,
): Ref<T> {
  const load = () => readUiState(key, validate) ?? defaultValue();
  const state = ref(load()) as Ref<T>;
  // Reloading for a new scope must not write the loaded value back, least of
  // all a default over that user's stored one. Both watchers are sync, so the
  // flag brackets exactly the reload's own assignment.
  let isReloading = false;
  watch(
    uiStateScope,
    () => {
      isReloading = true;
      try {
        state.value = load();
      } finally {
        isReloading = false;
      }
    },
    { flush: "sync" },
  );
  watch(
    state,
    (value) => {
      if (!isReloading) {
        writeUiState(key, value);
      }
    },
    { deep: true, flush: "sync" },
  );
  return state;
}
