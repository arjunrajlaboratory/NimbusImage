import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock("./index", () => ({
  default: {
    girderRest: {
      get: (...args: any[]) => mocks.get(...args),
      token: "token",
      apiRoot: "http://girder.test/api/v1",
    },
    isAnnotationPanelOpen: true,
    setAnnotationPanelBadge: vi.fn(),
    girderUser: null,
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

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onopen: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
  // The server dropping the connection (e.g. a restart).
  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ target: this });
  }
}
vi.stubGlobal("WebSocket", FakeSocket);

import jobs from "./jobs";
import { jobStates } from "./jobConstants";

let girderTime = 1;
function streamEvent(socket: FakeSocket, data: any) {
  socket.onmessage?.({
    data: JSON.stringify({ _girderTime: girderTime++, data }),
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let jobCounter = 0;
const nextJobId = () => `job-${++jobCounter}`;

describe("jobs notification recovery", () => {
  beforeEach(async () => {
    await jobs.closeNotificationSubscription();
    FakeSocket.instances = [];
    mocks.get.mockReset();
    mocks.createNotification.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles a job that finished before its events could arrive", async () => {
    const jobId = nextJobId();
    mocks.get.mockResolvedValue({
      data: { _id: jobId, status: jobStates.success, log: ["converted\n"] },
    });
    const events: any[] = [];
    const done = jobs.addJob({
      jobId,
      datasetId: "ds",
      eventCallback: (event: any) => events.push(event),
    } as any);
    await expect(done).resolves.toBe(true);
    expect(mocks.get).toHaveBeenCalledWith(`job/${jobId}`);
    // Listeners still see the log the stream would have carried.
    expect(events.map((e) => e.text).join("")).toBe("converted\n");
  });

  it("reports a job that had already failed", async () => {
    const jobId = nextJobId();
    mocks.get.mockResolvedValue({
      data: { _id: jobId, status: jobStates.error, log: [] },
    });
    await expect(jobs.addJob({ jobId, datasetId: "ds" } as any)).resolves.toBe(
      false,
    );
  });

  it("keeps waiting on the stream while the job is still running", async () => {
    const jobId = nextJobId();
    mocks.get.mockResolvedValue({
      data: { _id: jobId, status: jobStates.running, log: [] },
    });
    let settled: boolean | undefined;
    jobs
      .addJob({ jobId, datasetId: "ds" } as any)
      .then((success) => (settled = success));
    await flush();
    expect(settled).toBeUndefined();
    streamEvent(FakeSocket.instances.at(-1)!, {
      _id: jobId,
      status: jobStates.success,
    });
    await flush();
    expect(settled).toBe(true);
  });

  it("acts once when the stream and the status check both report the end", async () => {
    const jobId = nextJobId();
    const socket = () => FakeSocket.instances.at(-1)!;
    // The status check sees the finished job, and the stream also delivers
    // it while the check is in flight.
    mocks.get.mockImplementation(async () => {
      streamEvent(socket(), { _id: jobId, status: jobStates.success });
      return { data: { _id: jobId, status: jobStates.success, log: [] } };
    });
    const events: any[] = [];
    await jobs.addJob({
      jobId,
      datasetId: "ds",
      eventCallback: (event: any) => events.push(event),
    } as any);
    await flush();
    expect(events).toHaveLength(1);
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
  });

  it("reconnects after the stream drops and re-checks pending jobs", async () => {
    vi.useFakeTimers();
    const jobId = nextJobId();
    mocks.get.mockResolvedValue({
      data: { _id: jobId, status: jobStates.running, log: [] },
    });
    let settled: boolean | undefined;
    jobs
      .addJob({ jobId, datasetId: "ds" } as any)
      .then((success) => (settled = success));
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeSocket.instances.at(-1)!;

    // Server restart: the stream drops and the job finishes meanwhile.
    first.drop();
    mocks.get.mockResolvedValue({
      data: { _id: jobId, status: jobStates.success, log: [] },
    });
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.instances.at(-1)!;
    expect(second).not.toBe(first);
    second.onopen?.({ target: second });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it("does not reconnect after a deliberate close", async () => {
    vi.useFakeTimers();
    await jobs.initializeNotificationSubscription();
    const socket = FakeSocket.instances.at(-1)!;
    await jobs.closeNotificationSubscription();
    socket.onclose?.({ target: socket });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
