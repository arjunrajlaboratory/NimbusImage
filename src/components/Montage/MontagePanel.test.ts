import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises, VueWrapper } from "@vue/test-utils";

const logError = vi.hoisted(() => vi.fn());
vi.mock("@/utils/log", () => ({ logError }));

import MontagePanel from "./MontagePanel.vue";
import { MontageCropError } from "@/utils/montage";

// A loader whose requests resolve on demand, with release spies.
function fakeLoader() {
  const requests = new Map<
    string,
    { resolve: (image: any) => void; release: ReturnType<typeof vi.fn> }
  >();
  return {
    requests,
    load: vi.fn((url: URL) => {
      let resolve!: (image: any) => void;
      const promise = new Promise((res) => (resolve = res));
      const release = vi.fn();
      requests.set(url.href, { resolve, release });
      return { promise, release };
    }),
  };
}

const rect = (left: number) => ({ left, top: 0, right: left + 10, bottom: 10 });
const crop = (n: number) => ({
  url: new URL(`http://host/region?n=${n}`),
  imageRect: rect(n),
});

const content = {
  window: { left: 0, top: 0, right: 20, bottom: 20 },
  outline: null,
  color: "#fff",
  indexLabel: null,
  textLines: [],
};

let wrapper: VueWrapper<any> | null = null;
let savedObserver: any;

function mountPanel(props: {
  loader: ReturnType<typeof fakeLoader>;
  loadCrop: (key: string) => Promise<any>;
  cropKey: string | null;
}) {
  wrapper = mount(MontagePanel, {
    props: {
      content,
      size: 100,
      pixelRatio: 1,
      selected: false,
      hovered: false,
      ...props,
      // The fake implements only the loader's load().
      loader: props.loader as any,
    },
    global: {
      stubs: {
        VIcon: { template: "<i />" },
        VBtn: {
          // The panel's click listener falls through to this root button.
          template: "<button class='goto'><slot /></button>",
        },
      },
    },
  });
  return wrapper;
}

