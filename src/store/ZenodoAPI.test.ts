import { describe, it, expect, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";

vi.mock("@/store", () => ({ default: {} }));
vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import ZenodoAPI from "./ZenodoAPI";
import { jobStates } from "./jobConstants";

function httpError(status: number) {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(
    "failed",
    "ERR_BAD_REQUEST",
    config,
    {},
    {
      status,
      statusText: "",
      headers: {},
      config,
      data: {},
    },
  );
}

describe("ZenodoAPI.getLiveUploadJobId", () => {
  it.each([
    // A local job stays INACTIVE until its thread marks it RUNNING, so a
    // just-started upload must still count.
    ["inactive", jobStates.inactive],
    ["queued", jobStates.queued],
    ["running", jobStates.running],
  ])("returns the job while it is %s", async (_, status) => {
    const get = vi.fn().mockResolvedValue({ data: { _id: "job-1", status } });
    const api = new ZenodoAPI({ get } as any);

    expect(await api.getLiveUploadJobId("job-1")).toBe("job-1");
    expect(get).toHaveBeenCalledWith("job/job-1");
  });

  it("returns null once the job has ended", async () => {
    const get = vi.fn().mockResolvedValue({
      data: { _id: "job-1", status: jobStates.error },
    });
    const api = new ZenodoAPI({ get } as any);

    expect(await api.getLiveUploadJobId("job-1")).toBeNull();
  });

  it("returns null for a job this user can't read", async () => {
    // A co-owner's upload: Girder only lets the job's owner read it.
    const get = vi.fn().mockRejectedValue(httpError(403));
    const api = new ZenodoAPI({ get } as any);

    expect(await api.getLiveUploadJobId("job-1")).toBeNull();
  });

  it("returns null for a job that no longer exists", async () => {
    // Girder answers a missing job id with 400 ("Invalid job id").
    const get = vi.fn().mockRejectedValue(httpError(400));
    const api = new ZenodoAPI({ get } as any);

    expect(await api.getLiveUploadJobId("job-1")).toBeNull();
  });

  it("rethrows other failures", async () => {
    const get = vi.fn().mockRejectedValue(httpError(500));
    const api = new ZenodoAPI({ get } as any);

    await expect(api.getLiveUploadJobId("job-1")).rejects.toThrow();
  });
});
