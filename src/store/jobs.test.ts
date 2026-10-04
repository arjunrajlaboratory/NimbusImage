import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { watch } from "vue";
import { AxiosError } from "axios";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  createNotification: vi.fn(),
  girderRest: { token: "token" as string | null },
  girderUser: { _id: "user-a" } as { _id: string } | null,
}));

vi.mock("./index", () => ({
  default: {
    girderRest: {
      get: (...args: any[]) => mocks.get(...args),
      get token() {
        return mocks.girderRest.token;
      },
      apiRoot: "http://girder.test/api/v1",
    },
    api: {
      // Routed through the same mock as GET job/:id, as the request it is.
      getUnfinishedUserJobs: async (statuses: number[], limit: number) =>
        (
          await mocks.get("job", {
            params: { statuses: JSON.stringify(statuses), limit },
          })
        ).data,
    },
    isAnnotationPanelOpen: true,
    setAnnotationPanelBadge: vi.fn(),
    get girderUser() {
      return mocks.girderUser;
    },
    dataset: null,
    configuration: null,
  },
}));

vi.mock("./progress", () => ({
  default: {
    createNotification: (...args: any[]) => mocks.createNotification(...args),
  },
}));

vi.mock("@/utils/log", () => ({ logError: vi.fn(), logWarning: vi.fn() }));

// Like a browser WebSocket, it opens asynchronously: a test must let a tick
// pass after creating one (addJob, initializeNotificationSubscription)
// before the stream is open.
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onopen: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState === FakeSocket.CONNECTING) {
        this.readyState = FakeSocket.OPEN;
        this.onopen?.({ target: this });
      }
    }, 0);
  }
  close() {
    if (this.readyState === FakeSocket.CLOSED) {
      return;
    }
    this.readyState = FakeSocket.CLOSED;
    setTimeout(() => this.onclose?.({ target: this }), 0);
  }
  // The server dropping the connection (e.g. a restart).
  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ target: this });
  }
}
vi.stubGlobal("WebSocket", FakeSocket);

import store from "./root";
import jobs, { stopJobPolling, unseenLogSuffix } from "./jobs";
import { jobStates, UNFINISHED_JOB_STATUSES } from "./jobConstants";

// What the server knows about each job; GET job lists the unfinished ones
// and GET job/:id returns one.
let serverJobs: { [jobId: string]: { status: number; log?: string[] } } = {};
async function restGet(path: string, config?: any) {
  if (path === "job") {
    expect(JSON.parse(config.params.statuses)).toEqual(UNFINISHED_JOB_STATUSES);
    return {
      data: Object.entries(serverJobs)
        .filter(([, job]) => UNFINISHED_JOB_STATUSES.includes(job.status))
        .map(([_id, job]) => ({ _id, status: job.status })),
    };
  }
  const jobId = path.slice("job/".length);
  if (!serverJobs[jobId]) {
    // As Girder answers for a job that does not exist.
    throw new AxiosError("Invalid job id", "ERR_BAD_REQUEST", undefined, null, {
      status: 400,
    } as any);
  }
  return { data: { _id: jobId, log: [], ...serverJobs[jobId] } };
}
const listCalls = () => mocks.get.mock.calls.filter(([p]) => p === "job");
const jobCalls = () => mocks.get.mock.calls.filter(([p]) => p !== "job");

let girderTime = 1;
function streamEvent(socket: FakeSocket, data: any) {
  socket.onmessage?.({
    data: JSON.stringify({ _girderTime: girderTime++, data }),
  });
}

// Let a new socket open and promise chains run. (A zero-delay timer set
// from inside another timer comes due a millisecond later under fake
// timers, so each round advances by one.)
async function tick() {
  for (let i = 0; i < 5; ++i) {
    await vi.advanceTimersByTimeAsync(1);
  }
}
const socket = () => FakeSocket.instances.at(-1)!;

