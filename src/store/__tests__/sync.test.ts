/**
 * The server-status indicator counts requests in flight and clears its error
 * on the next success (IMPLICIT_STATE_MACHINES.md J8).
 */
import { describe, it, expect, beforeEach } from "vitest";
import sync from "../sync";
import rootStore from "../root";

beforeEach(() => {
  Object.assign((rootStore.state as any).sync, {
    loading: false,
    saving: false,
    loadsInFlight: 0,
    savesInFlight: 0,
    lastError: null,
  });
});

describe("server sync indicator", () => {
  it("keeps saving while another save is still in flight", () => {
    sync.setSaving(true);
    sync.setSaving(true);
    sync.setSaving(false);
    expect(sync.saving).toBe(true);
    sync.setSaving(false);
    expect(sync.saving).toBe(false);
  });

  it("keeps loading while another load is still in flight, even after one fails", () => {
    sync.setLoading(true);
    sync.setLoading(true);
    sync.setLoading(new Error("one failed"));
    expect(sync.loading).toBe(true);
    sync.setLoading(false);
    expect(sync.loading).toBe(false);
  });

  it("clears the last error on the next success", () => {
    sync.setSaving(true);
    sync.setSaving(new Error("failed"));
    expect(sync.lastError?.message).toBe("failed");
    sync.setLoading(true);
    expect(sync.lastError?.message).toBe("failed");
    sync.setLoading(false);
    expect(sync.lastError).toBeNull();
  });

  it("an end with no matching start does not hide a later request", () => {
    sync.setSaving(false);
    sync.setSaving(true);
    expect(sync.saving).toBe(true);
  });
});
