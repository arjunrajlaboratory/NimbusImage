import { describe, it, expect, vi, afterEach } from "vitest";
import { flushPromises, mount, VueWrapper } from "@vue/test-utils";

vi.mock("@/store/aiPanel", () => ({
  default: {
    items: [],
    running: false,
    canRevert: false,
    autoApprove: false,
    pendingApprovalIndex: null,
    setAutoApprove: vi.fn(),
    requestStop: vi.fn(),
    approvePendingTool: vi.fn(),
    sendUserMessage: vi.fn(),
  },
  setAgentPanelElement: vi.fn(),
}));

vi.mock("./AiPanelPlot.vue", () => ({
  default: { template: "<div />" },
}));

import AiPanel from "./AiPanel.vue";
import aiPanelStore from "@/store/aiPanel";
import { aiPromptRequest } from "@/commands/requests";

let wrapper: VueWrapper<any> | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  aiPromptRequest.value = null;
});

describe("AiPanel", () => {
  it("fills its input from a palette request made before it mounted, without sending", async () => {
    aiPromptRequest.value = "count the nuclei";
    wrapper = mount(AiPanel, { attachTo: document.body });
    await flushPromises();
    const textarea = wrapper.find("textarea");
    expect((textarea.element as HTMLTextAreaElement).value).toBe(
      "count the nuclei",
    );
    expect(document.activeElement).toBe(textarea.element);
    expect(aiPromptRequest.value).toBe(null);
    expect(aiPanelStore.sendUserMessage).not.toHaveBeenCalled();
  });

  it("takes a request that arrives while it is open", async () => {
    wrapper = mount(AiPanel);
    aiPromptRequest.value = "make a plot";
    await flushPromises();
    expect(
      (wrapper.find("textarea").element as HTMLTextAreaElement).value,
    ).toBe("make a plot");
    expect(aiPromptRequest.value).toBe(null);
  });

  it("keeps an unsent draft, adding the prompt on a new line", async () => {
    wrapper = mount(AiPanel);
    await wrapper.find("textarea").setValue("first part  ");
    aiPromptRequest.value = "second part";
    await flushPromises();
    expect(
      (wrapper.find("textarea").element as HTMLTextAreaElement).value,
    ).toBe("first part\nsecond part");
  });
});
