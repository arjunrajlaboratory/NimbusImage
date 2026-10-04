// Fetches and decodes montage crops with a concurrency limit and an LRU cache
// bounded by decoded size.
//
// Requests are reference-counted: a panel holds its crop until a replacement
// has loaded (or it unmounts), and a request nobody holds any more is dropped
// from the queue before it starts. Without that, paging quickly through the
// list would leave the queue full of crops for pages no longer shown.
//
// Only unheld images are evicted, and evicted images are close()d at once:
// a decoded ImageBitmap is large (640×640 RGBA ≈ 1.6MB) and otherwise keeps
// its memory until garbage collection. Holding is what makes closing safe — a
// held image may still be drawn.

type TFetch = (url: URL, signal: AbortSignal) => Promise<ArrayBuffer>;
type TDecode = (data: ArrayBuffer) => Promise<ImageBitmap>;

interface IEntry {
  promise: Promise<ImageBitmap>;
  image: ImageBitmap | null;
  holders: number;
  started: boolean;
  settled: boolean;
  controller: AbortController;
  start: () => void;
}

export interface IMontageImageRequest {
  promise: Promise<ImageBitmap>;
  release: () => void;
}

export class MontageAbortError extends Error {
  constructor() {
    super("Montage image request released before it finished");
    this.name = "MontageAbortError";
  }
}

const defaultDecode: TDecode = (data) => createImageBitmap(new Blob([data]));

const imageBytes = (image: ImageBitmap) => image.width * image.height * 4;

export class MontageImageLoader {
  private entries = new Map<string, IEntry>();
  private queue: string[] = [];
  private running = 0;

  constructor(
    private readonly fetchImage: TFetch,
    private readonly maxConcurrent = 6,
    private readonly maxCachedBytes = 256 * 1024 * 1024,
    private readonly decode: TDecode = defaultDecode,
  ) {}

  load(url: URL): IMontageImageRequest {
    const key = url.href;
    let entry = this.entries.get(key);
    if (entry) {
      // Refresh LRU position.
      this.entries.delete(key);
      this.entries.set(key, entry);
    } else {
      entry = this.createEntry(url);
      this.entries.set(key, entry);
      this.queue.push(key);
    }
    entry.holders++;
    this.pump();
    let released = false;
    const held = entry;
    return {
      promise: held.promise,
      release: () => {
        if (released) return;
        released = true;
        held.holders--;
        if (held.holders <= 0 && !held.settled) {
          this.drop(key, held);
        } else if (held.holders <= 0) {
          this.evict();
        }
      },
    };
  }

  private createEntry(url: URL): IEntry {
    const controller = new AbortController();
    let resolve!: (image: ImageBitmap) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ImageBitmap>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Nobody may be listening by the time a released request rejects.
    promise.catch(() => {});
    const entry: IEntry = {
      promise,
      image: null,
      holders: 0,
      started: false,
      settled: false,
      controller,
      start: () => {
        entry.started = true;
        this.running++;
        this.fetchImage(url, controller.signal)
          .then(this.decode)
          .then(
            (image) => {
              entry.settled = true;
              // Released after the fetch but before decoding finished: the
              // entry was dropped, so nothing could ever evict or close this.
              if (this.entries.get(url.href) !== entry) {
                image.close();
                reject(new MontageAbortError());
                return;
              }
              entry.image = image;
              resolve(image);
              this.evict();
            },
            (error) => {
              entry.settled = true;
              // Failures are not cached: a later request retries.
              if (this.entries.get(url.href) === entry) {
                this.entries.delete(url.href);
              }
              reject(error);
            },
          )
          .finally(() => {
            this.running--;
            this.pump();
          });
      },
    };
    // Settle with an abort if dropped before starting.
    controller.signal.addEventListener("abort", () => {
      if (!entry.started) {
        entry.settled = true;
        reject(new MontageAbortError());
      }
    });
    return entry;
  }

  private drop(key: string, entry: IEntry) {
    if (this.entries.get(key) === entry) {
      this.entries.delete(key);
    }
    this.queue = this.queue.filter((queued) => queued !== key);
    entry.controller.abort();
  }

  private pump() {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const key = this.queue.shift()!;
      const entry = this.entries.get(key);
      if (entry && !entry.started) {
        entry.start();
      }
    }
  }

  get cachedBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.image) total += imageBytes(entry.image);
    }
    return total;
  }

  private evict() {
    let excess = this.cachedBytes - this.maxCachedBytes;
    // Oldest first (Map preserves insertion order); never a held image.
    for (const [key, entry] of [...this.entries]) {
      if (excess <= 0) break;
      if (!entry.image || entry.holders > 0) continue;
      excess -= imageBytes(entry.image);
      this.entries.delete(key);
      entry.image.close();
    }
  }

  // Drop everything; for teardown, when nothing will draw these images again.
  clear() {
    for (const [key, entry] of [...this.entries]) {
      if (!entry.settled) {
        this.drop(key, entry);
      }
      entry.image?.close();
    }
    this.entries.clear();
    this.queue = [];
  }
}
