import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  store: { api: { getJobInfo: vi.fn() } },
  jobsStore: { getJobLog: vi.fn().mockReturnValue("") },
}));

vi.mock("@/store/index", () => ({ default: h.store }));
vi.mock("@/store/jobs", () => ({ default: h.jobsStore }));
vi.mock("@/utils/jobLog", () => ({
  formatJobLogHeader: (job: { _id: string }) => `header:${job._id}\n`,
}));
vi.mock("@/utils/clipboard", () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import JobLogDialog from "./JobLogDialog.vue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.jobsStore.getJobLog.mockReturnValue("");
});

describe("JobLogDialog", () => {
  it("does not let an older request overwrite a newly selected job", async () => {
    const oldRequest = deferred<any>();
    const newRequest = deferred<any>();
    h.store.api.getJobInfo.mockImplementation((jobId: string) =>
      jobId === "old" ? oldRequest.promise : newRequest.promise,
    );
    const wrapper = shallowMount(JobLogDialog, {
      props: { modelValue: false, jobId: "old" },
    });

    await wrapper.setProps({ modelValue: true });
    await wrapper.setProps({ jobId: "new" });
    newRequest.resolve({ _id: "new", log: "new log" });
    await newRequest.promise;
    await nextTick();
    oldRequest.resolve({ _id: "old", log: "old log" });
    await oldRequest.promise;
    await nextTick();

    expect((wrapper.vm as any).displayedLog).toBe("header:new\nnew log");
  });
});