describe("MontagePanel", () => {
  beforeEach(() => {
    // Without IntersectionObserver the panel counts as visible at once.
    savedObserver = (globalThis as any).IntersectionObserver;
    delete (globalThis as any).IntersectionObserver;
    // jsdom has no canvas; these tests assert state, not pixels.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    logError.mockClear();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    (globalThis as any).IntersectionObserver = savedObserver;
  });

  it("shows its crop at the rect that crop was fetched for", async () => {
    const loader = fakeLoader();
    const loadCrop = vi.fn(async () => crop(1));
    const w = mountPanel({ loader, loadCrop, cropKey: "1:a" });
    await flushPromises();
    loader.requests.get(crop(1).url.href)!.resolve({ id: "image1" });
    await flushPromises();
    expect(loadCrop).toHaveBeenCalledWith("1:a");
    expect(w.vm.loaded).toEqual({
      image: { id: "image1" },
      imageRect: rect(1),
    });
  });

  it("keeps the old crop until its replacement has loaded", async () => {
    const loader = fakeLoader();
    const loadCrop = vi.fn(async (key: string) =>
      key === "1:a" ? crop(1) : crop(2),
    );
    const w = mountPanel({ loader, loadCrop, cropKey: "1:a" });
    await flushPromises();
    loader.requests.get(crop(1).url.href)!.resolve({ id: "image1" });
    await flushPromises();

    // Settling: no key. The image stays.
    await w.setProps({ cropKey: null });
    expect(w.vm.loaded.image).toEqual({ id: "image1" });

    await w.setProps({ cropKey: "2:a" });
    await flushPromises();
    expect(w.vm.loaded.image).toEqual({ id: "image1" });
    const first = loader.requests.get(crop(1).url.href)!;
    expect(first.release).not.toHaveBeenCalled();

    loader.requests.get(crop(2).url.href)!.resolve({ id: "image2" });
    await flushPromises();
    expect(w.vm.loaded).toEqual({
      image: { id: "image2" },
      imageRect: rect(2),
    });
    // The old image is let go only once replaced.
    expect(first.release).toHaveBeenCalled();
  });

  it("shows an expected build error without logging it", async () => {
    const loader = fakeLoader();
    const loadCrop = vi.fn(async () => {
      throw new MontageCropError("Object is outside the image");
    });
    const w = mountPanel({ loader, loadCrop, cropKey: "1:a" });
    await flushPromises();
    expect(w.vm.error).toBe("Object is outside the image");
    expect(w.vm.loaded).toBeNull();
    expect(logError).not.toHaveBeenCalled();
  });

  it("logs a real fetch failure", async () => {
    const loader = fakeLoader();
    const loadCrop = vi.fn(async () => {
      throw new Error("500");
    });
    mountPanel({ loader, loadCrop, cropKey: "1:a" });
    await flushPromises();
    expect(logError).toHaveBeenCalled();
  });

  it("navigates from its button without toggling selection", async () => {
    const loader = fakeLoader();
    const w = mountPanel({
      loader,
      loadCrop: vi.fn(() => new Promise(() => {})),
      cropKey: null,
    });
    await w.find("button.goto").trigger("click");
    expect(w.emitted("navigate")).toHaveLength(1);
    expect(w.emitted("toggle-select")).toBeUndefined();
  });

  it("releases its crop on unmount", async () => {
    const loader = fakeLoader();
    const w = mountPanel({
      loader,
      loadCrop: vi.fn(async () => crop(1)),
      cropKey: "1:a",
    });
    await flushPromises();
    loader.requests.get(crop(1).url.href)!.resolve({ id: "image1" });
    await flushPromises();
    w.unmount();
    wrapper = null;
    expect(loader.requests.get(crop(1).url.href)!.release).toHaveBeenCalled();
  });

  it("frees its image and canvas when scrolled away, and reloads on return", async () => {
    // A controllable observer: tests flip intersection by hand.
    let notify!: (isIntersecting: boolean) => void;
    (globalThis as any).IntersectionObserver = class {
      constructor(callback: (entries: any[]) => void) {
        notify = (isIntersecting) => callback([{ isIntersecting }]);
      }
      observe() {}
      disconnect() {}
    };
    const loader = fakeLoader();
    const loadCrop = vi.fn(async () => crop(1));
    const w = mountPanel({ loader, loadCrop, cropKey: "1:a" });
    // Off screen at mount: nothing requested, no backing store.
    await flushPromises();
    expect(loadCrop).not.toHaveBeenCalled();
    const canvas = w.find("canvas").element as HTMLCanvasElement;
    expect(canvas.width).toBe(0);

    notify(true);
    await flushPromises();
    loader.requests.get(crop(1).url.href)!.resolve({ id: "image1" });
    await flushPromises();
    expect(w.vm.isLoaded).toBe(true);
    expect(canvas.width).toBe(100);

    notify(false);
    await flushPromises();
    expect(w.vm.isLoaded).toBe(false);
    expect(canvas.width).toBe(0);
    expect(loader.requests.get(crop(1).url.href)!.release).toHaveBeenCalled();

    notify(true);
    await flushPromises();
    expect(loadCrop).toHaveBeenCalledTimes(2);
  });

  it("releases a crop still loading when it moves on to another", async () => {
    const loader = fakeLoader();
    const loadCrop = vi.fn(async (key: string) =>
      key === "1:a" ? crop(1) : crop(2),
    );
    const w = mountPanel({ loader, loadCrop, cropKey: "1:a" });
    await flushPromises();
    const first = loader.requests.get(crop(1).url.href)!;
    // Superseded before it arrived: let the loader drop it.
    await w.setProps({ cropKey: "2:a" });
    await flushPromises();
    expect(first.release).toHaveBeenCalled();
    first.resolve({ id: "late" });
    loader.requests.get(crop(2).url.href)!.resolve({ id: "image2" });
    await flushPromises();
    expect(w.vm.loaded.image).toEqual({ id: "image2" });
  });
});
