import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { resolveVisibilityConfig } from "@/store/model";

const h = vi.hoisted(() => ({
  annotationStore: {
    visibilityConfig: {} as ReturnType<
      typeof import("@/store/model").resolveVisibilityConfig
    >,
    updateVisibilityConfig: vi.fn(),
    resetVisibilityConfig: vi.fn(),
  },
}));

vi.mock("@/store/annotation", async () => {
  const { reactive } = await import("vue");
  h.annotationStore = reactive(h.annotationStore);
  return { default: h.annotationStore };
});

import VisibilitySettings from "./VisibilitySettings.vue";

describe("VisibilitySettings", () => {
  beforeEach(() => {
    h.annotationStore.visibilityConfig = resolveVisibilityConfig();
    vi.clearAllMocks();
  });

  it("updates numeric drafts when configuration settings hydrate", async () => {
    const wrapper = mount(VisibilitySettings);

    h.annotationStore.visibilityConfig = resolveVisibilityConfig({
      maxVisible: 75000,
    });
    await nextTick();

    expect((wrapper.vm as any).draft.maxVisible).toBe(75000);
  });
});
