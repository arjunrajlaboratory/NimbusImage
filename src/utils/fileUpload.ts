// Helpers for turning a folder selection or a folder drag-and-drop into a flat
// list of File objects.
//
// The actual extraction is delegated to `file-selector` (the library
// react-dropzone uses): its `fromEvent` handles both a drop's DataTransfer
// (recursing into dropped folders via the File and Directory Entries API) and
// an <input> change event, normalizing both into File objects that also carry
// their in-folder `path`/`relativePath`. We add natural-order sorting on top so
// image sequences upload deterministically.
import { fromEvent, FileWithPath } from "file-selector";
import { logError } from "@/utils/log";

// Sort files by name using natural (numeric-aware) ordering so image sequences
// like frame1, frame2, frame10 come back in the expected order. Files gathered
// from a folder drop or a folder picker have no inherent order, so we sort them
// for deterministic dataset naming and dimension assignment.
function sortByName<T extends File>(files: T[]): T[] {
  return files.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

// `fromEvent` can return DataTransferItem entries for non-drop drag events;
// for our drop/change cases it returns File objects. Keep only real files.
function toSortedFiles(items: (FileWithPath | DataTransferItem)[]): File[] {
  return sortByName(
    items.filter((item): item is FileWithPath => item instanceof File),
  );
}

/**
 * Extract all files from a drop event, recursing into any dropped folders and
 * returning them sorted by name.
 */
export async function getFilesFromDrop(event: DragEvent): Promise<File[]> {
  try {
    return toSortedFiles(await fromEvent(event));
  } catch (error) {
    // file-selector can reject on exotic drops (e.g. a directory entry it
    // cannot read). Degrade to "nothing dropped" rather than leaving the
    // async drop handler with an unhandled rejection.
    logError("Failed to read dropped files", error);
    return [];
  }
}

function matchesAcceptToken(file: File, token: string): boolean {
  if (token.startsWith(".")) {
    // Extension token, e.g. ".tif"
    return file.name.toLowerCase().endsWith(token.toLowerCase());
  }
  const type = file.type.toLowerCase();
  if (token.endsWith("/*")) {
    // Wildcard MIME token, e.g. "image/*"
    return type.startsWith(token.slice(0, token.indexOf("/") + 1));
  }
  // Exact MIME token, e.g. "image/png"
  return type === token;
}

/**
 * Filter files against an HTML `accept` attribute string (comma-separated
 * extensions and/or MIME types, e.g. ".tif,.png,image/*"). An empty/undefined
 * accept means "accept everything". This mirrors the constraint the native
 * file input applies, which browsers do NOT enforce for folder selection or
 * drag-and-drop, so callers must apply it themselves for those paths.
 */
export function filterFilesByAccept(files: File[], accept?: string): File[] {
  const tokens = (accept ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return files;
  }
  return files.filter((file) =>
    tokens.some((token) => matchesAcceptToken(file, token)),
  );
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
    const settle = async (event: Event | null) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        resolve(event ? toSortedFiles(await fromEvent(event)) : []);
      } catch (error) {
        // Never leave the picker promise unresolved: an error extracting the
        // selection must still settle (as "no selection"), or every caller
        // awaiting selectFiles()/selectFilesFromFolder() would hang forever.
        logError("Failed to read selected files", error);
        resolve([]);
      }
    };

    // The `change` event fires with the selection once the dialog closes.
    input.addEventListener("change", (event) => settle(event));
    // The `cancel` event fires when the dialog is dismissed. It is supported in
    // every browser we target (Chrome 113+, Firefox 91+, Safari 16.4+).
    //
    // We deliberately do NOT add a window-`focus` fallback to force settlement.
    // For a folder pick, the window regains focus the moment the OS dialog
    // closes, but `input.files` is not populated until the user accepts
    // Chrome's "Upload N files?" confirmation, which fires `change` seconds
    // later. A focus-triggered timeout would settle with an empty selection in
    // that gap and silently discard the chosen folder.
    input.addEventListener("cancel", () => settle(null));

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
