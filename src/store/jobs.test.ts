import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    onmessage: any = null;
    onerror: any = null;
    onopen: any = null;
    onclose: any = null;
    constructor(public url: string) {
      sockets.push(this);
    }
    close() {
      this.readyState = 3;
    }
  }
  const sockets: FakeSocket[] = [];
  (globalThis as any).WebSocket = FakeSocket;
  return {
    sockets,
    // jobId -> status the server reports
    statuses: {} as Record<string, number>,
    get: vi.fn(),
    createNotification: vi.fn(),
  };
});

vi.mock("@/store/index", () => ({
  default: {
    isLoggedIn: true,
    girderRest: {
      apiRoot: "http://girder.test/api/v1",
      token: "token",
      get: (...args: any[]) => mocks.get(...args),
    },
    isAnnotationPanelOpen: true,
    setAnnotationPanelBadge: vi.fn(),
  },
}));

vi.mock("@/store/progress", () => ({
  default: { createNotification: mocks.createNotification },
}));

vi.mock("@/utils/log", () => ({ logError: vi.fn(), logWarning: vi.fn() }));

import jobs, { toolRunKey } from "@/store/jobs";
import main from "@/store/index";

const SUCCESS = 3;
const ERROR = 4;
const RUNNING = 2;

function latestSocket() {
  return mocks.sockets[mocks.sockets.length - 1];
}

async function failConnection(times: number) {
  for (let i = 0; i < times; i++) {
    await latestSocket().onerror(new Event("error"));
  }
}

async function microtasks() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

// addJob resolves only when the job settles, so don't await it: let it
// open the stream and register the job, then hand back its completion.
async function track(jobId: string) {
  let settled: boolean | undefined;
  const completion = jobs
    .addJob({ jobId, datasetId: "ds" } as any)
    .then((success: boolean) => {
      settled = success;
      return success;
    });
  await microtasks();
  return { completion, settled: () => settled };
}

