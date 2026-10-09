import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression tests for addMultiSourceMetadata's error propagation.
//
// This action deliberately throws on failure (e.g. a storage quota breach
// during transcoding) so MultiSourceConfiguration.vue can show the real
// reason instead of a frozen spinner. Unlike most store tests, this file
// does NOT mock "@/store"/"./index": vuex-module-decorators wraps any error
// thrown from an @Action in a generic "ERR_ACTION_ACCESS_UNDEFINED" message
// unless the action is declared with { rawError: true } - a library quirk
// that silently defeats this kind of error surfacing (see the fix that
// added rawError: true to this action). These tests dispatch the REAL Vuex
// action so a regression - e.g. someone removing rawError: true - fails
// here instead of only showing up against a live backend.
import main from "./index";
import jobs from "./jobs";
import progress from "./progress";
import { jobStates } from "./jobConstants";
import rootStore from "./root";
import "./filters";
import "./properties";
// Registers hydrateTrackLabelPath, which hydrateAnnotationBrowserState
// dispatches by name.
import "./connectionList";
import { RestClient } from "@/girder";
import ShareLinkAPI from "./ShareLinkAPI";

describe("share-link bootstrap identity", () => {
  let originalClient: typeof main.girderRest;
  let originalToken: typeof main.girderRest.token;
  let originalUser: typeof main.girderRest.user;
  let originalIdentity: typeof main.girderUser;
  beforeEach(() => {
    originalClient = main.girderRest;
    originalToken = originalClient.token;
    originalUser = originalClient.user;
    originalIdentity = main.girderUser;
    vi.spyOn(main.api, "getUserPrivateFolder").mockResolvedValue(null);
    vi.spyOn(main.api, "getAssetstores").mockResolvedValue([]);
    vi.spyOn(main, "loadUserColors").mockResolvedValue({});
    vi.spyOn(main, "fetchUserStorageInfo").mockResolvedValue(undefined);
    vi.spyOn(main, "setSelectedConfiguration").mockResolvedValue(undefined);
    vi.spyOn(main, "setSelectedDataset").mockResolvedValue(undefined);
    vi.spyOn(main, "fetchRecentDatasetViews").mockResolvedValue(undefined);
    vi.spyOn(jobs, "initializeNotificationSubscription").mockResolvedValue(
      undefined,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(originalClient, { token: originalToken, user: originalUser });
    Object.assign((rootStore.state as any).main, {
      girderRest: originalClient,
      girderUser: originalIdentity,
    });
  });

  it.each([null, { _id: "owner", login: "owner" }])(
    "does not commit an attempted identity when link validation fails (%j)",
    async (previousUser) => {
      const client = main.girderRest;
      const previousToken = previousUser ? "previous-token" : null;
      Object.assign(client, { user: previousUser, token: previousToken });
      (rootStore.state as any).main.girderUser = previousUser;
      const before = main.girderUser;
      const attempted = { _id: "attempted", login: "attempted" };
      vi.spyOn(RestClient.prototype, "fetchUser").mockImplementation(
        async function (this: any) {
          this.user = attempted;
          return attempted as any;
        },
      );
      vi.spyOn(ShareLinkAPI.prototype, "me").mockRejectedValue(
        new Error("not a link"),
      );
      const actions: string[] = [];
      const unsubscribe = rootStore.subscribeAction(({ type }) =>
        actions.push(type),
      );
      try {
        expect(
          await messageOf(main.openShareLink({ token: "attempted-token" })),
        ).toBe("not a link");
        expect(main.girderRest).toBe(client);
        expect(main.girderRest.token).toBe(previousToken);
        expect(main.girderRest.user).toEqual(previousUser);
        expect(main.girderUser).toBe(before);
        expect(actions).not.toContain("loggedIn");
      } finally {
        unsubscribe();
      }
    },
  );

  it("commits only the latest validated link and does not persist its bearer", async () => {
    const storedLogin = localStorage.getItem("nimbus.girderToken");
    vi.spyOn(RestClient.prototype, "fetchUser").mockImplementation(
      async function (this: any) {
        this.user = { _id: this.token, shareLink: { datasetId: "d" } };
        return this.user;
      },
    );
    let finishFirst!: (link: any) => void;
    vi.spyOn(ShareLinkAPI.prototype, "me")
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
      )
      .mockResolvedValueOnce({ datasetViewId: "new-view" } as any);
    const first = messageOf(main.openShareLink({ token: "old-link" }));
    // Let the first isolated user lookup reach link validation.
    await Promise.resolve();
    await Promise.resolve();
    const link = await main.openShareLink({ token: "new-link" });
    expect(link.datasetViewId).toBe("new-view");
    expect(main.girderUser?._id).toBe("new-link");
    expect(main.girderRest.token).toBe("new-link");
    finishFirst({ datasetViewId: "old-view" });
    expect(await first).toBe(
      "A newer session has replaced this share-link request.",
    );
    expect(main.girderUser?._id).toBe("new-link");
    expect(localStorage.getItem("nimbus.girderToken")).toBe(storedLogin);
    // The API classes reach Girder through girderRestProxy: they must send
    // the link's bearer too, not the client (and stored login) from boot.
    expect(main.api.client.token).toBe("new-link");
    expect((main.girderRestProxy as any).token).toBe("new-link");
  });

  it("restores the replaced session when the shared route is left", async () => {
    const client = main.girderRest;
    const owner = { _id: "owner", login: "owner" };
    Object.assign(client, { user: owner, token: "owner-token" });
    (rootStore.state as any).main.girderUser = owner;
    vi.spyOn(RestClient.prototype, "fetchUser").mockImplementation(
      async function (this: any) {
        this.user = { _id: this.token, shareLink: { datasetId: "d" } };
        return this.user;
      },
    );
    vi.spyOn(ShareLinkAPI.prototype, "me").mockResolvedValue({
      datasetViewId: "v",
    } as any);
    await main.openShareLink({ token: "link-a" });
    // Straight to a second link: leaving restores the owner, not link A.
    await main.openShareLink({ token: "link-b" });
    expect(main.girderRest.token).toBe("link-b");
    await main.leaveShareLink();
    expect(main.girderRest).toBe(client);
    expect(main.girderRest.token).toBe("owner-token");
    expect(main.girderUser).toEqual(owner);
    expect((main.girderRestProxy as any).token).toBe("owner-token");
    // Nothing to restore a second time.
    await main.leaveShareLink();
    expect(main.girderRest).toBe(client);
  });

  it("fetches the saved login's user when the shared URL was opened directly", async () => {
    // Opening a shared URL skips initialize(): the saved client has its
    // token but has never fetched its user.
    const client = main.girderRest;
    Object.assign(client, { user: null, token: "owner-token" });
    vi.spyOn(RestClient.prototype, "fetchUser").mockImplementation(
      async function (this: any) {
        this.user = { _id: this.token };
        return this.user;
      },
    );
    vi.spyOn(ShareLinkAPI.prototype, "me").mockResolvedValue({
      datasetViewId: "v",
    } as any);
    await main.openShareLink({ token: "link-a" });
    await main.leaveShareLink();
    expect(main.girderRest).toBe(client);
    expect(main.girderUser?._id).toBe("owner-token");
  });

  it("does not commit a share bootstrap after its route is cancelled", async () => {
    const client = main.girderRest;
    const identity = main.girderUser;
    const controller = new AbortController();
    vi.spyOn(RestClient.prototype, "fetchUser").mockImplementation(
      async function (this: any) {
        this.user = { _id: "link-user", shareLink: { datasetId: "d" } };
        return this.user;
      },
    );
    let finish!: (link: any) => void;
    vi.spyOn(ShareLinkAPI.prototype, "me").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = messageOf(
      main.openShareLink({
        token: "link",
        signal: controller.signal,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    finish({ datasetViewId: "shared-view" });
    expect(await pending).toBe("Share-link request was cancelled.");
    expect(main.girderRest).toBe(client);
    expect(main.girderUser).toBe(identity);
  });
});

function mockSuccessfulUploadAndTiles() {
  // Unless a test says otherwise the stream has delivered the job's end,
  // so the job is not read and the outcome comes from addJob.
  jobs.clearStoredMessages("job1");
  jobs.storeMessage({
    jobId: "job1",
    event: { _id: "job1", status: jobStates.success },
  });
  vi.spyOn(main.api, "getJobInfo").mockResolvedValue(null);
  vi.spyOn(jobs, "initializeNotificationSubscription").mockResolvedValue();
  vi.spyOn(main.api, "uploadJSONFile").mockResolvedValue({
    data: { itemId: "item1" },
  } as any);
  vi.spyOn(main.api, "getItems").mockResolvedValue([]);
  vi.spyOn(main.api, "removeLargeImageForItem").mockResolvedValue({} as any);
  vi.spyOn(main.api, "generateTiles").mockResolvedValue({
    data: { _id: "job1" },
  } as any);
}

// `.rejects.toThrow(string)` only checks that the message CONTAINS the
// string. A vuex-module-decorators "ERR_ACTION_ACCESS_UNDEFINED" wrapper
// embeds the original error's message as part of its own `.stack` text, so a
// substring match would pass even when rawError is missing and the real
// message never reaches the caller as `error.message`. Assert the exact
// message instead so a regression is actually caught.
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the promise to reject, but it resolved");
}

describe("addMultiSourceMetadata error propagation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // The jobs store is real and shared: drop events these tests buffered.
    jobs.clearStoredMessages("job1");
  });

  it("surfaces the friendly storage-quota message when the transcode job fails due to quota", async () => {
    mockSuccessfulUploadAndTiles();
    vi.spyOn(jobs, "addJob").mockImplementation(async (job: any) => {
      job.eventCallback?.({
        _id: "job1",
        text:
          "Upload would exceed file storage quota (need 9.7 MB, only 1.9 " +
          "MB available - used 15.4 GB out of 15.4 GB)\n",
      });
      return false;
    });

    const message = await messageOf(
      main.addMultiSourceMetadata({
        parentId: "folder1",
        metadata: "{}",
        transcode: true,
      }),
    );

    expect(message).toBe(
      "This operation needs 9.7 MB of storage, but only 1.9 MB of your " +
        "15.4 GB quota remains (15.4 GB used). Free up space by deleting " +
        "datasets you no longer need, or upgrade your account for more " +
        "storage.",
    );
  });

  it("surfaces a plain transcode-failure message (not a mangled vuex-module-decorators error) when the job fails for an unrelated reason", async () => {
    mockSuccessfulUploadAndTiles();
    vi.spyOn(jobs, "addJob").mockResolvedValue(false);

    const message = await messageOf(
      main.addMultiSourceMetadata({
        parentId: "folder1",
        metadata: "{}",
        transcode: true,
      }),
    );

    expect(message).toBe(
      "Failed to transcode the large image: the transcoding job failed. " +
        "See the transcoding log for details.",
    );
  });

  describe("when the stream missed the end of the finished job", () => {
    // e.g. the notification stream dropped (a server restart) while the
    // in-process transcode ran. The real jobs store is used: the read job's
    // end is buffered and addJob replays it like a stream message.
    let toasts: any[];
    beforeEach(() => {
      vi.useFakeTimers();
      mockSuccessfulUploadAndTiles();
      jobs.clearStoredMessages("job1"); // the stream delivered nothing
      vi.spyOn(jobs, "initializeNotificationSubscription").mockResolvedValue();
      toasts = [];
      vi.spyOn(progress, "createNotification").mockImplementation(
        (toast: any) => {
          toasts.push(toast);
          return "toast-id";
        },
      );
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // Runs the action past the stream's grace period and any read retries.
    const configure = async (eventCallback?: (event: any) => void) => {
      const done = main.addMultiSourceMetadata({
        parentId: "folder1",
        metadata: "{}",
        transcode: true,
        eventCallback,
      });
      done.catch(() => {});
      await vi.advanceTimersByTimeAsync(60000);
      return done;
    };

    const finishedJob = (status: number, log?: string[]) =>
      vi
        .spyOn(main.api, "getJobInfo")
        .mockResolvedValue({ status, log, title: "Conversion" } as any);

    it("finishes, replaying the log entry by entry, with the usual toast", async () => {
      finishedJob(jobStates.success, [
        "Started large image conversion\n",
        "Processing frame 2/2\n",
        "Created a file of size 10\n",
      ]);
      const shown: string[] = [];
      await expect(
        configure((event) => event.text && shown.push(event.text)),
      ).resolves.toBe("item1");
      expect(shown).toEqual([
        "Started large image conversion\n",
        "Processing frame 2/2\n",
        "Created a file of size 10\n",
      ]);
      expect(toasts.map((toast) => toast.title)).toEqual([
        "Job Completed Successfully",
      ]);
      expect(jobs.messageStore.job1).toBeUndefined();
    });

    it("surfaces the quota message from the finished job's log", async () => {
      finishedJob(jobStates.error, [
        "Upload would exceed file storage quota (need 9.7 MB, only 1.9 " +
          "MB available - used 15.4 GB out of 15.4 GB)\n",
      ]);
      expect(await messageOf(configure())).toBe(
        "This operation needs 9.7 MB of storage, but only 1.9 MB of your " +
          "15.4 GB quota remains (15.4 GB used). Free up space by deleting " +
          "datasets you no longer need, or upgrade your account for more " +
          "storage.",
      );
      expect(toasts.map((toast) => toast.title)).toEqual([
        "Storage Quota Exceeded",
      ]);
    });

    it("reports a cancelled job as a failure", async () => {
      finishedJob(jobStates.cancelled);
      expect(await messageOf(configure())).toBe(
        "Failed to transcode the large image: the transcoding job failed. " +
          "See the transcoding log for details.",
      );
    });

    it("uses a log given as a single string", async () => {
      vi.spyOn(main.api, "getJobInfo").mockResolvedValue({
        status: jobStates.error,
        log:
          "Upload would exceed file storage quota (need 9.7 MB, only 1.9 " +
          "MB available - used 15.4 GB out of 15.4 GB)\n",
        title: "Conversion",
      } as any);
      expect(await messageOf(configure())).toContain(
        "only 1.9 MB of your 15.4 GB quota remains",
      );
    });

    it("finishes a job that has no log", async () => {
      finishedJob(jobStates.success);
      const shown: string[] = [];
      await expect(
        configure((event) => event.text && shown.push(event.text)),
      ).resolves.toBe("item1");
      expect(shown).toEqual([]);
    });

    it("supplies only what the stream had not delivered", async () => {
      jobs.storeMessage({
        jobId: "job1",
        event: { _id: "job1", text: "Started large image conversion\n" },
      });
      finishedJob(jobStates.success, [
        "Started large image conversion\n",
        "Created a file of size 10\n",
      ]);
      const shown: string[] = [];
      await configure((event) => event.text && shown.push(event.text));
      expect(shown).toEqual([
        "Started large image conversion\n",
        "Created a file of size 10\n",
      ]);
    });

    it("adds nothing when the stream did deliver the end", async () => {
      jobs.storeMessage({
        jobId: "job1",
        event: { _id: "job1", text: "done\n", status: jobStates.success },
      });
      finishedJob(jobStates.success, ["done\n"]);
      const shown: string[] = [];
      await configure((event) => event.text && shown.push(event.text));
      expect(shown).toEqual(["done\n"]);
      expect(toasts).toHaveLength(1);
    });

    it("retries a failed read of the job", async () => {
      vi.spyOn(main.api, "getJobInfo")
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ status: jobStates.success } as any);
      await expect(configure()).resolves.toBe("item1");
    });

    it("stops retrying the read once the stream delivers the end", async () => {
      // The first read fails; the stream reconnects during the backoff.
      const getJob = vi.spyOn(main.api, "getJobInfo").mockResolvedValue(null);
      const done = main.addMultiSourceMetadata({
        parentId: "folder1",
        metadata: "{}",
        transcode: true,
      });
      await vi.advanceTimersByTimeAsync(2500); // grace + first read
      jobs.storeMessage({
        jobId: "job1",
        event: { _id: "job1", status: jobStates.success },
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(done).resolves.toBe("item1");
      expect(getJob).toHaveBeenCalledTimes(1);
    });

    it("does not wait on a stalled read once the stream delivers the end", async () => {
      // The read hangs (same outage); the stream reconnects meanwhile.
      vi.spyOn(main.api, "getJobInfo").mockReturnValue(new Promise(() => {}));
      const done = main.addMultiSourceMetadata({
        parentId: "folder1",
        metadata: "{}",
        transcode: true,
      });
      await vi.advanceTimersByTimeAsync(3000); // past the grace period
      jobs.storeMessage({
        jobId: "job1",
        event: { _id: "job1", status: jobStates.success },
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(done).resolves.toBe("item1");
    });

    it("lets a stream that is merely late deliver the end itself", async () => {
      const getJob = finishedJob(jobStates.success, ["done\n"]);
      const done = main.addMultiSourceMetadata({
        parentId: "folder1",
        metadata: "{}",
        transcode: true,
      });
      // The real end arrives within the grace period.
      await vi.advanceTimersByTimeAsync(500);
      jobs.storeMessage({
        jobId: "job1",
        event: { _id: "job1", text: "done\n", status: jobStates.success },
      });
      await vi.advanceTimersByTimeAsync(5000);
      await expect(done).resolves.toBe("item1");
      expect(getJob).not.toHaveBeenCalled();
      expect(toasts).toHaveLength(1);
    });
  });

  it("waits on the stream as before when the job cannot be read", async () => {
    vi.useFakeTimers();
    try {
      mockSuccessfulUploadAndTiles();
      jobs.clearStoredMessages("job1"); // the stream delivered nothing
      const getJob = vi.spyOn(main.api, "getJobInfo").mockResolvedValue(null);
      const addJob = vi.spyOn(jobs, "addJob").mockResolvedValue(true);
      const done = main.addMultiSourceMetadata({
        parentId: "folder1",
        metadata: "{}",
        transcode: true,
      });
      await vi.advanceTimersByTimeAsync(60000);
      expect(getJob).toHaveBeenCalledTimes(5);
      // Nothing was made up: the stream alone decides the outcome.
      expect(jobs.messageStore.job1).toBeUndefined();
      await expect(done).resolves.toBe("item1");
      expect(addJob).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves with the item id when transcoding succeeds", async () => {
    mockSuccessfulUploadAndTiles();
    vi.spyOn(jobs, "addJob").mockResolvedValue(true);

    await expect(
      main.addMultiSourceMetadata({
        parentId: "folder1",
        metadata: "{}",
        transcode: true,
      }),
    ).resolves.toBe("item1");
  });
});

describe("addMultiSourceMetadata transcode progress", () => {
  // The transcode request runs the job in-process and returns when it is
  // done; its events reach the stream's buffer meanwhile. The real jobs
  // store is used.
  let toasts: any[];
  let shown: string[];
  let finishRequest: (value: any) => void;
  let failRequest: (error: any) => void;
  beforeEach(() => {
    vi.useFakeTimers();
    mockSuccessfulUploadAndTiles();
    jobs.clearStoredMessages("job1"); // the stream delivered nothing yet
    vi.spyOn(main.api, "generateTiles").mockReturnValue(
      new Promise((resolve, reject) => {
        finishRequest = resolve;
        failRequest = reject;
      }),
    );
    vi.spyOn(jobs, "initializeNotificationSubscription").mockResolvedValue();
    toasts = [];
    vi.spyOn(progress, "createNotification").mockImplementation(
      (toast: any) => {
        toasts.push(toast);
        return "toast-id";
      },
    );
    shown = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    jobs.clearStoredMessages("job1");
    jobs.clearStoredMessages("job2");
  });

  const configure = () => {
    const done = main.addMultiSourceMetadata({
      parentId: "folder1",
      metadata: "{}",
      transcode: true,
      eventCallback: (event) => event.text && shown.push(event.text),
    });
    done.catch(() => {});
    return done;
  };
  // What the stream buffers: the job's status event (carrying its
  // document), then log lines and the end.
  const stream = (event: Record<string, any>, jobId = "job1") =>
    jobs.storeMessage({ jobId, event: { _id: jobId, ...event } as any });
  const started = (jobId = "job1", itemId = "item1") =>
    stream(
      {
        status: jobStates.running,
        type: "large_image_tiff",
        meta: { itemId },
      },
      jobId,
    );
  const gatewayTimeout = { response: { status: 504 } };

  it("shows the job's progress while the request is still running", async () => {
    const done = configure();
    await vi.advanceTimersByTimeAsync(0);
    started();
    stream({ text: "Processing frame 1/2\n" });
    await vi.advanceTimersByTimeAsync(300);
    expect(shown).toEqual(["Processing frame 1/2\n"]);
    stream({ text: "Processing frame 2/2\n" });
    await vi.advanceTimersByTimeAsync(300);
    expect(shown).toHaveLength(2);
    stream({ status: jobStates.success });
    finishRequest({ data: { _id: "job1" } });
    await vi.advanceTimersByTimeAsync(0);
    await expect(done).resolves.toBe("item1");
    // Each line once: the replay skips what was already shown.
    expect(shown).toEqual(["Processing frame 1/2\n", "Processing frame 2/2\n"]);
    expect(toasts.map((toast) => toast.title)).toEqual([
      "Job Completed Successfully",
    ]);
    expect(jobs.messageStore.job1).toBeUndefined();
  });

  it("does not show another item's transcode", async () => {
    const done = configure();
    await vi.advanceTimersByTimeAsync(0);
    started("job2", "other-item");
    stream({ text: "someone else's frame\n" }, "job2");
    await vi.advanceTimersByTimeAsync(300);
    expect(shown).toEqual([]);
    stream({ status: jobStates.success });
    finishRequest({ data: { _id: "job1" } });
    await expect(done).resolves.toBe("item1");
    expect(shown).toEqual([]);
    expect(jobs.messageStore.job2).toHaveLength(2);
  });

  it("follows the job to its end after a gateway timeout", async () => {
    const findJob = vi.spyOn(main.api, "findTranscodeJob");
    const done = configure();
    await vi.advanceTimersByTimeAsync(0);
    started();
    stream({ text: "Processing frame 1/2\n" });
    failRequest(gatewayTimeout);
    await vi.advanceTimersByTimeAsync(1000);
    stream({ text: "Processing frame 2/2\n" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(shown).toHaveLength(2);
    stream({ status: jobStates.success });
    await vi.advanceTimersByTimeAsync(300);
    await expect(done).resolves.toBe("item1");
    expect(shown).toHaveLength(2);
    expect(findJob).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
  });

  it("finds the job by listing transcodes when the stream missed its start", async () => {
    vi.spyOn(main.api, "findTranscodeJob").mockResolvedValue({
      _id: "job1",
    } as any);
    vi.spyOn(main.api, "getJobInfo").mockResolvedValue({
      status: jobStates.success,
      log: ["Processing frame 1/1\n"],
      title: "Conversion",
    } as any);
    const done = configure();
    await vi.advanceTimersByTimeAsync(0);
    failRequest(gatewayTimeout);
    await vi.advanceTimersByTimeAsync(31000);
    await expect(done).resolves.toBe("item1");
    expect(shown).toEqual(["Processing frame 1/1\n"]);
    expect(toasts.map((toast) => toast.title)).toEqual([
      "Job Completed Successfully",
    ]);
  });

  it("keeps following a job that is still updating", async () => {
    vi.spyOn(main.api, "findTranscodeJob").mockResolvedValue({
      _id: "job1",
    } as any);
    let reads = 0;
    vi.spyOn(main.api, "getJobInfo").mockImplementation(
      async () =>
        ({ status: jobStates.running, updated: `t${++reads}` }) as any,
    );
    const done = configure();
    await vi.advanceTimersByTimeAsync(0);
    failRequest(gatewayTimeout);
    await vi.advanceTimersByTimeAsync(40 * 60 * 1000);
    stream({ status: jobStates.success });
    await vi.advanceTimersByTimeAsync(300);
    await expect(done).resolves.toBe("item1");
    expect(reads).toBeGreaterThan(60);
  });

  it("gives up on a job that stops updating", async () => {
    vi.spyOn(main.api, "findTranscodeJob").mockResolvedValue({
      _id: "job1",
    } as any);
    vi.spyOn(main.api, "getJobInfo").mockResolvedValue({
      status: jobStates.running,
      updated: "t0",
    } as any);
    const done = configure();
    await vi.advanceTimersByTimeAsync(0);
    failRequest(gatewayTimeout);
    await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
    expect(await messageOf(done)).toBe(
      "Failed to transcode the large image: the transcoding job stopped " +
        "responding. See the transcoding log for details.",
    );
  });

  it("does not wait on a stalled read of the job once the stream delivers the end", async () => {
    const getJob = vi
      .spyOn(main.api, "getJobInfo")
      .mockReturnValue(new Promise(() => {}));
    const done = configure();
    await vi.advanceTimersByTimeAsync(0);
    started();
    failRequest(gatewayTimeout);
    await vi.advanceTimersByTimeAsync(31000); // quiet: the job is read
    expect(getJob).toHaveBeenCalledTimes(1);
    stream({ text: "Processing frame 2/2\n" });
    stream({ status: jobStates.success });
    await vi.advanceTimersByTimeAsync(300);
    await expect(done).resolves.toBe("item1");
    expect(shown).toEqual(["Processing frame 2/2\n"]);
  });

  it("reports the gateway timeout when the jobs cannot be listed", async () => {
    const findJob = vi
      .spyOn(main.api, "findTranscodeJob")
      .mockRejectedValue(new Error("listing failed"));
    const done = configure();
    await vi.advanceTimersByTimeAsync(0);
    failRequest(Object.assign(new Error("Gateway Timeout"), gatewayTimeout));
    await vi.advanceTimersByTimeAsync(10000);
    expect(await messageOf(done)).toBe("Gateway Timeout");
    expect(findJob).toHaveBeenCalledTimes(3);
  });

  it("does not show other jobs on the same item", async () => {
    const done = configure();
    await vi.advanceTimersByTimeAsync(0);
    stream(
      {
        status: jobStates.running,
        type: "large_image_cache_histograms",
        meta: { itemId: "item1" },
      },
      "job2",
    );
    stream({ text: "Caching histograms\n" }, "job2");
    await vi.advanceTimersByTimeAsync(300);
    expect(shown).toEqual([]);
    stream({ status: jobStates.success });
    finishRequest({ data: { _id: "job1" } });
    await expect(done).resolves.toBe("item1");
    expect(shown).toEqual([]);
  });

  it("reopens a closed stream before the job starts", async () => {
    jobs.setNotificationSource({ readyState: WebSocket.CLOSED } as any);
    const done = configure();
    await vi.advanceTimersByTimeAsync(0);
    const [reopened] = vi.mocked(jobs.initializeNotificationSubscription).mock
      .invocationCallOrder;
    const [requested] = vi.mocked(main.api.generateTiles).mock
      .invocationCallOrder;
    expect(reopened).toBeLessThan(requested);
    stream({ status: jobStates.success });
    finishRequest({ data: { _id: "job1" } });
    await expect(done).resolves.toBe("item1");
    jobs.setNotificationSource(null);
  });

  it("fails with the request's error when no job started", async () => {
    vi.spyOn(main.api, "findTranscodeJob").mockResolvedValue(undefined);
    const done = configure();
    await vi.advanceTimersByTimeAsync(0);
    failRequest(Object.assign(new Error("Gateway Timeout"), gatewayTimeout));
    await vi.advanceTimersByTimeAsync(0);
    expect(await messageOf(done)).toBe("Gateway Timeout");
  });

  it("fails as before when the request fails otherwise", async () => {
    const findJob = vi.spyOn(main.api, "findTranscodeJob");
    const done = configure();
    await vi.advanceTimersByTimeAsync(0);
    started();
    failRequest(
      Object.assign(new Error("Server Error"), { response: { status: 500 } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await messageOf(done)).toBe("Server Error");
    expect(findJob).not.toHaveBeenCalled();
  });
});

describe("annotation-browser hydration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates plots without directly dispatching a duplicate analysis refresh", async () => {
    (main as any).setConfigurationImpl({
      id: "config-1",
      data: {
        id: "config-1",
        name: "config",
        layers: [],
        tools: [],
        scales: {},
        propertyIds: [],
        annotationBrowserConfig: { analysisPlots: [] },
      },
    });
    const actionNames: string[] = [];
    const unsubscribe = rootStore.subscribeAction(({ type }) =>
      actionNames.push(type),
    );

    await main.hydrateAnnotationBrowserState();
    unsubscribe();

    expect(actionNames).toContain("hydrateAnalysisPlots");
    expect(actionNames).toContain("hydrateTrackLabelPath");
    // Viewer owns the one refresh through its analysisInputSignature watcher;
    // hydration only changes the state that drives that watcher.
    expect(actionNames).not.toContain("refreshAnalysis");
  });
});

describe("tool pinning and ordering", () => {
  function tool(id: string, pinned?: boolean) {
    return {
      id,
      name: id,
      type: "create",
      hotkey: null,
      values: {},
      template: {},
      ...(pinned === undefined ? {} : { pinned }),
    } as any;
  }

  function setTools(tools: any[]) {
    (main as any).setConfigurationImpl({
      id: "config-1",
      data: {
        id: "config-1",
        name: "config",
        layers: [],
        tools,
        scales: {},
        propertyIds: [],
      },
    });
  }

  let updateKey: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (rootStore.state as any).main.girderUser = { _id: "u1", login: "u" };
    updateKey = vi
      .spyOn(main.api, "updateConfigurationKey")
      .mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (rootStore.state as any).main.girderUser = null;
    (main as any).setSelectedToolImpl(null);
  });

  it("pins a tool by replacing it and writing the tools key once", async () => {
    const original = tool("a");
    setTools([original, tool("b")]);

    await main.setToolPinned({ toolId: "a", pinned: true });

    expect(main.tools.map((t) => [t.id, !!t.pinned])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    // Replaced, not mutated: the old object (possibly held by a component)
    // is untouched.
    expect(original.pinned).toBeUndefined();
    expect(updateKey).toHaveBeenCalledTimes(1);
    expect(updateKey.mock.calls[0][1]).toBe("tools");
  });

  it("does not write when the pin state is unchanged or the tool is gone", async () => {
    setTools([tool("a", true)]);

    await main.setToolPinned({ toolId: "a", pinned: true });
    await main.setToolPinned({ toolId: "missing", pinned: true });

    expect(updateKey).not.toHaveBeenCalled();
  });

  it("keeps the selected tool selected, with its pin state updated", async () => {
    setTools([tool("a")]);
    main.setSelectedToolId("a");
    const selectedBefore = main.selectedTool;

    await main.setToolPinned({ toolId: "a", pinned: true });

    expect(main.selectedTool?.configuration.pinned).toBe(true);
    // Same tool-state object: pinning must not rebuild e.g. SAM state.
    expect(main.selectedTool?.state).toBe(selectedBefore?.state);
  });

  it("reorders tools, reusing the store's tool objects, with one write", async () => {
    const a = tool("a");
    const b = tool("b");
    const c = tool("c");
    setTools([a, b, c]);

    await main.setToolOrder(["c", "a", "b"]);

    expect(main.tools).toEqual([c, a, b]);
    expect(main.tools[0]).toBe(main.configuration!.tools[0]);
    expect(updateKey).toHaveBeenCalledTimes(1);
  });

  it("drops a stale order that no longer matches the toolset", async () => {
    setTools([tool("a"), tool("b"), tool("c")]);

    // A tool was removed mid-drag, added mid-drag, or the list repeats one.
    await main.setToolOrder(["b", "a"]);
    await main.setToolOrder(["b", "a", "c", "d"]);
    await main.setToolOrder(["b", "a", "d"]);
    await main.setToolOrder(["a", "a", "b"]);

    expect(main.tools.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(updateKey).not.toHaveBeenCalled();
  });

  it("an edit made with a pre-pin copy of the tool keeps the pin", async () => {
    const original = tool("a");
    setTools([original]);

    await main.setToolPinned({ toolId: "a", pinned: true });
    // e.g. AnnotationWorkerMenu's debounced save of the props.tool it held
    // before the pin landed.
    main.editToolInConfiguration({ ...original, name: "renamed" });

    expect(main.tools[0]).toMatchObject({ name: "renamed", pinned: true });
  });

  it("does not write an unchanged order", async () => {
    setTools([tool("a"), tool("b")]);

    await main.setToolOrder(["a", "b"]);

    expect(updateKey).not.toHaveBeenCalled();
  });
});

describe("tool job outcome scoping", () => {
  afterEach(() => {
    (rootStore.state as any).main.girderUser = null;
    (rootStore.state as any).main.configuration = null;
  });

  it("reports an outcome only in the user/dataset/collection it ran in", () => {
    const state = (rootStore.state as any).main;
    state.girderUser = { _id: "user-a", login: "a" };
    state.configuration = { id: "config-1", tools: [] };

    jobs.setToolJobOutcome({
      toolId: "tool-1",
      scope: jobs.toolJobScope,
      success: true,
    });
    expect(jobs.toolJobOutcome("tool-1")).toBe(true);

    // Another user on the same tab (after logout/login).
    state.girderUser = { _id: "user-b", login: "b" };
    expect(jobs.toolJobOutcome("tool-1")).toBeUndefined();

    // A duplicated collection keeps the same tool ids.
    state.girderUser = { _id: "user-a", login: "a" };
    state.configuration = { id: "config-copy", tools: [] };
    expect(jobs.toolJobOutcome("tool-1")).toBeUndefined();

    state.configuration = { id: "config-1", tools: [] };
    expect(jobs.toolJobOutcome("tool-1")).toBe(true);
  });
});