let jobCounter = 0;
const nextJobId = () => `job-${++jobCounter}`;

function track(jobId: string, extra: any = {}) {
  const result: { settled?: boolean } = {};
  jobs
    .addJob({ jobId, datasetId: "ds", ...extra })
    .then((success) => (result.settled = success));
  return result;
}

// An open, healthy stream with nothing tracked yet.
async function openStream() {
  await jobs.initializeNotificationSubscription();
  await tick();
  expect(socket().readyState).toBe(FakeSocket.OPEN);
}

describe("unseenLogSuffix", () => {
  it("returns what extends the log we saw", () => {
    expect(unseenLogSuffix("a\nb\n", "a\nb\nc\n")).toBe("c\n");
    expect(unseenLogSuffix("", "a\n")).toBe("a\n");
  });

  it("drops the part of a server tail we already saw", () => {
    expect(
      unseenLogSuffix(
        "line 1\nline 2\nline 3\n",
        "line 2\nline 3\nquota exceeded\n",
      ),
    ).toBe("quota exceeded\n");
  });

  it("finds the longest overlap, not the first", () => {
    expect(unseenLogSuffix("xabab", "ababc")).toBe("c");
    expect(unseenLogSuffix("aaaa", "aaab")).toBe("b");
  });

  it("treats the whole server log as new when nothing overlaps", () => {
    expect(unseenLogSuffix("line 1\n", "line 7\nline 8\n")).toBe(
      "line 7\nline 8\n",
    );
  });

  it("returns nothing when there is nothing new", () => {
    expect(unseenLogSuffix("a\nb\n", "a\nb\n")).toBe("");
    expect(unseenLogSuffix("a\nb\nc\n", "b\nc\n")).toBe("");
    expect(unseenLogSuffix("a\n", "")).toBe("");
  });

  it("compares by UTF-16 code unit, like the slicing", () => {
    expect(unseenLogSuffix("a\u{1F600}", "\u{1F600}b")).toBe("b");
  });
});

