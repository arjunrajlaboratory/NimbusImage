import { describe, it, expect, vi, beforeEach } from "vitest";

// The folder-traversal itself is delegated to (and tested by) `file-selector`.
// These tests cover the logic this module adds on top: extracting File objects
// from whatever `fromEvent` returns and sorting them by natural name order.
vi.mock("file-selector", () => ({
  fromEvent: vi.fn(),
}));

import { fromEvent } from "file-selector";
import { getFilesFromDrop, filterFilesByAccept } from "./fileUpload";

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
