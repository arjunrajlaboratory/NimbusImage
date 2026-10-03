import { describe, it, expect } from "vitest";
import { formatHotkey } from "./hotkeys";

describe("formatHotkey", () => {
  it("renders Mac modifiers as symbols", () => {
    expect(formatHotkey("mod+shift+z", true)).toBe("⌘⇧Z");
    expect(formatHotkey("mod+k", true)).toBe("⌘K");
  });

  it("renders other platforms with names", () => {
    expect(formatHotkey("mod+shift+z", false)).toBe("Ctrl+Shift+Z");
  });

  it("capitalizes named keys", () => {
    expect(formatHotkey("tab", false)).toBe("Tab");
    expect(formatHotkey("1", true)).toBe("1");
  });

  it("keeps the plus key instead of throwing on it", () => {
    expect(formatHotkey("+", false)).toBe("+");
    expect(formatHotkey("ctrl++", false)).toBe("Ctrl++");
    expect(formatHotkey("mod++", true)).toBe("⌘+");
  });

  it("keeps the steps of a sequence apart", () => {
    expect(formatHotkey("g i", false)).toBe("G then I");
  });
});
