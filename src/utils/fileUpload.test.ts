import { describe, it, expect } from "vitest";
import { getFilesFromDataTransfer } from "./fileUpload";

function makeFile(name: string): File {
  return new File(["content"], name);
}

// Minimal fakes for the File and Directory Entries API used by folder drops.
function fileEntry(name: string): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (resolve: (file: File) => void) => resolve(makeFile(name)),
  } as unknown as FileSystemFileEntry;
}

function directoryEntry(
  name: string,
  children: FileSystemEntry[],
): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let returned = false;
      return {
        // Return all children on the first call, then an empty batch to signal
        // the end, mirroring the real readEntries contract.
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
          resolve(returned ? [] : children);
          returned = true;
        },
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

function dataTransfer(
  entries: (FileSystemEntry | null)[],
  files: File[],
): DataTransfer {
  const items = entries.map((entry) => ({
    webkitGetAsEntry: () => entry,
  }));
  return { items, files } as unknown as DataTransfer;
}

describe("getFilesFromDataTransfer", () => {
  it("returns an empty array for a null DataTransfer", async () => {
    expect(await getFilesFromDataTransfer(null)).toEqual([]);
  });

  it("falls back to plain files when the entries API is unavailable", async () => {
    const file = makeFile("plain.tif");
    const dt = { files: [file] } as unknown as DataTransfer;
    expect(await getFilesFromDataTransfer(dt)).toEqual([file]);
  });

  it("returns dropped top-level files", async () => {
    const dt = dataTransfer([fileEntry("a.tif")], [makeFile("a.tif")]);
    const files = await getFilesFromDataTransfer(dt);
    expect(files.map((f) => f.name)).toEqual(["a.tif"]);
  });

  it("recurses into dropped folders, including nested subfolders", async () => {
    const tree = directoryEntry("root", [
      fileEntry("a.tif"),
      fileEntry("b.tif"),
      directoryEntry("nested", [fileEntry("c.tif")]),
    ]);
    const dt = dataTransfer([tree], []);
    const files = await getFilesFromDataTransfer(dt);
    expect(files.map((f) => f.name).sort()).toEqual([
      "a.tif",
      "b.tif",
      "c.tif",
    ]);
  });

  it("handles a mix of dropped files and folders", async () => {
    const dt = dataTransfer(
      [fileEntry("top.tif"), directoryEntry("folder", [fileEntry("in.tif")])],
      [],
    );
    const files = await getFilesFromDataTransfer(dt);
    expect(files.map((f) => f.name).sort()).toEqual(["in.tif", "top.tif"]);
  });
});
