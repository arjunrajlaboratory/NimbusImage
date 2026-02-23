import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

vi.mock("@/store/index", () => ({
  default: {
    api: {
      getUserJobs: vi.fn().mockResolvedValue([
        {
          _id: "j1",
          title: "Job 1",
          type: "worker",
          status: 3,
          args: ["image1"],
          created: "2024-01-15T10:00:00Z",
          timestamps: [{ status: 3, time: "2024-01-15T10:05:00Z" }],
        },
      ]),
      getJobInfo: vi.fn().mockResolvedValue({
        _id: "j1",
        title: "Job 1",
        type: "worker",
        status: 3,
        args: ["image1"],
        created: "2024-01-15T10:00:00Z",
        timestamps: [{ status: 3, time: "2024-01-15T10:05:00Z" }],
        log: "Some log output",
      }),
    },
  },
}));

import JobsLogs from "./JobsLogs.vue";
import store from "@/store/index";

function mountComponent() {
  return shallowMount(JobsLogs, {
  });
}

describe("JobsLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("showJobs sets dialog true and calls fetchJobs", async () => {
    const wrapper = mountComponent();
    await (wrapper.vm as any).showJobs();
    expect((wrapper.vm as any).showJobsDialog).toBe(true);
    expect(store.api.getUserJobs).toHaveBeenCalledWith(20);
  });

  it("getStatusColor returns correct color for success", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).getStatusColor(3)).toBe("green");
  });

  it("getStatusColor returns grey for unknown status", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).getStatusColor(999)).toBe("grey");
  });

  it("getStatusText returns correct text for running", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).getStatusText(2)).toBe("Running");
  });

  it("getStatusText returns Unknown for unknown status", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).getStatusText(999)).toBe("Unknown");
  });

  it("getFirstArg returns first arg", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).getFirstArg({ args: ["image1", "arg2"] })).toBe("image1");
  });

  it("getFirstArg returns empty for no args", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).getFirstArg({ args: [] })).toBe("");
  });

  it("getDuration calculates from timestamps", () => {
    const wrapper = mountComponent();
    const result = (wrapper.vm as any).getDuration({
      created: "2024-01-15T10:00:00Z",
      status: 3,
      timestamps: [{ status: 3, time: "2024-01-15T10:05:00Z" }],
    });
    expect(result).toContain("05");
  });

  it("getDuration returns N/A for jobs without end timestamp", () => {
    const wrapper = mountComponent();
    const result = (wrapper.vm as any).getDuration({
      created: "2024-01-15T10:00:00Z",
      status: 0,
      timestamps: [],
    });
    expect(result).toBe("N/A");
  });

  it("headers has expected columns", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).headers).toHaveLength(8);
    expect((wrapper.vm as any).headers[0].title).toBe("Title");
  });
});
