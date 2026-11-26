import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { effectScope } from "vue";
import {
  readUiState,
  removeUiState,
  setUiStateScope,
  asStoredBoolean,
  asStoredStrings,
  forgetSharedUiState,
  usePersistedUiState,
  useSharedPersistedUiState,
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
    // Also forgets any value a test left in memory by failing its write.
    for (const user of [null, "user-1", "user-2", "user-3"]) {
      setUiStateScope(user);
      removeUiState("width");
    }
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

  it("a value whose write failed still reads back for the session", () => {
    writeUiState("width", 300);
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("full");
      });
    writeUiState("width", 450);
    // Not the older value storage still holds.
    expect(readUiState("width", asNumber)).toBe(450);
    // Per user, like everything else here.
    setUiStateScope("user-1");
    expect(readUiState("width", asNumber)).toBeNull();
    setUiStateScope(null);

    // Once a write succeeds, storage is the source again.
    setItem.mockRestore();
    writeUiState("width", 500);
    expect(readUiState("width", asNumber)).toBe(500);
    expect(window.localStorage.getItem("nimbus.ui.anonymous.width")).toBe(
      "500",
    );
  });

  it("removing a value also forgets a write that failed", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    writeUiState("width", 450);
    removeUiState("width");
    expect(readUiState("width", asNumber)).toBeNull();
  });

  it("a shared ref is one ref for everyone using the key, until the page reloads", () => {
    const first = useSharedPersistedUiState("rows", () => [], asStoredStrings);
    const second = useSharedPersistedUiState("rows", () => [], asStoredStrings);
    first.value = [...first.value, "a"];
    second.value = [...second.value, "b"];
    // With a ref each, the second write would have dropped "a".
    expect(first.value).toEqual(["a", "b"]);
    expect(readUiState("rows", asStoredStrings)).toEqual(["a", "b"]);

    forgetSharedUiState();
    const reloaded = useSharedPersistedUiState(
      "rows",
      () => [],
      asStoredStrings,
    );
    expect(reloaded).not.toBe(first);
    expect(reloaded.value).toEqual(["a", "b"]);
    forgetSharedUiState();
    removeUiState("rows");
  });

  it("the stored-value validators keep only what they are for", () => {
    expect(asStoredBoolean(true)).toBe(true);
    expect(asStoredBoolean("true")).toBeNull();
    expect(asStoredStrings(["a", 3, null, "b"])).toEqual(["a", "b"]);
    expect(asStoredStrings("a")).toBeNull();
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
