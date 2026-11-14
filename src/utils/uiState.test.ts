import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { effectScope } from "vue";
import {
  readUiState,
  removeUiState,
  setUiStateScope,
  usePersistedUiState,
  writeUiState,
} from "./uiState";

const asNumber = (raw: unknown) => (typeof raw === "number" ? raw : null);

describe("uiState", () => {
  let scope: ReturnType<typeof effectScope>;

  beforeEach(() => {
    window.localStorage.clear();
    setUiStateScope(null);
    scope = effectScope();
  });

  afterEach(() => {
    scope.stop();
    vi.restoreAllMocks();
  });

  it("round-trips a value under its own prefix, scoped to the user", () => {
    writeUiState("width", 420);
    expect(readUiState("width", asNumber)).toBe(420);
    expect(window.localStorage.getItem("nimbus.ui.anonymous.width")).toBe(
      "420",
    );

    setUiStateScope("user-1");
    expect(readUiState("width", asNumber)).toBeNull();
    writeUiState("width", 500);
    expect(window.localStorage.getItem("nimbus.ui.user-1.width")).toBe("500");

    setUiStateScope(null);
    expect(readUiState("width", asNumber)).toBe(420);
  });

  it("reads corrupt JSON and a rejected shape as nothing stored", () => {
    window.localStorage.setItem("nimbus.ui.anonymous.width", "{not json");
    expect(readUiState("width", asNumber)).toBeNull();
    window.localStorage.setItem("nimbus.ui.anonymous.width", '"wide"');
    expect(readUiState("width", asNumber)).toBeNull();
  });

  it("does not throw when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readUiState("width", asNumber)).toBeNull();
    expect(() => writeUiState("width", 1)).not.toThrow();
    expect(() => removeUiState("width")).not.toThrow();
  });

  it("removes only the named key", () => {
    window.localStorage.setItem("nimbus.girderToken", "session");
    writeUiState("width", 1);
    removeUiState("width");
    expect(readUiState("width", asNumber)).toBeNull();
    expect(window.localStorage.getItem("nimbus.girderToken")).toBe("session");
  });

  it("a persisted ref starts from storage and writes its changes", () => {
    writeUiState("width", 300);
    const width = scope.run(() =>
      usePersistedUiState("width", () => 100, asNumber),
    )!;
    expect(width.value).toBe(300);
    width.value = 350;
    expect(readUiState("width", asNumber)).toBe(350);
  });

  it("a persisted ref falls back to the default when validation rejects", () => {
    window.localStorage.setItem("nimbus.ui.anonymous.width", '"wide"');
    const width = scope.run(() =>
      usePersistedUiState("width", () => 100, asNumber),
    )!;
    expect(width.value).toBe(100);
  });

  it("a persisted ref keeps working in memory when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    const width = scope.run(() =>
      usePersistedUiState("width", () => 100, asNumber),
    )!;
    width.value = 250;
    expect(width.value).toBe(250);
  });

  it("a persisted ref reloads for a new user without overwriting their value", () => {
    setUiStateScope("user-2");
    writeUiState("width", 700);
    setUiStateScope(null);

    const width = scope.run(() =>
      usePersistedUiState("width", () => 100, asNumber),
    )!;
    width.value = 200;

    setUiStateScope("user-2");
    expect(width.value).toBe(700);
    expect(window.localStorage.getItem("nimbus.ui.user-2.width")).toBe("700");

    // A user with nothing stored gets the default, and it is not written.
    setUiStateScope("user-3");
    expect(width.value).toBe(100);
    expect(window.localStorage.getItem("nimbus.ui.user-3.width")).toBeNull();

    setUiStateScope(null);
    expect(width.value).toBe(200);
  });
});
