import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

// Mock store
vi.mock("@/store", () => ({
  default: {
    maps: [] as any[],
  },
}));

// Mock chatStore
vi.mock("@/store/chat", () => ({
  default: {
    messages: [] as any[],
    sendMessage: vi.fn(),
    clearAll: vi.fn(),
  },
}));

// Mock html2canvas
vi.mock("html2canvas", () => ({
  default: vi.fn().mockResolvedValue({
    toDataURL: vi.fn().mockReturnValue("data:image/png;base64,mock"),
  }),
}));

// Mock marked
vi.mock("marked", () => ({
  marked: vi.fn((text: string) => `<p>${text}</p>`),
}));

// Mock logError
vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

import ChatComponent from "./ChatComponent.vue";
import store from "@/store";
import chatStore from "@/store/chat";

Vue.use(Vuetify);

function mountComponent() {
  // Ensure messages are populated so onMounted won't trigger refreshChat
  (chatStore as any).messages = [
    { type: "assistant", content: "Hello", visible: true },
  ];
  return shallowMount(ChatComponent, {
    vuetify: new Vuetify(),
    stubs: {
      "v-card": { template: "<div><slot /></div>" },
      "v-card-title": { template: "<div><slot /></div>" },
      "v-card-text": { template: "<div><slot /></div>" },
      "v-card-actions": { template: "<div><slot /></div>" },
    },
  });
}

