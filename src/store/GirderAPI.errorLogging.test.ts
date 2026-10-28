import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import type { RestClientInstance } from "@/girder";

vi.mock("@/utils/fetch", () => ({
  fetchAllPages: vi.fn(),
}));

vi.mock("@/store/progress", () => ({
  default: {},
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
}));

import GirderAPI from "./GirderAPI";
import { logError } from "@/utils/log";

// These methods turn a failed request into an empty result for their
// callers. The failure must still reach the log with its cause attached.
const cases: {
  name: string;
  call: (api: GirderAPI) => Promise<unknown>;
  fallback: unknown;
}[] = [
  {
    name: "getHistoryEntries",
    call: (api) => api.getHistoryEntries("dataset1"),
    fallback: [],
  },
  { name: "getUserJobs", call: (api) => api.getUserJobs(), fallback: [] },
  { name: "getJobInfo", call: (api) => api.getJobInfo("job1"), fallback: null },
  {
    name: "getUserApiKeys",
    call: (api) => api.getUserApiKeys(),
    fallback: [],
  },
  {
    name: "getUserStorageQuota",
    call: (api) => api.getUserStorageQuota("user1"),
    fallback: null,
  },
];

describe("GirderAPI failure logging", () => {
  beforeEach(() => {
    vi.mocked(logError).mockClear();
  });

  it.each(cases)(
    "$name returns its fallback and logs the request error",
    async ({ call, fallback }) => {
      const failure = new Error("request failed");
      const get = vi.fn().mockRejectedValue(failure);
      const api = new GirderAPI({ get } as unknown as RestClientInstance);

      await expect(call(api)).resolves.toEqual(fallback);
      expect(logError).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logError).mock.calls[0]).toContain(failure);
    },
  );
});

describe("getAssetstores", () => {
  function axiosError(status: number) {
    return new AxiosError(
      `Request failed with status code ${status}`,
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      {
        status,
        statusText: "",
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: {},
      },
    );
  }

  it("returns an empty list for the admin-only 403 a regular user gets", async () => {
    const get = vi.fn().mockRejectedValue(axiosError(403));
    const api = new GirderAPI({ get } as unknown as RestClientInstance);
    await expect(api.getAssetstores()).resolves.toEqual([]);
  });

  it("rethrows any other failure so the caller can log it", async () => {
    const failure = axiosError(500);
    const get = vi.fn().mockRejectedValue(failure);
    const api = new GirderAPI({ get } as unknown as RestClientInstance);
    await expect(api.getAssetstores()).rejects.toBe(failure);
  });
});
