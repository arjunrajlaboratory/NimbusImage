// Helpers for turning a folder selection or a folder drag-and-drop into a flat
// list of File objects.
//
// Two browser APIs are involved:
//  - The HTML directory picker (`<input type="file" webkitdirectory>`) returns
//    every file in the chosen folder tree directly on `input.files`, so those
//    just need to be collected.
//  - Dragging a folder onto a dropzone only exposes the folder through the
//    (non-standard but widely supported) File and Directory Entries API on
//    `DataTransferItem.webkitGetAsEntry()`. `DataTransfer.files` alone does not
//    recurse into dropped directories, so we walk the entry tree ourselves.

function readEntriesBatch(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

// readEntries only returns a bounded number of entries per call (100 in
// Chromium), so it must be called repeatedly until it returns an empty batch.
async function readAllDirectoryEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = [];
  let batch = await readEntriesBatch(reader);
  while (batch.length > 0) {
    entries.push(...batch);
    batch = await readEntriesBatch(reader);
  }
  return entries;
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

// Sort files by name using natural (numeric-aware) ordering so image sequences
// like frame1, frame2, frame10 come back in the expected order. Files gathered
// from a folder drop or a folder picker have no inherent order, so we sort them
// for deterministic dataset naming and dimension assignment.
function sortByName(files: File[]): File[] {
  return files.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

async function filesFromEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return [await fileFromEntry(entry as FileSystemFileEntry)];
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const childEntries = await readAllDirectoryEntries(reader);
    const nested = await Promise.all(childEntries.map(filesFromEntry));
    return nested.flat();
  }
  return [];
}

/**
 * Extract all files from a drop's DataTransfer, recursing into any dropped
 * folders. Falls back to the plain `files` list when the entries API is
 * unavailable (e.g. older browsers), in which case dropped folders are ignored
 * by the browser as before.
 */
export async function getFilesFromDataTransfer(
  dataTransfer: DataTransfer | null,
): Promise<File[]> {
  if (!dataTransfer) {
    return [];
  }

  const items = dataTransfer.items;
  const supportsEntries =
    items &&
    items.length > 0 &&
    typeof items[0].webkitGetAsEntry === "function";

  if (!supportsEntries) {
    return sortByName([...dataTransfer.files]);
  }

  // webkitGetAsEntry() must be called synchronously while the drop event is
  // being handled, before any await, because the DataTransferItemList is
  // cleared once the handler returns.
  const entries: FileSystemEntry[] = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry();
    if (entry) {
      entries.push(entry);
    }
  }

  if (entries.length === 0) {
    return sortByName([...dataTransfer.files]);
  }

  const files = await Promise.all(entries.map(filesFromEntry));
  return sortByName(files.flat());
}

/**
 * Open a native file/folder picker and resolve with the selected files,
 * sorted by name. Resolves with an empty array if the dialog is dismissed.
 *
 * Creates a fresh detached <input> on every call: calling .click() on a
 * newly-created, unattached input avoids Chrome's issue where a programmatic
 * .click() on an existing DOM-attached input can be silently blocked.
 */
function openFilePicker(
  options: { directory?: boolean } = {},
): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (options.directory) {
      // `webkitdirectory` turns the picker into a folder chooser. It is not in
      // the standard HTMLInputElement typings, so set it via attribute.
      input.setAttribute("webkitdirectory", "");
    }

    let settled = false;
    const settle = (files: File[]) => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener("focus", onCancel, true);
      resolve(sortByName(files));
    };

    // The `change` event fires with the selection once the dialog closes.
    input.addEventListener("change", () => settle([...(input.files ?? [])]));
    // The `cancel` event fires when the dialog is dismissed (modern browsers).
    input.addEventListener("cancel", () => settle([]));
    // Fallback for browsers without `cancel`: when the dialog closes the window
    // regains focus. If no `change` fired shortly after, treat it as a cancel
    // so the promise always settles. `change` populates input.files before it
    // fires, so it always wins the race when a selection was made.
    const onCancel = () => window.setTimeout(() => settle([]), 500);
    window.addEventListener("focus", onCancel, true);

    input.click();
  });
}

/**
 * Open a native file picker (multiple files) and resolve with the selected
 * files, sorted by name.
 */
export function selectFiles(): Promise<File[]> {
  return openFilePicker();
}

/**
 * Open a native folder picker and resolve with every file contained in the
 * chosen folder (recursively), sorted by name. Resolves with an empty array if
 * the user cancels the dialog.
 */
export function selectFilesFromFolder(): Promise<File[]> {
  return openFilePicker({ directory: true });
}
