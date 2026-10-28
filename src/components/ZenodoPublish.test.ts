import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount, VueWrapper } from "@vue/test-utils";
import { AxiosError, AxiosHeaders } from "axios";

const mocks = vi.hoisted(() => ({
  getCredentials: vi.fn(),
  uploadProject: vi.fn(),
  publishProject: vi.fn(),
  discardDraft: vi.fn(),
  getUploadStatus: vi.fn(),
  getLiveUploadJobId: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: { zenodoAPI: mocks },
}));

const jobsMock = vi.hoisted(() => ({ addJob: vi.fn() }));
vi.mock("@/store/jobs", () => ({ default: jobsMock }));

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import ZenodoPublish from "./ZenodoPublish.vue";

const OWNER_HINT =
  "requires owner access to every dataset and collection in the project";

// A real AxiosError, so the component's isAxiosError() check sees what the
// Girder client actually throws.
function serverError(status: number, message: string) {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(
    `Request failed with status code ${status}`,
    "ERR_BAD_REQUEST",
    config,
    {},
    {
      status,
      statusText: "",
      headers: {},
      config,
      data: { message, type: status === 403 ? "access" : "rest" },
    },
  );
}

function project(status?: string) {
  return {
    id: "p1",
    name: "Project",
    meta: status ? { zenodo: { status } } : {},
  } as any;
}

let wrapper: VueWrapper | null = null;

