import { boundKeys } from "@/utils/v-mousetrap";

// Display helpers for Mousetrap key strings ("mod+shift+z", "tab", "1").

export function isMacPlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
  );
}

const MAC_KEY_NAMES: Record<string, string> = {
  mod: "⌘",
  command: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
};

const OTHER_KEY_NAMES: Record<string, string> = {
  mod: "Ctrl",
  command: "Ctrl",
  meta: "Meta",
  ctrl: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

function formatKey(key: string, names: Record<string, string>): string {
  if (names[key]) {
    return names[key];
  }
  return key.length <= 1
    ? key.toUpperCase()
    : key[0].toUpperCase() + key.slice(1);
}

function formatCombo(combo: string, mac: boolean): string {
  const names = mac ? MAC_KEY_NAMES : OTHER_KEY_NAMES;
  // Split on "+" separators only, so the plus key itself survives:
  // "+" → ["+"], "ctrl++" → ["ctrl", "+"].
  const keys = combo.split(/\+(?=.)/);
  return keys.map((key) => formatKey(key, names)).join(mac ? "" : "+");
}

/**
 * "mod+shift+z" → "⌘⇧Z" on a Mac, "Ctrl+Shift+Z" elsewhere. A Mousetrap
 * sequence ("g i") keeps its steps apart.
 */
export function formatHotkey(binding: string, mac = isMacPlatform()): string {
  return binding
    .split(" ")
    .filter(Boolean)
    .map((combo) => formatCombo(combo, mac))
    .join(" then ");
}

/**
 * The palette's own toggle (Mousetrap "mod+k"): ⌘K on a Mac, Ctrl+K
 * elsewhere, with no other modifier.
 */
export function isPaletteToggleKey(
  event: KeyboardEvent,
  mac = isMacPlatform(),
): boolean {
  const mod = mac ? event.metaKey : event.ctrlKey;
  return (
    mod &&
    !event.altKey &&
    !event.shiftKey &&
    (mac ? !event.ctrlKey : !event.metaKey) &&
    event.key.toLowerCase() === "k"
  );
}

/**
 * `key` as a hint if v-mousetrap currently binds it with this help-overlay
 * description, else nothing. `boundKeys` holds no handlers, so it can only
 * annotate a command, never run one; checking it keeps a hint from outliving
 * a binding changed in another component.
 */
export function boundHotkey(
  key: string,
  description: string,
): string | undefined {
  return boundKeys.value?.[key]?.description === description ? key : undefined;
}