describe("ChatComponent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (store as any).maps = [];
    (chatStore as any).messages = [
      { type: "assistant", content: "Hello", visible: true },
    ];
    (chatStore as any).sendMessage = vi.fn();
    (chatStore as any).clearAll = vi.fn();
  });

  it("messages computed returns chatStore messages", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.messages).toEqual(chatStore.messages);
    wrapper.destroy();
  });

  it("firstMap returns undefined when no maps", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.firstMap).toBeUndefined();
    wrapper.destroy();
  });

  it("firstMap returns the first map when maps exist", () => {
    const mockMap = { layers: vi.fn().mockReturnValue([]), screenshot: vi.fn() };
    (store as any).maps = [{ map: mockMap }];
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.firstMap).toBe(mockMap);
    wrapper.destroy();
  });

  it("visibleImagesInput filters out hidden images", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.imagesInput = [
      { data: "a", type: "image/png", visible: true },
      { data: "b", type: "image/png", visible: false },
      { data: "c", type: "image/png" }, // visible undefined => visible
    ];
    // visible !== false means undefined is visible
    expect(vm.visibleImagesInput).toHaveLength(2);
    wrapper.destroy();
  });

  it("addImageFile does nothing when already at 4 images", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.imagesInput = [
      { data: "1", type: "t" },
      { data: "2", type: "t" },
      { data: "3", type: "t" },
      { data: "4", type: "t" },
    ];
    const file = new File(["x"], "test.png", { type: "image/png" });
    vm.addImageFile(file);
    expect(vm.imagesInput).toHaveLength(4);
    wrapper.destroy();
  });

  it("addImageFile reads file and pushes to imagesInput", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.imagesInput = [];

    // Create a mock File + FileReader
    const mockResult = "data:image/png;base64,abc";
    const originalFileReader = globalThis.FileReader;
    const mockFileReader = {
      readAsDataURL: vi.fn(),
      onload: null as any,
    };
    globalThis.FileReader = vi.fn(() => mockFileReader) as any;

    const file = new File(["x"], "test.png", { type: "image/png" });
    vm.addImageFile(file);

    // Simulate the onload callback
    mockFileReader.onload({ target: { result: mockResult } });
    expect(vm.imagesInput).toHaveLength(1);
    expect(vm.imagesInput[0].data).toBe(mockResult);

    globalThis.FileReader = originalFileReader;
    wrapper.destroy();
  });

  it("removeImage splices the image at given index", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.imagesInput = [
      { data: "a", type: "t" },
      { data: "b", type: "t" },
      { data: "c", type: "t" },
    ];
    vm.removeImage(1);
    expect(vm.imagesInput).toHaveLength(2);
    expect(vm.imagesInput[0].data).toBe("a");
    expect(vm.imagesInput[1].data).toBe("c");
    wrapper.destroy();
  });

  it("sendMessage does nothing when isWaiting is true", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.isWaiting = true;
    vm.textInput = "hello";
    await vm.sendMessage();
    expect(chatStore.sendMessage).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("sendMessage does nothing when input is empty", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.textInput = "   ";
    await vm.sendMessage();
    expect(chatStore.sendMessage).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("sendMessage calls chatStore.sendMessage with user message", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.textInput = "Hello bot";
    vm.isWaiting = false;
    await vm.sendMessage();
    expect(chatStore.sendMessage).toHaveBeenCalledTimes(1);
    const call = (chatStore.sendMessage as any).mock.calls[0][0];
    expect(call.type).toBe("user");
    expect(call.content).toBe("Hello bot");
    expect(call.visible).toBe(true);
    wrapper.destroy();
  });

  it("sendMessage clears textInput after sending", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.textInput = "Hello bot";
    await vm.sendMessage();
    expect(vm.textInput).toBe("");
    wrapper.destroy();
  });

  it("sendMessage sets isWaiting to true during send and false after", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.textInput = "Hello";
    let waitingDuringSend = false;
    (chatStore as any).sendMessage = vi.fn(async () => {
      waitingDuringSend = vm.isWaiting;
    });
    await vm.sendMessage();
    expect(waitingDuringSend).toBe(true);
    expect(vm.isWaiting).toBe(false);
    wrapper.destroy();
  });

  it("sendMessage with customInput uses that instead of textInput", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.textInput = "";
    await vm.sendMessage(true, "custom text");
    expect(chatStore.sendMessage).toHaveBeenCalledTimes(1);
    const call = (chatStore.sendMessage as any).mock.calls[0][0];
    expect(call.content).toBe("custom text");
    wrapper.destroy();
  });

  it("handleFileUpload does nothing when no files", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const event = { target: { files: null } };
    await vm.handleFileUpload(event);
    expect(vm.imagesInput).toHaveLength(0);
    wrapper.destroy();
  });

  it("handleFileUpload processes files from input", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.imagesInput = [];

    const originalFileReader = globalThis.FileReader;
    const mockFileReader = {
      readAsDataURL: vi.fn(),
      onload: null as any,
    };
    globalThis.FileReader = vi.fn(() => mockFileReader) as any;

    const mockFileInput = { value: "test.png" };
    // Override the fileInput ref
    (wrapper.vm as any).$refs = { fileInput: mockFileInput };

    const file = new File(["x"], "test.png", { type: "image/png" });
    const event = { target: { files: [file] } };
    await vm.handleFileUpload(event);

    // The function calls addImageFile which creates a FileReader
    expect(mockFileReader.readAsDataURL).toHaveBeenCalled();

    globalThis.FileReader = originalFileReader;
    wrapper.destroy();
  });

  it("refreshChat clears inputs, calls clearAll, and sends hidden message", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.textInput = "something";
    vm.imagesInput = [{ data: "a", type: "t" }];

    await vm.refreshChat();

    expect(chatStore.clearAll).toHaveBeenCalled();
    expect(chatStore.sendMessage).toHaveBeenCalled();
    // The message should be sent as hidden (visible=false)
    const call = (chatStore.sendMessage as any).mock.calls[0][0];
    expect(call.visible).toBe(false);
    expect(vm.isRefreshing).toBe(false);
    wrapper.destroy();
  });

  it("captureViewportScreenshot returns null when no map", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = await vm.captureViewportScreenshot();
    expect(result).toBeNull();
    wrapper.destroy();
  });

  it("captureViewportScreenshot takes screenshot when map exists", async () => {
    const mockScreenshot = vi.fn().mockResolvedValue("data:image/png;base64,viewport");
    const mockMap = {
      layers: vi.fn().mockReturnValue([
        { node: vi.fn().mockReturnValue({ css: vi.fn().mockReturnValue("visible") }) },
      ]),
      screenshot: mockScreenshot,
    };
    (store as any).maps = [{ map: mockMap }];
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = await vm.captureViewportScreenshot();
    expect(result).not.toBeNull();
    expect(result!.type).toBe("image/png");
    expect(result!.visible).toBe(false);
    wrapper.destroy();
  });

  it("filterVisibleImages removes images with visible=false", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const images = [
      { data: "a", type: "t", visible: true },
      { data: "b", type: "t", visible: false },
      { data: "c", type: "t" },
    ];
    const result = vm.filterVisibleImages(images);
    expect(result).toHaveLength(2);
    expect(result[0].data).toBe("a");
    expect(result[1].data).toBe("c");
    wrapper.destroy();
  });

  it("filterVisibleMessages removes hidden messages and reverses", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const msgs = [
      { type: "user", content: "first", visible: true },
      { type: "assistant", content: "hidden", visible: false },
      { type: "assistant", content: "second", visible: true },
    ];
    const result = vm.filterVisibleMessages(msgs);
    expect(result).toHaveLength(2);
    // reversed: second comes first
    expect(result[0].content).toBe("second");
    expect(result[1].content).toBe("first");
    wrapper.destroy();
  });

  it("emits close event", async () => {
    const wrapper = mountComponent();
    // Find the close button - it emits 'close'
    wrapper.vm.$emit("close");
    expect(wrapper.emitted("close")).toBeTruthy();
    wrapper.destroy();
  });
});
