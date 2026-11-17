// Per-browser memory for presentation state: which panels are open, column
// widths, a panel's active tab. See codebaseDocumentation/
// PANEL_LAYOUT_PERSISTENCE.md, Part 2.
//
// Rules this module exists to enforce:
//   * It never throws. localStorage can be blocked or full, and what is in it
//     may be corrupt or written by another client version. A read that fails
//     falls back to the caller's default; a write that fails is kept in
//     memory, so the value still reads back for the rest of the session.
//   * Every read is validated by the caller. Nothing trusts a stored shape.
//   * Keys are scoped by user. Logout reloads the page, which discards the
//     stores but not localStorage, so an unscoped key would hand one account's
//     layout to the next person at the browser.
//   * It only touches keys under its own prefix. `nimbus.girderToken` is the
//     user's live session.

import { Ref, effectScope, ref, watch } from "vue";

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

// Values whose write to localStorage failed, by full storage key. They are
// what a later read returns, so a change made with storage blocked or full
// lasts for the session instead of reverting the next time it is read.
const unsavedValues = new Map<string, string>();

/**
 * The stored value for `key` in the current scope, cleaned by `validate`, or
 * null when there is none, it is unreadable, or `validate` rejects it.
 */
export function readUiState<T>(
  key: string,
  validate: (raw: unknown) => T | null,
): T | null {
  const fullKey = storageKey(key);
  try {
    const stored =
      unsavedValues.get(fullKey) ?? window.localStorage.getItem(fullKey);
    return stored == null ? null : validate(JSON.parse(stored));
  } catch {
    return null;
  }
}

/**
 * Store `value` for `key` in the current scope. If storage refuses it, the
 * value is kept in memory and still reads back until the page is reloaded.
 */
export function writeUiState(key: string, value: unknown): void {
  const fullKey = storageKey(key);
  const serialized = JSON.stringify(value);
  try {
    window.localStorage.setItem(fullKey, serialized);
    unsavedValues.delete(fullKey);
  } catch {
    // Blocked or full storage: the value stays in memory for this session.
    unsavedValues.set(fullKey, serialized);
  }
}

export function removeUiState(key: string): void {
  unsavedValues.delete(storageKey(key));
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

// One ref per key, shared by every component that asks for it. For state
// that several instances of a component read and write (which layer rows are
// expanded): with a ref each, every instance would hold its own copy of the
// list and the last one to write would drop the others' changes.
const sharedStates = new Map<string, Ref<unknown>>();
let sharedScope = effectScope(true);

/**
 * `usePersistedUiState`, but the same ref for everyone using `key`. It lives
 * for the page, so it can be called from any component's setup.
 */
export function useSharedPersistedUiState<T>(
  key: string,
  defaultValue: () => T,
  validate: (raw: unknown) => T | null,
): Ref<T> {
  let state = sharedStates.get(key);
  if (!state) {
    state = sharedScope.run(() =>
      usePersistedUiState(key, defaultValue, validate),
    )!;
    sharedStates.set(key, state);
  }
  return state as Ref<T>;
}

/** For tests: drop the shared refs, as a page load would. */
export function forgetSharedUiState(): void {
  sharedScope.stop();
  sharedScope = effectScope(true);
  sharedStates.clear();
}

/** `validate` for a stored boolean. */
export function asStoredBoolean(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/** `validate` for a stored list of strings; anything else in it is dropped. */
export function asStoredStrings(raw: unknown): string[] | null {
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : null;
}
