import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The folder-traversal itself is delegated to (and tested by) `file-selector`.
// These tests cover the logic this module adds on top: extracting File objects
// from whatever `fromEvent` returns and sorting them by natural name order.
vi.mock("file-selector", () => ({
  fromEvent: vi.fn(),
}));

import { fromEvent } from "file-selector";
import {
  getFilesFromDrop,
  filterFilesByAccept,
  selectFilesFromFolder,
} from "./fileUpload";

const mockFromEvent = vi.mocked(fromEvent);

function makeFile(name: string, type = ""): File {
  return new File(["content"], name, { type });
}

const dropEvent = { type: "drop" } as unknown as DragEvent;

describe("getFilesFromDrop", () => {
  beforeEach(() => {
    mockFromEvent.mockReset();
  });

  it("returns the files extracted from the drop event", async () => {
    mockFromEvent.mockResolvedValue([makeFile("a.tif"), makeFile("b.tif")]);
    const files = await getFilesFromDrop(dropEvent);
    expect(mockFromEvent).toHaveBeenCalledWith(dropEvent);
    expect(files.map((f) => f.name)).toEqual(["a.tif", "b.tif"]);
  });

  it("sorts files in natural (numeric-aware) name order", async () => {
    mockFromEvent.mockResolvedValue([
      makeFile("frame10.tif"),
      makeFile("frame2.tif"),
      makeFile("frame1.tif"),
    ]);
    const files = await getFilesFromDrop(dropEvent);
    // Natural sort keeps frame2 before frame10 (a plain lexical sort would not).
    expect(files.map((f) => f.name)).toEqual([
      "frame1.tif",
      "frame2.tif",
      "frame10.tif",
    ]);
  });

  it("drops non-File entries (e.g. DataTransferItem) defensively", async () => {
    mockFromEvent.mockResolvedValue([
      makeFile("real.tif"),
      { kind: "file" } as unknown as DataTransferItem,
    ]);
    const files = await getFilesFromDrop(dropEvent);
    expect(files.map((f) => f.name)).toEqual(["real.tif"]);
  });

  it("returns an empty array when nothing is extracted", async () => {
    mockFromEvent.mockResolvedValue([]);
    expect(await getFilesFromDrop(dropEvent)).toEqual([]);
  });

  it("returns an empty array (does not reject) when extraction throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFromEvent.mockRejectedValue(new Error("unreadable directory entry"));
    expect(await getFilesFromDrop(dropEvent)).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe("selectFilesFromFolder", () => {
  // Capture the detached <input> the picker creates so the test can drive its
  // native events (in jsdom, input.click() opens no dialog and fires nothing).
  function captureCreatedInput(): { getInput: () => HTMLInputElement } {
    const holder: { input: HTMLInputElement | null } = { input: null };
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreateElement(tag);
      if (tag === "input") {
        holder.input = el as HTMLInputElement;
      }
      return el;
    });
    return {
      getInput: () => {
        if (!holder.input) {
          throw new Error("picker never created an <input>");
        }
        return holder.input;
      },
    };
  }

  beforeEach(() => {
    mockFromEvent.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("resolves with the selection when the folder dialog fires `change`", async () => {
    mockFromEvent.mockResolvedValue([makeFile("a.tif"), makeFile("b.tif")]);
    const { getInput } = captureCreatedInput();

    const promise = selectFilesFromFolder();
    getInput().dispatchEvent(new Event("change"));

    expect((await promise).map((f) => f.name)).toEqual(["a.tif", "b.tif"]);
  });

  it("resolves empty (does not hang) when extraction throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFromEvent.mockRejectedValue(new Error("unreadable selection"));
    const { getInput } = captureCreatedInput();

    const promise = selectFilesFromFolder();
    getInput().dispatchEvent(new Event("change"));

    expect(await promise).toEqual([]);
  });

  it("resolves with an empty array when the dialog is cancelled", async () => {
    const { getInput } = captureCreatedInput();

    const promise = selectFilesFromFolder();
    getInput().dispatchEvent(new Event("cancel"));

    expect(await promise).toEqual([]);
  });

  // Regression guard for the folder-picker race: a directory pick makes the
  // window regain focus when the OS dialog closes, but `change` (carrying the
  // files) does not fire until the user confirms Chrome's "Upload N files?"
  // prompt — often seconds later. A window-focus timeout must not resolve the
  // promise early with an empty selection and discard the real `change`.
  it("does not drop the selection when `change` fires long after focus returns", async () => {
    vi.useFakeTimers();
    mockFromEvent.mockResolvedValue([makeFile("a.tif"), makeFile("b.tif")]);
    const { getInput } = captureCreatedInput();

    const promise = selectFilesFromFolder();

    // OS dialog closed -> window refocuses, but no files are known yet.
    window.dispatchEvent(new Event("focus"));
    // User spends well over half a second confirming the upload prompt.
    await vi.advanceTimersByTimeAsync(1500);
    // Confirmation accepted: the real selection finally arrives.
    getInput().dispatchEvent(new Event("change"));

    expect((await promise).map((f) => f.name)).toEqual(["a.tif", "b.tif"]);
  });
});

describe("filterFilesByAccept", () => {
  const files = [
    makeFile("image.tif", "image/tiff"),
    makeFile("photo.PNG", "image/png"),
    makeFile("notes.csv", "text/csv"),
    makeFile("readme.txt", "text/plain"),
  ];

  it("returns all files when accept is empty or undefined", () => {
    expect(filterFilesByAccept(files)).toEqual(files);
    expect(filterFilesByAccept(files, "")).toEqual(files);
    expect(filterFilesByAccept(files, "  ")).toEqual(files);
  });

  it("filters by extension tokens (case-insensitively)", () => {
    const result = filterFilesByAccept(files, ".tif,.png");
    expect(result.map((f) => f.name)).toEqual(["image.tif", "photo.PNG"]);
  });

  it("filters by wildcard MIME tokens", () => {
    const result = filterFilesByAccept(files, "image/*");
    expect(result.map((f) => f.name)).toEqual(["image.tif", "photo.PNG"]);
  });

  it("filters by exact MIME tokens", () => {
    const result = filterFilesByAccept(files, "text/csv");
    expect(result.map((f) => f.name)).toEqual(["notes.csv"]);
  });

  it("keeps a file that matches any of several tokens", () => {
    const result = filterFilesByAccept(files, ".tif, text/plain");
    expect(result.map((f) => f.name)).toEqual(["image.tif", "readme.txt"]);
  });
});
