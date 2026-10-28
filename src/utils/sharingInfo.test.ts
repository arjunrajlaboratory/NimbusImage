import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

import { fetchSharingInfo } from "./sharingInfo";
import { logError } from "@/utils/log";

describe("fetchSharingInfo", () => {
  beforeEach(() => {
    vi.mocked(logError).mockClear();
  });

  it("returns the access list when the request succeeds", async () => {
    const access = { public: true, users: [] };
    await expect(fetchSharingInfo(async () => access)).resolves.toBe(access);
    expect(logError).not.toHaveBeenCalled();
  });

  it("returns null and logs the error when the request fails", async () => {
    const failure = new Error("403");
    await expect(
      fetchSharingInfo(() => Promise.reject(failure)),
    ).resolves.toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "Failed to fetch sharing info:",
      failure,
    );
  });
});
