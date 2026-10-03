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

/** "mod+shift+z" → "⌘⇧Z" on a Mac, "Ctrl+Shift+Z" elsewhere. */
export function formatHotkey(binding: string, mac = isMacPlatform()): string {
  const names = mac ? MAC_KEY_NAMES : OTHER_KEY_NAMES;
  const parts = binding
    .split("+")
    .map((part) =>
      names[part]
        ? names[part]
        : part.length === 1
          ? part.toUpperCase()
          : part[0].toUpperCase() + part.slice(1),
    );
  return parts.join(mac ? "" : "+");
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
