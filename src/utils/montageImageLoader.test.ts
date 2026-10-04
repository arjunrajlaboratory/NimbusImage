import { describe, it, expect, vi } from "vitest";
import { MontageAbortError, MontageImageLoader } from "./montageImageLoader";

// A fetch whose requests resolve only when the test says so.
function controllableFetch() {
  const pending = new Map<
    string,
    { resolve: (data: ArrayBuffer) => void; reject: (e: unknown) => void }
  >();
  const fetchImage = vi.fn(
    (url: URL, signal: AbortSignal) =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        pending.set(url.href, { resolve, reject });
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  return { fetchImage, pending };
}

// A decoded "image" of byteLength × 1 pixels (4 bytes each), so cache sizes
// are easy to reason about.
const decode = vi.fn(
  async (data: ArrayBuffer) =>
    ({
      width: data.byteLength,
      height: 1,
      close: vi.fn(),
    }) as unknown as ImageBitmap,
);

const url = (n: number) => new URL(`http://host/region?n=${n}`);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MontageImageLoader", () => {
  it("never runs more than the concurrency limit at once", async () => {
    const { fetchImage, pending } = controllableFetch();
    const loader = new MontageImageLoader(fetchImage, 2, 100, decode);
    [1, 2, 3, 4].forEach((n) => loader.load(url(n)));
    expect(fetchImage).toHaveBeenCalledTimes(2);

    pending.get(url(1).href)!.resolve(new ArrayBuffer(1));
    await flush();
    expect(fetchImage).toHaveBeenCalledTimes(3);
  });

  it("fetches a URL once and shares the result", async () => {
    const { fetchImage, pending } = controllableFetch();
    const loader = new MontageImageLoader(fetchImage, 6, 100, decode);
    const first = loader.load(url(1));
    const second = loader.load(url(1));
    pending.get(url(1).href)!.resolve(new ArrayBuffer(3));
    expect(await first.promise).toBe(await second.promise);

    const later = loader.load(url(1));
    await later.promise;
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it("drops a queued request nobody holds before it starts", async () => {
    const { fetchImage, pending } = controllableFetch();
    const loader = new MontageImageLoader(fetchImage, 1, 100, decode);
    loader.load(url(1));
    const queued = loader.load(url(2));
    queued.release();
    await expect(queued.promise).rejects.toBeInstanceOf(MontageAbortError);

    pending.get(url(1).href)!.resolve(new ArrayBuffer(1));
    await flush();
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it("keeps a request alive while another holder still wants it", async () => {
    const { fetchImage, pending } = controllableFetch();
    const loader = new MontageImageLoader(fetchImage, 1, 100, decode);
    loader.load(url(1));
    const a = loader.load(url(2));
    const b = loader.load(url(2));
    a.release();
    pending.get(url(1).href)!.resolve(new ArrayBuffer(1));
    await flush();
    pending.get(url(2).href)!.resolve(new ArrayBuffer(2));
    expect((await b.promise).width).toBe(2);
  });

  it("aborts an in-flight request once released", async () => {
    const { fetchImage } = controllableFetch();
    const loader = new MontageImageLoader(fetchImage, 1, 100, decode);
    const request = loader.load(url(1));
    const signal = fetchImage.mock.calls[0][1];
    request.release();
    expect(signal.aborted).toBe(true);
    await expect(request.promise).rejects.toThrow();
  });

  it("does not cache failures, so a later load retries", async () => {
    const { fetchImage, pending } = controllableFetch();
    const loader = new MontageImageLoader(fetchImage, 1, 100, decode);
    const failed = loader.load(url(1));
    pending.get(url(1).href)!.reject(new Error("500"));
    await expect(failed.promise).rejects.toThrow("500");
    await flush();

    loader.load(url(1));
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it("evicts and closes the oldest unheld images past the byte budget", async () => {
    const { fetchImage, pending } = controllableFetch();
    // Budget: 12 bytes = three 1-pixel images.
    const loader = new MontageImageLoader(fetchImage, 6, 12, decode);
    const images: ImageBitmap[] = [];
    for (const n of [1, 2, 3, 4]) {
      const request = loader.load(url(n));
      pending.get(url(n).href)!.resolve(new ArrayBuffer(1));
      images.push(await request.promise);
      if (n !== 3) request.release();
    }
    await flush();
    // Image 1 (oldest, unheld) went; image 3 is held and survives.
    expect(images[0].close).toHaveBeenCalled();
    expect(images[2].close).not.toHaveBeenCalled();
    expect(loader.cachedBytes).toBeLessThanOrEqual(12);

    loader.load(url(1));
    expect(fetchImage).toHaveBeenCalledTimes(5);
    loader.load(url(3));
    expect(fetchImage).toHaveBeenCalledTimes(5);
  });

  it("never closes an image someone still holds", async () => {
    const { fetchImage, pending } = controllableFetch();
    const loader = new MontageImageLoader(fetchImage, 6, 0, decode);
    const request = loader.load(url(1));
    pending.get(url(1).href)!.resolve(new ArrayBuffer(4));
    const image = await request.promise;
    await flush();
    expect(image.close).not.toHaveBeenCalled();
    request.release();
    expect(image.close).toHaveBeenCalled();
  });
});
