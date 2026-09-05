import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  searchTranscriptGenes: vi.fn(),
  ensureSchema: vi.fn(),
  refreshSchema: vi.fn(),
  goToCell: vi.fn(),
  setSymbols: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1" },
    spatialAPI: { searchTranscriptGenes: mocks.searchTranscriptGenes },
  },
}));

vi.mock("@/store/transcripts", async () => {
  const { reactive } = await import("vue");
  return {
    DEFAULT_TRANSCRIPT_MIN_QV: 20,
    MAX_TRANSCRIPT_GENES: 8,
    TRANSCRIPT_POINT_BUDGETS: [100000, 300000],
    default: reactive({
      hasTranscripts: true,
      error: null as string | null,
      schema: { levels: 7 },
      enabled: true,
      genes: [{ symbol: "CD3E", color: "#FF0000" }],
      symbols: ["CD3E"],
      minQv: 20,
      mode: "auto",
      pointBudget: 300000,
      status: null as any,
      readout: null as any,
      ensureSchema: mocks.ensureSchema,
      refreshSchema: mocks.refreshSchema,
      loading: false,
      goToCell: mocks.goToCell,
      setSymbols: mocks.setSymbols,
      setReadout: vi.fn(),
    }),
  };
});

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));
vi.mock("@/utils/errors", () => ({
  extractErrorMessage: (error: any) => error?.message ?? String(error),
}));

import TranscriptsPanel from "./TranscriptsPanel.vue";
import transcriptsStore from "@/store/transcripts";

describe("TranscriptsPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.searchTranscriptGenes.mockReset().mockResolvedValue(["CD3E", "CD2"]);
    mocks.ensureSchema.mockClear();
    mocks.refreshSchema.mockClear();
    mocks.goToCell.mockReset();
    mocks.setSymbols.mockClear();
    (transcriptsStore as any).status = null;
    (transcriptsStore as any).readout = null;
    (transcriptsStore as any).enabled = true;
    (transcriptsStore as any).schema = { levels: 7, transform: null };
    (transcriptsStore as any).hasTranscripts = true;
    (transcriptsStore as any).error = null;
    (transcriptsStore as any).mode = "auto";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("looks the registration up only when shown", async () => {
    const wrapper = shallowMount(TranscriptsPanel, {
      props: { visible: false },
    });
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    await wrapper.setProps({ visible: true });
    expect(mocks.ensureSchema).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.searchTranscriptGenes).toHaveBeenCalledWith("ds1", "", 25);
  });

  it("offers an explicit retry after schema failure", async () => {
    (transcriptsStore as any).hasTranscripts = false;
    (transcriptsStore as any).error = "Could not read the transcript store.";
    const wrapper = shallowMount(TranscriptsPanel, {
      props: { visible: false },
      global: {
        stubs: {
          VBtn: {
            props: ["disabled"],
            template: '<button :disabled="disabled"><slot /></button>',
          },
        },
      },
    });
    const retry = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Retry"));
    expect(retry).toBeDefined();
    await retry!.trigger("click");
    expect(mocks.refreshSchema).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("describes what the overlay is doing", async () => {
    const wrapper = shallowMount(TranscriptsPanel, {
      props: { visible: true },
    });
    const vm = wrapper.vm as any;
    expect(vm.statusText).toBe("Loading…");
    (transcriptsStore as any).status = {
      rendering: "points",
      level: 0,
      points: 1234,
      note: null,
    };
    await nextTick();
    expect(vm.statusText).toBe("1,234 molecules (pyramid level 0).");
    (transcriptsStore as any).status = {
      rendering: "density",
      level: 3,
      points: 0,
      note: "Zoomed out.",
    };
    await nextTick();
    expect(vm.statusText).toBe("Density heat map. Zoomed out.");
    (transcriptsStore as any).enabled = false;
    await nextTick();
    expect(vm.statusText).toBe("Overlay off.");
  });

  it("disables heat maps for transformed registrations and explains why", () => {
    (transcriptsStore as any).mode = "density";
    (transcriptsStore as any).schema.transform = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const wrapper = shallowMount(TranscriptsPanel, {
      props: { visible: false },
      global: {
        stubs: {
          VBtnToggle: { template: "<div><slot /></div>" },
          VBtn: {
            props: ["value", "disabled"],
            template:
              '<button :value="value" :disabled="disabled"><slot /></button>',
          },
        },
      },
    });
    expect(
      (wrapper.find('[value="density"]').element as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(wrapper.text()).toContain("Transformed registrations use points");
    expect((wrapper.vm as any).renderMode).toBe("points");
    wrapper.unmount();
  });

  it("explains the clicked molecule's cell and navigates to it", async () => {
    const wrapper = shallowMount(TranscriptsPanel, {
      props: { visible: true },
    });
    const vm = wrapper.vm as any;
    (transcriptsStore as any).readout = {
      symbol: "CD3E",
      x: 1,
      y: 2,
      quality: 30,
      annotationId: null,
    };
    await nextTick();
    expect(vm.cellText).toBe("Not inside a drawn cell outline.");
    await vm.goToCell();
    expect(mocks.goToCell).not.toHaveBeenCalled();
    (transcriptsStore as any).readout.annotationId = "ann12";
    await nextTick();
    expect(vm.cellText).toBe("Inside a segmented cell.");
    mocks.goToCell.mockResolvedValue(undefined);
    await vm.goToCell();
    expect(mocks.goToCell).toHaveBeenCalledWith("ann12");
    expect(vm.navigateError).toBeNull();
    mocks.goToCell.mockRejectedValue(new Error("offline"));
    await vm.goToCell();
    expect(vm.navigateError).toBe("offline");
  });

  it("hands picked symbols to the store and debounces the search", async () => {
    const wrapper = shallowMount(TranscriptsPanel, {
      props: { visible: true },
    });
    const vm = wrapper.vm as any;
    await vi.advanceTimersByTimeAsync(300);
    mocks.searchTranscriptGenes.mockClear();
    vm.onSearch("c");
    vm.onSearch("cd");
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.searchTranscriptGenes).toHaveBeenCalledTimes(1);
    expect(mocks.searchTranscriptGenes).toHaveBeenCalledWith("ds1", "cd", 25);
    vm.onSymbols(["CD3E", "CD2"]);
    expect(mocks.setSymbols).toHaveBeenCalledWith(["CD3E", "CD2"]);
  });
});