async function mountComponent(status?: string) {
  wrapper = mount(ZenodoPublish, {
    props: { project: project(status) },
    global: { stubs: { ZenodoTokenDialog: true } },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

async function clickButton(w: VueWrapper, label: string) {
  const button = w.findAll("button").find((b) => b.text().includes(label));
  expect(button, `button "${label}"`).toBeDefined();
  await button!.trigger("click");
  await flushPromises();
}

function requestError(w: VueWrapper) {
  return w.find('[data-testid="zenodo-request-error"]');
}

describe("ZenodoPublish", () => {
  beforeEach(() => {
    mocks.getCredentials.mockResolvedValue({ hasToken: true, sandbox: false });
    // The server's view: an upload is running as job-1, visible to this user.
    mocks.getUploadStatus.mockResolvedValue({
      status: "uploading",
      jobId: "job-1",
    });
    mocks.getLiveUploadJobId.mockResolvedValue("job-1");
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it("shows the server's message when the upload is refused", async () => {
    mocks.uploadProject.mockRejectedValue(
      serverError(
        400,
        "Project has 120 files, exceeding Zenodo's 100-file limit.",
      ),
    );
    const w = await mountComponent();

    await clickButton(w, "Upload to Zenodo");

    const alert = requestError(w);
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain(
      "Project has 120 files, exceeding Zenodo's 100-file limit.",
    );
    expect(alert.text()).not.toContain(OWNER_HINT);
    // Upload button comes back so the user can retry after fixing it.
    expect(w.text()).toContain("Upload to Zenodo");
  });

  it("explains owner access when a dataset refuses the upload", async () => {
    mocks.uploadProject.mockRejectedValue(
      serverError(403, "Admin access denied for folder abc (user u1)."),
    );
    const w = await mountComponent();

    await clickButton(w, "Upload to Zenodo");

    const text = requestError(w).text();
    expect(text).toContain("Admin access denied for folder abc (user u1).");
    expect(text).not.toContain("..");
    expect(text).toContain(OWNER_HINT);
  });

  it("shows a project-level 403 without the dataset hint", async () => {
    mocks.uploadProject.mockRejectedValue(
      serverError(403, "Admin access denied for upenn_project p1 (user u1)."),
    );
    const w = await mountComponent();

    await clickButton(w, "Upload to Zenodo");

    const text = requestError(w).text();
    expect(text).toContain(
      "Admin access denied for upenn_project p1 (user u1).",
    );
    expect(text).not.toContain(OWNER_HINT);
  });

  it("shows a discard refusal without the publishing hint", async () => {
    mocks.discardDraft.mockRejectedValue(
      serverError(403, "Admin access denied for folder abc (user u1)."),
    );
    const w = await mountComponent("draft");

    await clickButton(w, "Discard Draft");

    const text = requestError(w).text();
    expect(text).toContain("Admin access denied for folder abc (user u1).");
    expect(text).not.toContain(OWNER_HINT);
  });

  it("clears the error on retry and after saving a token", async () => {
    mocks.uploadProject
      .mockRejectedValueOnce(serverError(400, "No Zenodo token configured."))
      .mockRejectedValueOnce(
        serverError(400, "Zenodo token validation failed."),
      )
      .mockReturnValueOnce(new Promise(() => {}));
    const w = await mountComponent();

    await clickButton(w, "Upload to Zenodo");
    expect(requestError(w).text()).toContain("No Zenodo token configured.");

    w.findComponent({ name: "ZenodoTokenDialog" }).vm.$emit("saved");
    await flushPromises();
    expect(requestError(w).exists()).toBe(false);

    await clickButton(w, "Upload to Zenodo");
    expect(requestError(w).text()).toContain("Zenodo token validation failed.");

    // A retry that is still in flight shows no old error.
    await clickButton(w, "Upload to Zenodo");
    expect(requestError(w).exists()).toBe(false);
  });

  it("refreshes the project when an upload is already in progress", async () => {
    mocks.uploadProject.mockRejectedValue(
      serverError(409, "An upload is already in progress for this project."),
    );
    const w = await mountComponent();

    await clickButton(w, "Upload to Zenodo");

    expect(requestError(w).text()).toContain(
      "An upload is already in progress for this project.",
    );
    // Follows the other upload's job straight away (the server names it;
    // this card's project copy is stale), so the card leaves "uploading"
    // when that job ends.
    expect(mocks.getUploadStatus).toHaveBeenCalledWith("p1");
    expect(mocks.getLiveUploadJobId).toHaveBeenCalledWith("job-1");
    expect(jobsMock.addJob).toHaveBeenCalledTimes(1);
    expect(jobsMock.addJob.mock.calls[0][0].jobId).toBe("job-1");
    expect(w.emitted("updated")).toHaveLength(1);

    // The refreshed project reports it; no second subscription.
    await w.setProps({ project: project("uploading") });
    await flushPromises();
    expect(jobsMock.addJob).toHaveBeenCalledTimes(1);
  });

  it("keeps the actions locked after a 409 until the refresh lands", async () => {
    // The card still shows a stale "error"; the other tab's upload must not
    // be discarded in the window before the refreshed status arrives.
    mocks.uploadProject.mockRejectedValue(
      serverError(409, "An upload is already in progress for this project."),
    );
    const w = await mountComponent("error");

    await clickButton(w, "Upload to Zenodo");

    const discard = w
      .findAll("button")
      .find((b) => b.text().includes("Discard Draft"))!;
    expect(discard.attributes("disabled")).toBeDefined();
  });

  it("tracks an upload once, and again after it ends", async () => {
    mocks.uploadProject.mockResolvedValue({ jobId: "job-1", totalFiles: 3 });
    const w = await mountComponent();

    await clickButton(w, "Upload to Zenodo");
    expect(jobsMock.addJob).toHaveBeenCalledTimes(1);

    // The refresh this upload triggers must not subscribe a second time.
    await w.setProps({ project: project("uploading") });
    await flushPromises();
    expect(mocks.getLiveUploadJobId).not.toHaveBeenCalled();
    expect(jobsMock.addJob).toHaveBeenCalledTimes(1);

    // The job ends; a later upload (from another tab) is followed again.
    jobsMock.addJob.mock.calls[0][0].eventCallback({ status: 3 });
    await w.setProps({ project: project("draft") });
    await w.setProps({ project: project("uploading") });
    await flushPromises();
    expect(mocks.getLiveUploadJobId).toHaveBeenCalledTimes(1);
    expect(jobsMock.addJob).toHaveBeenCalledTimes(2);
  });

  it("re-reads the project when the reported upload has no job", async () => {
    // A cached project can still say "uploading" after its job ended (the
    // store doesn't refetch a cached project on navigation).
    mocks.getLiveUploadJobId.mockResolvedValue(null);
    const w = await mountComponent("uploading");

    expect(jobsMock.addJob).not.toHaveBeenCalled();
    expect(w.emitted("updated")).toHaveLength(1);
  });

  it("keeps re-reading while the upload's job is invisible", async () => {
    // A co-owner's upload: Girder never shows this user its job, so only
    // the project status can say when it ends.
    vi.useFakeTimers();
    try {
      mocks.getLiveUploadJobId.mockResolvedValue(null);
      const w = await mountComponent("uploading");
      // One status check to find the job, and an immediate re-read in case
      // the project copy is just stale.
      expect(mocks.getUploadStatus).toHaveBeenCalledTimes(1);
      expect(w.emitted("updated")).toHaveLength(1);

      // Polls the light status endpoint; no project re-read while the
      // upload is still running.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mocks.getUploadStatus).toHaveBeenCalledTimes(3);
      expect(mocks.getUploadStatus).toHaveBeenCalledWith("p1");
      expect(w.emitted("updated")).toHaveLength(1);

      // The upload ended: re-read the project. If that re-read doesn't
      // land, keep asking; stop once the card's status changes.
      mocks.getUploadStatus.mockResolvedValue({ status: "draft" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(w.emitted("updated")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(w.emitted("updated")).toHaveLength(3);
      await w.setProps({ project: project("draft") });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.getUploadStatus).toHaveBeenCalledTimes(5);
      expect(w.emitted("updated")).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps checking when the job lookup fails", async () => {
    vi.useFakeTimers();
    try {
      mocks.getUploadStatus
        .mockRejectedValueOnce(new Error("Network Error"))
        .mockResolvedValue({ status: "draft" });
      const w = await mountComponent("uploading");
      // A failed lookup asks for a re-read.
      expect(w.emitted("updated")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10_000);
      // The poll saw the upload end and re-read the project.
      expect(w.emitted("updated")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls a tracked upload too, in case its job events stop", async () => {
    // The notification socket gives up after repeated errors; then no
    // terminal event will ever say the job ended.
    vi.useFakeTimers();
    try {
      const w = await mountComponent("uploading");
      expect(jobsMock.addJob).toHaveBeenCalledTimes(1);
      mocks.getUploadStatus.mockResolvedValue({ status: "draft" });

      await vi.advanceTimersByTimeAsync(10_000);

      expect(w.emitted("updated")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the actions when the server says the upload ended", async () => {
    // Started here, but the refresh never lands: the card still shows
    // "error" and follows the job, so only the poll can unlock it.
    vi.useFakeTimers();
    try {
      mocks.uploadProject.mockResolvedValue({ jobId: "job-1", totalFiles: 3 });
      const w = await mountComponent("error");
      await clickButton(w, "Upload to Zenodo");
      const discard = () =>
        w.findAll("button").find((b) => b.text().includes("Discard Draft"))!;
      expect(discard().attributes("disabled")).toBeDefined();

      mocks.getUploadStatus.mockResolvedValue({ status: "error" });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(discard().attributes("disabled")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a slow poll doesn't release a newer upload", async () => {
    vi.useFakeTimers();
    try {
      // Upload A is tracked; a poll for it goes out and stalls.
      let resolvePoll!: (status: unknown) => void;
      const w = await mountComponent("uploading");
      mocks.getUploadStatus.mockReturnValueOnce(
        new Promise((r) => (resolvePoll = r)),
      );
      await vi.advanceTimersByTimeAsync(10_000);

      // A ends over SSE, the project re-reads as "error", and the user
      // starts upload B before the stalled poll answers.
      jobsMock.addJob.mock.calls[0][0].eventCallback({ status: 4 });
      await w.setProps({ project: project("error") });
      mocks.uploadProject.mockResolvedValue({ jobId: "job-2", totalFiles: 1 });
      await clickButton(w, "Upload to Zenodo");
      expect(jobsMock.addJob.mock.calls[1][0].jobId).toBe("job-2");

      // The stale answer about A arrives.
      resolvePoll({ status: "error" });
      await vi.advanceTimersByTimeAsync(0);

      const discard = w
        .findAll("button")
        .find((b) => b.text().includes("Discard Draft"))!;
      expect(discard.attributes("disabled")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a late event from an ended job doesn't touch a newer upload", async () => {
    vi.useFakeTimers();
    try {
      // Upload A is tracked; the poll sees it end before its SSE events.
      const w = await mountComponent("uploading");
      const jobA = jobsMock.addJob.mock.calls[0][0];
      mocks.getUploadStatus.mockResolvedValue({ status: "error" });
      await vi.advanceTimersByTimeAsync(10_000);
      await w.setProps({ project: project("error") });

      // Upload B starts.
      mocks.uploadProject.mockResolvedValue({ jobId: "job-2", totalFiles: 5 });
      await clickButton(w, "Upload to Zenodo");
      expect(jobsMock.addJob.mock.calls[1][0].jobId).toBe("job-2");

      // A's delayed events arrive.
      jobA.eventCallback({
        text: JSON.stringify({
          progress: 0.5,
          current: 1,
          total: 2,
          message: "Uploading A",
        }),
      });
      jobA.eventCallback({ status: 4 });
      await flushPromises();

      const discard = w
        .findAll("button")
        .find((b) => b.text().includes("Discard Draft"))!;
      expect(discard.attributes("disabled")).toBeDefined();
      expect(w.text()).not.toContain("Uploading A");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling when unmounted", async () => {
    vi.useFakeTimers();
    try {
      mocks.getLiveUploadJobId.mockResolvedValue(null);
      const w = await mountComponent("uploading");
      w.unmount();
      wrapper = null;
      await vi.advanceTimersByTimeAsync(30_000);
      // Only the mount-time job lookup; no poll.
      expect(mocks.getUploadStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules nothing if unmounted while looking up the job", async () => {
    vi.useFakeTimers();
    try {
      let resolveStatus!: (status: unknown) => void;
      mocks.getUploadStatus.mockReturnValueOnce(
        new Promise((r) => (resolveStatus = r)),
      );
      const w = await mountComponent("uploading");
      w.unmount();
      wrapper = null;
      resolveStatus({ status: "uploading", jobId: "job-1" });
      await vi.advanceTimersByTimeAsync(30_000);
      // No job read, subscription or poll from the dead card.
      expect(mocks.getUploadStatus).toHaveBeenCalledTimes(1);
      expect(mocks.getLiveUploadJobId).not.toHaveBeenCalled();
      expect(jobsMock.addJob).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-enables the actions when the upload ends without its job event", async () => {
    // e.g. the notification socket gave up: the terminal event never comes,
    // but the re-read project says the upload is over.
    mocks.uploadProject.mockResolvedValue({ jobId: "job-1", totalFiles: 3 });
    const w = await mountComponent();
    await clickButton(w, "Upload to Zenodo");
    await w.setProps({ project: project("uploading") });
    await w.setProps({ project: project("draft") });
    await flushPromises();

    const mint = w
      .findAll("button")
      .find((b) => b.text().includes("Publish (Mint DOI)"))!;
    expect(mint.attributes("disabled")).toBeUndefined();
    expect(w.text()).not.toContain("Upload in progress");
  });

  it("can't upload while a discard is running", async () => {
    mocks.discardDraft.mockReturnValue(new Promise(() => {}));
    const w = await mountComponent("error");

    await clickButton(w, "Discard Draft");

    // Both would change the same deposition and meta.zenodo.
    const upload = w
      .findAll("button")
      .find((b) => b.text().includes("Upload to Zenodo"))!;
    expect(upload.attributes("disabled")).toBeDefined();
  });

  it("can't discard an upload that started before the refresh lands", async () => {
    mocks.uploadProject.mockResolvedValue({ jobId: "job-1", totalFiles: 3 });
    const w = await mountComponent("error");

    await clickButton(w, "Upload to Zenodo");

    // The request finished, but the project still says "error" until the
    // refresh: Discard is still shown and must stay disabled.
    const discard = w
      .findAll("button")
      .find((b) => b.text().includes("Discard Draft"))!;
    expect(discard.attributes("disabled")).toBeDefined();
  });

  it("can't discard while an upload is starting", async () => {
    mocks.uploadProject.mockReturnValue(new Promise(() => {}));
    const w = await mountComponent("error");

    await clickButton(w, "Upload to Zenodo");

    // Discard would overwrite the 'uploading' status the upload just set.
    const discard = w
      .findAll("button")
      .find((b) => b.text().includes("Discard Draft"))!;
    expect(discard.attributes("disabled")).toBeDefined();
  });

  it("follows an upload already running when it mounts", async () => {
    await mountComponent("uploading");
    expect(mocks.getLiveUploadJobId).toHaveBeenCalledWith("job-1");
    expect(jobsMock.addJob).toHaveBeenCalledTimes(1);
  });

  it("keeps each request's error in its own place", async () => {
    mocks.uploadProject.mockRejectedValue(
      serverError(400, "No Zenodo token configured."),
    );
    let rejectDiscard!: (e: unknown) => void;
    mocks.discardDraft.mockReturnValue(
      new Promise((_, reject) => (rejectDiscard = reject)),
    );
    const w = await mountComponent("error");

    await clickButton(w, "Upload to Zenodo");
    await clickButton(w, "Discard Draft");
    rejectDiscard(serverError(500, "Discard failed."));
    await flushPromises();

    // Starting the discard did not hide the upload's error.
    const texts = w
      .findAll('[data-testid="zenodo-request-error"]')
      .map((a) => a.text());
    expect(texts).toEqual([
      expect.stringContaining("No Zenodo token configured."),
      expect.stringContaining("Discard failed."),
    ]);
  });

  it("does not let publish and discard overlap", async () => {
    mocks.discardDraft.mockReturnValue(new Promise(() => {}));
    mocks.publishProject.mockReturnValue(new Promise(() => {}));
    const w = await mountComponent("draft");
    const mintButton = () =>
      w.findAll("button").find((b) => b.text().includes("Publish (Mint DOI)"))!;

    await clickButton(w, "Discard Draft");
    // A discard in flight would make the publish dialog's error belong to
    // discard, and could publish a draft that is being deleted.
    expect(mintButton().attributes("disabled")).toBeDefined();

    w.unmount();
    const w2 = await mountComponent("draft");
    await clickButton(w2, "Publish (Mint DOI)");
    Array.from(document.body.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "Publish")!
      .click();
    await flushPromises();
    // Cancelling a pending publish would orphan its error.
    const cancel = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Cancel",
    )!;
    expect(cancel.disabled).toBe(true);
  });

  it("shows the server's message in the publish dialog", async () => {
    mocks.publishProject.mockRejectedValue(
      serverError(
        403,
        "Admin access denied for upenn_collection c1 (user u1).",
      ),
    );
    const w = await mountComponent("draft");

    await clickButton(w, "Publish (Mint DOI)");

    // The dialog is teleported to <body>, outside the wrapper.
    const confirm = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Publish",
    )!;
    confirm.click();
    await flushPromises();

    const alert = document.body.querySelector(
      '[data-testid="zenodo-publish-error"]',
    );
    expect(alert?.textContent).toContain(
      "Admin access denied for upenn_collection c1 (user u1).",
    );
    expect(alert?.textContent).toContain(OWNER_HINT);
    // Dialog stays open on failure, and the card doesn't repeat the error.
    expect((w.vm as any).confirmPublish).toBe(true);
    expect(requestError(w).exists()).toBe(false);
  });
});