describe("jobs notification recovery", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await jobs.closeNotificationSubscription();
    await tick();
    stopJobPolling();
    jobs.setConnectionErrors(0);
    FakeSocket.instances = [];
    serverJobs = {};
    mocks.get.mockReset();
    mocks.get.mockImplementation(restGet);
    mocks.createNotification.mockReset();
    mocks.girderRest.token = "token";
    mocks.girderUser = { _id: "user-a" };
  });

  afterEach(async () => {
    await jobs.closeNotificationSubscription();
    stopJobPolling();
    jobs.setConnectionErrors(0);
    // Forget jobs a test left unfinished, so later tests start clean.
    const state = (store.state as any).jobs;
    for (const jobId of Object.keys(state.jobInfoMap)) {
      jobs.removeJobInfo(jobId);
    }
    for (const jobId of Object.keys(state.messageStore)) {
      jobs.clearStoredMessages(jobId);
    }
    vi.useRealTimers();
  });

  it("settles a job that ended while the stream was down", async () => {
    const jobId = nextJobId();
    serverJobs[jobId] = { status: jobStates.success, log: ["converted\n"] };
    const events: any[] = [];
    const job = track(jobId, {
      eventCallback: (event: any) => events.push(event),
    });
    await tick();
    expect(job.settled).toBe(true);
    expect(listCalls()).toHaveLength(1);
    expect(jobCalls()).toEqual([[`job/${jobId}`]]);
    // Listeners still see the log the stream would have carried.
    expect(events.map((e) => e.text).join("")).toBe("converted\n");
  });

  it("reports a job that had already failed", async () => {
    const jobId = nextJobId();
    serverJobs[jobId] = { status: jobStates.error };
    const job = track(jobId);
    await tick();
    expect(job.settled).toBe(false);
    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Job Failed" }),
    );
  });

  it("keeps waiting on the stream while the job is still running", async () => {
    const jobId = nextJobId();
    serverJobs[jobId] = { status: jobStates.running };
    const job = track(jobId);
    await tick();
    expect(job.settled).toBeUndefined();
    expect(listCalls()).toHaveLength(1);
    expect(jobCalls()).toHaveLength(0);
    streamEvent(socket(), { _id: jobId, status: jobStates.success });
    await tick();
    expect(job.settled).toBe(true);
  });

  it("acts once when the stream and the status check both report the end", async () => {
    const jobId = nextJobId();
    serverJobs[jobId] = { status: jobStates.success };
    // The stream delivers the end while the status check is in flight.
    mocks.get.mockImplementation(async (path: string, config?: any) => {
      if (path !== "job") {
        streamEvent(socket(), { _id: jobId, status: jobStates.success });
      }
      return restGet(path, config);
    });
    const events: any[] = [];
    const job = track(jobId, {
      eventCallback: (event: any) => events.push(event),
    });
    await tick();
    expect(job.settled).toBe(true);
    expect(events).toHaveLength(1);
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
  });

  it("keeps a fast job visible to a watcher until its end is handled", async () => {
    await openStream();
    const jobId = nextJobId();
    const toolId = "tool-1";
    // The job ended before addJob: its end waits in the buffer, and is
    // handled in the same tick the job is registered.
    streamEvent(socket(), { _id: jobId, status: jobStates.error });
    // As ToolItem does: on a new job id, read its promise for the outcome.
    const outcomes: (boolean | "untracked")[] = [];
    const stop = watch(
      () => jobs.jobIdForToolId[toolId],
      (watchedJobId) => {
        if (!watchedJobId) {
          return;
        }
        const promise = jobs.getPromiseForJobId(watchedJobId);
        if (!promise) {
          outcomes.push("untracked");
          return;
        }
        promise.then((success) => outcomes.push(success));
      },
    );
    const job = track(jobId, { toolId });
    await tick();
    stop();
    expect(job.settled).toBe(false);
    expect(outcomes).toEqual([false]);
    expect(jobs.jobIdForToolId[toolId]).toBeUndefined();
  });

  it("makes no request per job while the stream is healthy", async () => {
    await openStream();
    const jobId = nextJobId();
    serverJobs[jobId] = { status: jobStates.running };
    const job = track(jobId);
    streamEvent(socket(), {
      _id: jobId,
      status: jobStates.running,
      text: "working\n",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    streamEvent(socket(), { _id: jobId, status: jobStates.success });
    await tick();
    expect(job.settled).toBe(true);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("reconnects after the stream drops and re-checks pending jobs", async () => {
    await openStream();
    const jobId = nextJobId();
    serverJobs[jobId] = { status: jobStates.running };
    const job = track(jobId);
    await tick();
    const first = socket();

    // Server restart: the stream drops and the job finishes meanwhile.
    first.drop();
    serverJobs[jobId] = { status: jobStates.success };
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket()).not.toBe(first);
    await tick();
    expect(job.settled).toBe(true);
    expect(listCalls()).toHaveLength(1);
    expect(jobCalls()).toEqual([[`job/${jobId}`]]);
  });

  it("delivers only the unseen part of a recovered log", async () => {
    await openStream();
    const jobId = nextJobId();
    const texts: string[] = [];
    const job = track(jobId, {
      eventCallback: (event: any) => event.text && texts.push(event.text),
    });
    streamEvent(socket(), {
      _id: jobId,
      status: jobStates.running,
      text: "line 1\nline 2\nline 3\n",
    });
    socket().drop();
    // The server kept only a tail of the log.
    serverJobs[jobId] = {
      status: jobStates.error,
      log: ["line 2\nline 3\n", "quota exceeded\n"],
    };
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    expect(job.settled).toBe(false);
    expect(texts).toEqual(["line 1\nline 2\nline 3\n", "quota exceeded\n"]);
    expect(jobs.getJobLog(jobId)).toBe("");
  });

  it("checks jobs that go quiet with one list of unfinished jobs", async () => {
    await openStream();
    const jobId = nextJobId();
    const otherJobId = nextJobId();
    serverJobs[jobId] = { status: jobStates.running };
    serverJobs[otherJobId] = { status: jobStates.running };
    const job = track(jobId);
    const other = track(otherJobId);
    // The end is lost without the socket noticing (e.g. it was missed
    // during a reconnect while the job's request was in flight).
    serverJobs[jobId] = { status: jobStates.success };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.get).not.toHaveBeenCalled(); // not quiet long enough
    await vi.advanceTimersByTimeAsync(15_000);
    expect(job.settled).toBe(true);
    expect(other.settled).toBeUndefined();
    expect(listCalls()).toHaveLength(1);
    expect(jobCalls()).toEqual([[`job/${jobId}`]]);

    // The poll stops once nothing is tracked.
    streamEvent(socket(), { _id: otherJobId, status: jobStates.success });
    await tick();
    expect(other.settled).toBe(true);
    mocks.get.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("backs off against a server that accepts then drops the socket", async () => {
    await openStream();
    socket().drop();
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    expect(FakeSocket.instances).toHaveLength(2);
    // Opened (the tick above) and dropped at once: the delay still grows.
    expect(socket().readyState).toBe(FakeSocket.OPEN);
    socket().drop();
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(3);

    // A connection that stays up resets the backoff.
    await tick();
    expect(socket().readyState).toBe(FakeSocket.OPEN);
    await vi.advanceTimersByTimeAsync(10_000);
    socket().drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it("gives up after repeated failures until a new job needs the stream", async () => {
    await openStream();
    jobs.setConnectionErrors(10);
    socket().drop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(FakeSocket.instances).toHaveLength(1);

    const jobId = nextJobId();
    serverJobs[jobId] = { status: jobStates.running };
    const job = track(jobId);
    await tick();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(jobs.connectionErrors).toBe(0);
    streamEvent(socket(), { _id: jobId, status: jobStates.success });
    await tick();
    expect(job.settled).toBe(true);
  });

  it("opens one stream for several jobs added after it gave up", async () => {
    await openStream();
    jobs.setConnectionErrors(10);
    socket().drop(); // no reconnect: it gave up
    const jobIds = [nextJobId(), nextJobId(), nextJobId()];
    for (const jobId of jobIds) {
      serverJobs[jobId] = { status: jobStates.running };
    }
    const tracked = jobIds.map((jobId) => track(jobId));
    await tick();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(listCalls()).toHaveLength(1);
    // One at a time: under fake timers, concurrent dynamic imports of the
    // (mocked) progress module never resolve -- a harness artifact.
    for (const jobId of jobIds) {
      streamEvent(socket(), { _id: jobId, status: jobStates.success });
      await tick();
    }
    expect(tracked.map((job) => job.settled)).toEqual([true, true, true]);
  });

  it("leaves a pending reconnect's backoff alone when a job is added", async () => {
    await openStream();
    jobs.setConnectionErrors(3);
    socket().drop(); // reconnect in 8 s
    const jobId = nextJobId();
    serverJobs[jobId] = { status: jobStates.success };
    const job = track(jobId);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(jobs.connectionErrors).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);
    // The reconnect checks the job that was added meanwhile.
    await tick();
    expect(job.settled).toBe(true);
  });

  it("does not check another session's jobs", async () => {
    await openStream();
    const jobId = nextJobId();
    serverJobs[jobId] = { status: jobStates.running };
    const job = track(jobId);
    // User A logs out (or their token expires) and user B logs in; A's job
    // ends meanwhile.
    serverJobs[jobId] = { status: jobStates.success };
    mocks.girderUser = { _id: "user-b" };
    await jobs.initializeNotificationSubscription();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(job.settled).toBeUndefined();
  });

  it("retries a stream that gave up, from the poll, while jobs are tracked", async () => {
    await openStream();
    const jobId = nextJobId();
    serverJobs[jobId] = { status: jobStates.running };
    const job = track(jobId);
    jobs.setConnectionErrors(10);
    socket().drop(); // gives up at once
    await vi.advanceTimersByTimeAsync(14_000);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
    // Still failing: a single attempt per poll, not a new backoff series.
    expect(jobs.connectionErrors).toBe(10);
    socket().drop();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(3);
    // The server is back: the stream stays up and carries the job's end.
    await tick();
    streamEvent(socket(), { _id: jobId, status: jobStates.success });
    await tick();
    expect(job.settled).toBe(true);
  });

  it("does not settle a job whose user changed during its status check", async () => {
    await openStream();
    const jobId = nextJobId();
    serverJobs[jobId] = { status: jobStates.success };
    mocks.get.mockImplementation(async (path: string, config?: any) => {
      if (path !== "job") {
        mocks.girderUser = { _id: "user-b" }; // logged out, B logged in
      }
      return restGet(path, config);
    });
    const job = track(jobId);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(jobCalls()).toHaveLength(1);
    expect(job.settled).toBeUndefined();
  });

  it("resets the give-up count on a fresh connection such as login", async () => {
    await openStream();
    jobs.setConnectionErrors(10);
    await jobs.initializeNotificationSubscription();
    expect(jobs.connectionErrors).toBe(0);
  });

  it("settles a job even when a listener throws", async () => {
    await openStream();
    const jobId = nextJobId();
    const errorCallback = vi.fn();
    const job = track(jobId, {
      eventCallback: () => {
        throw new Error("listener bug");
      },
      errorCallback,
    });
    streamEvent(socket(), { _id: jobId, status: jobStates.success });
    await tick();
    expect(job.settled).toBe(true);
    expect(errorCallback).toHaveBeenCalledTimes(1);
  });

  it("settles a deleted job instead of checking it forever", async () => {
    await openStream();
    const jobId = nextJobId();
    const job = track(jobId); // never on the server: as if deleted
    await vi.advanceTimersByTimeAsync(30_000);
    expect(job.settled).toBe(false);
    expect(mocks.createNotification).not.toHaveBeenCalled();
    mocks.get.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("keeps checking a job it could not read for a transient reason", async () => {
    await openStream();
    const jobId = nextJobId();
    serverJobs[jobId] = { status: jobStates.success };
    mocks.get.mockImplementation(async (path: string, config?: any) => {
      if (path !== "job") {
        throw new Error("Network Error");
      }
      return restGet(path, config);
    });
    const job = track(jobId);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(job.settled).toBeUndefined();
    mocks.get.mockImplementation(restGet);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(job.settled).toBe(true);
  });

  it("settles a job missing from the unfinished list only once it ended", async () => {
    await openStream();
    const jobId = nextJobId();
    // Not in the user's list (e.g. it was cut off by the limit): it is read
    // directly, and stays tracked while it is still running.
    serverJobs[jobId] = { status: jobStates.running };
    mocks.get.mockImplementation(async (path: string, config?: any) =>
      path === "job" ? { data: [] } : restGet(path, config),
    );
    const job = track(jobId);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(jobCalls()).toEqual([[`job/${jobId}`]]);
    expect(job.settled).toBeUndefined();
    serverJobs[jobId] = { status: jobStates.cancelled };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(job.settled).toBe(false);
  });

  it("cancels a pending reconnect on a deliberate close", async () => {
    await openStream();
    socket().drop();
    await jobs.closeNotificationSubscription();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("does not reconnect after a deliberate close", async () => {
    await openStream();
    await jobs.closeNotificationSubscription();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("stops reconnecting once logged out", async () => {
    await openStream();
    mocks.girderRest.token = null;
    socket().drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
