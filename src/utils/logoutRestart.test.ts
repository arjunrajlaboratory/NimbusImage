import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { restartAfterLogout, takeLogoutRestart } from "./logoutRestart";

describe("the reload that ends a logout", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    sessionStorage.clear();
  });

  it("reloads the page", () => {
    restartAfterLogout();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("tells the reloaded page once that it follows a logout", () => {
    expect(takeLogoutRestart()).toBe(false);

    restartAfterLogout();

    expect(takeLogoutRestart()).toBe(true);
    // A later reload of the same tab is an ordinary visit
    expect(takeLogoutRestart()).toBe(false);
  });

  it("still reloads when the marker cannot be stored", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    restartAfterLogout();

    expect(reload).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  // The store reads the marker when it is created, which is what keeps the
  // login dialog closed on the page a logout reloaded.
  it("starts the reloaded page's store as logged out by the user", async () => {
    restartAfterLogout();
    vi.resetModules();

    const afterLogout = (await import("@/store")).default;

    expect(afterLogout.hasUserLoggedOut).toBe(true);
  });

  it("starts an ordinary page load's store as not logged out by the user", async () => {
    vi.resetModules();

    const ordinary = (await import("@/store")).default;

    expect(ordinary.hasUserLoggedOut).toBe(false);
  });
});