describe("jobs store: settling tracked jobs when the stream fails", () => {
  beforeEach(async () => {
    await jobs.closeNotificationSubscription();
    jobs.setConnectionErrors(0);
    mocks.sockets.length = 0;
    for (const key of Object.keys(mocks.statuses)) {
      delete mocks.statuses[key];
    }
    mocks.get.mockImplementation(async (url: string) => {
      const jobId = url.replace("job/", "");
      return { data: { status: mocks.statuses[jobId] ?? RUNNING } };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles a tracked job from its server status when the stream gives up", async () => {
    const job = await track("give-up-job");
    mocks.statuses["give-up-job"] = SUCCESS;
    await failConnection(4);
    await expect(job.completion).resolves.toBe(true);
  });

  it("reconnects on a clean close and settles a job that finished meanwhile", async () => {
    const job = await track("closed-job");
    const first = latestSocket();
    mocks.statuses["closed-job"] = ERROR;
    await first.onclose({ target: first });
    const second = latestSocket();
    expect(second).not.toBe(first);
    await second.onopen(new Event("open"));
    await expect(job.completion).resolves.toBe(false);
  });

  it("ignores the close of a socket it already replaced", async () => {
    await track("replaced-socket-job");
    const first = latestSocket();
    await first.onerror(new Event("error"));
    const count = mocks.sockets.length;
    await first.onclose({ target: first });
    expect(mocks.sockets.length).toBe(count);
  });

  it("ignores the error a replaced socket emits when closed while connecting", async () => {
    await track("resubscribed-job");
    const first = latestSocket();
    await jobs.initializeNotificationSubscription();
    const count = mocks.sockets.length;
    await first.onerror({ target: first });
    expect(mocks.sockets.length).toBe(count);
    expect(jobs.connectionErrors).toBe(0);
  });

  it("gives a later subscription fresh attempts after giving up", async () => {
    await track("first-job");
    await failConnection(4);
    // Given up: the stream is closed.
    expect(jobs.notificationSource).toBeNull();
    await track("second-job");
    const reopened = mocks.sockets.length;
    await failConnection(1);
    // One error after the give-up retries instead of giving up again.
    expect(mocks.sockets.length).toBe(reopened + 1);
    expect(jobs.notificationSource).not.toBeNull();
  });

  it("gives up on a server that accepts the stream and closes it at once", async () => {
    vi.useFakeTimers();
    await track("flapping-job");
    for (let i = 0; i < 10 && jobs.notificationSource; i++) {
      const socket = latestSocket();
      await socket.onopen(new Event("open"));
      await socket.onclose({ target: socket });
    }
    expect(jobs.notificationSource).toBeNull();
    // The first socket plus three retries, not one per loop pass
    expect(mocks.sockets.length).toBe(4);
  });

  it("counts a stream that stayed open as working again", async () => {
    vi.useFakeTimers();
    await track("stable-job");
    await failConnection(2);
    expect(jobs.connectionErrors).toBe(2);
    await latestSocket().onopen(new Event("open"));
    expect(jobs.connectionErrors).toBe(2);
    await vi.advanceTimersByTimeAsync(10000);
    expect(jobs.connectionErrors).toBe(0);
  });

  it("keeps reading statuses after giving up until the job finishes", async () => {
    vi.useFakeTimers();
    const job = await track("polled-job");
    await failConnection(4);
    await vi.advanceTimersByTimeAsync(0);
    expect(job.settled()).toBeUndefined();
    mocks.statuses["polled-job"] = SUCCESS;
    await vi.advanceTimersByTimeAsync(15000);
    expect(job.settled()).toBe(true);
  });

  it("settles a job that finished before it was tracked on an already open stream", async () => {
    await track("earlier-job");
    const socket = latestSocket();
    socket.readyState = 1;
    await socket.onopen(new Event("open"));
    mocks.statuses["finished-early-job"] = SUCCESS;
    mocks.get.mockClear();
    const job = await track("finished-early-job");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(job.settled()).toBe(true);
    // One read, of the new job only, and no reconnect
    expect(mocks.get.mock.calls).toEqual([["job/finished-early-job"]]);
    expect(latestSocket()).toBe(socket);
  });

  it("leaves reading a job added while the stream connects to the open", async () => {
    await track("connecting-job");
    await track("second-connecting-job");
    expect(mocks.get).not.toHaveBeenCalled();
    await latestSocket().onopen(new Event("open"));
    // Jobs earlier tests left tracked are read too; each of these once
    const reads = mocks.get.mock.calls.map(([url]) => url);
    expect(reads.filter((url) => url === "job/connecting-job")).toHaveLength(1);
    expect(
      reads.filter((url) => url === "job/second-connecting-job"),
    ).toHaveLength(1);
  });

  it("fails and stops polling a tracked job the server no longer has", async () => {
    vi.useFakeTimers();
    mocks.get.mockImplementation(async () => {
      throw {
        isAxiosError: true,
        response: { status: 400, data: { message: "Invalid job id" } },
      };
    });
    const job = await track("deleted-job");
    await failConnection(4);
    await vi.advanceTimersByTimeAsync(0);
    expect(job.settled()).toBe(false);
    mocks.get.mockClear();
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("tells a missing job's listeners it ended, without a failure notification", async () => {
    vi.useFakeTimers();
    mocks.get.mockImplementation(async () => {
      throw {
        isAxiosError: true,
        response: { status: 400, data: { message: "Invalid job id" } },
      };
    });
    mocks.createNotification.mockClear();
    // A listener that ends its state from the terminal event, as
    // progress.trackMaxMergeJob does.
    const eventCallback = vi.fn();
    const completion = jobs.addJob({
      jobId: "missing-listened-job",
      datasetId: "ds",
      eventCallback,
    } as any);
    await microtasks();
    await failConnection(4);
    await vi.advanceTimersByTimeAsync(0);
    await expect(completion).resolves.toBe(false);
    expect(eventCallback).toHaveBeenCalledWith({
      _id: "missing-listened-job",
      status: ERROR,
    });
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it("stops tracking every job at logout and tells their listeners", async () => {
    mocks.createNotification.mockClear();
    const eventCallback = vi.fn();
    const completion = jobs.addJob({
      jobId: "previous-session-job",
      toolId: "tool",
      datasetId: "shared-ds",
      eventCallback,
    } as any);
    await microtasks();
    expect(jobs.jobIdForToolInDataset("tool", "shared-ds")).toBe(
      "previous-session-job",
    );

    jobs.retireTrackedJobs();

    await expect(completion).resolves.toBe(false);
    expect(jobs.jobIdForToolInDataset("tool", "shared-ds")).toBeNull();
    expect(eventCallback).toHaveBeenCalledWith({
      _id: "previous-session-job",
      status: ERROR,
    });
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it("keeps tracking a job whose status read fails on the network", async () => {
    vi.useFakeTimers();
    mocks.get.mockImplementation(async () => {
      throw { isAxiosError: true, message: "Network Error" };
    });
    const job = await track("unreachable-job");
    await failConnection(4);
    await vi.advanceTimersByTimeAsync(15000);
    expect(job.settled()).toBeUndefined();
    expect(jobs.getPromiseForJobId("unreachable-job")).toBeDefined();
  });
});

describe("jobs store: a property's running job", () => {
  it("is scoped to the dataset it runs on", () => {
    jobs.rawAddJob({
      jobId: "property-job",
      datasetId: "ds-a",
      propertyId: "prop-1",
    });
    try {
      expect(jobs.jobIdForPropertyInDataset("prop-1", "ds-a")).toBe(
        "property-job",
      );
      // Property ids are shared by every dataset of a collection
      expect(jobs.jobIdForPropertyInDataset("prop-1", "ds-b")).toBeNull();
      expect(jobs.jobIdForPropertyInDataset("prop-2", "ds-a")).toBeNull();
    } finally {
      jobs.removeJobInfo("property-job");
    }
  });
});

describe("jobs store: a tool run requested but not tracked yet", () => {
  it("is in flight for its user, dataset and tool until every run ends", () => {
    const key = toolRunKey("user-1", "ds-a", "tool-1");
    (main as any).girderUser = { _id: "user-1" };
    try {
      jobs.toolRunStarted(key);
      jobs.toolRunStarted(key);
      expect(jobs.isToolRunInFlight("tool-1", "ds-a")).toBe(true);
      expect(jobs.isToolRunInFlight("tool-1", "ds-b")).toBe(false);
      expect(jobs.isToolRunInFlight("tool-2", "ds-a")).toBe(false);
      // The module outlives logout: the next account is not locked out
      (main as any).girderUser = { _id: "user-2" };
      expect(jobs.isToolRunInFlight("tool-1", "ds-a")).toBe(false);
      (main as any).girderUser = { _id: "user-1" };
      jobs.toolRunEnded(key);
      expect(jobs.isToolRunInFlight("tool-1", "ds-a")).toBe(true);
      jobs.toolRunEnded(key);
      expect(jobs.isToolRunInFlight("tool-1", "ds-a")).toBe(false);
    } finally {
      delete (main as any).girderUser;
    }
  });
});

describe("jobs store: a tool's running job", () => {
  it("is scoped to the dataset it runs on", () => {
    jobs.rawAddJob({
      jobId: "tool-job",
      datasetId: "ds-a",
      toolId: "tool-1",
    });
    try {
      expect(jobs.jobIdForToolInDataset("tool-1", "ds-a")).toBe("tool-job");
      // Tool ids are shared by every dataset of a collection
      expect(jobs.jobIdForToolInDataset("tool-1", "ds-b")).toBeNull();
      expect(jobs.jobIdForToolInDataset("tool-2", "ds-a")).toBeNull();
    } finally {
      jobs.removeJobInfo("tool-job");
    }
  });
});
