import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";

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

  it("returns null without logging for the 401 a viewer without a login gets", async () => {
    const config = { headers: new AxiosHeaders() };
    const unauthenticated = new AxiosError(
      "Request failed with status code 401",
      "ERR_BAD_REQUEST",
      config,
      {},
      { status: 401, statusText: "", headers: {}, config, data: {} },
    );
    await expect(
      fetchSharingInfo(() => Promise.reject(unauthenticated)),
    ).resolves.toBeNull();
    expect(logError).not.toHaveBeenCalled();
  });
});
