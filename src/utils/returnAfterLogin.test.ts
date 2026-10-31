import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  MAX_AGE_MS,
  hasReturnTo,
  isInAppPath,
  saveReturnTo,
  takeReturnTo,
} from "./returnAfterLogin";

describe("returnAfterLogin", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.useRealTimers());

  it("returns once to a saved in-app path", () => {
    saveReturnTo("/oauth/consent?request=abc");
    expect(hasReturnTo()).toBe(true);
    expect(takeReturnTo()).toBe("/oauth/consent?request=abc");
    expect(takeReturnTo()).toBeNull();
  });

  it("accepts only in-app router paths", () => {
    for (const bad of [
      "https://evil.example/",
      "//evil.example/x",
      "/\\evil.example",
      "javascript:alert(1)",
      "/x y",
      "relative",
      "/",
      "",
      null,
    ]) {
      expect(isInAppPath(bad), String(bad)).toBe(false);
      saveReturnTo(bad as any);
      expect(takeReturnTo()).toBeNull();
    }
  });

  it("ignores planted or stale values", () => {
    sessionStorage.setItem(
      "nimbus.returnTo",
      JSON.stringify({ path: "https://evil.example", savedAt: Date.now() }),
    );
    expect(takeReturnTo()).toBeNull();
    vi.useFakeTimers();
    saveReturnTo("/oauth/consent?request=abc");
    vi.advanceTimersByTime(MAX_AGE_MS + 1);
    expect(hasReturnTo()).toBe(false);
    expect(takeReturnTo()).toBeNull();
  });
});
