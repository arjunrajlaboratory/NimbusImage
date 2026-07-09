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
  return toSortedFiles(await fromEvent(event));
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
      window.removeEventListener("focus", onCancel, true);
      resolve(event ? toSortedFiles(await fromEvent(event)) : []);
    };

    // The `change` event fires with the selection once the dialog closes.
    input.addEventListener("change", (event) => settle(event));
    // The `cancel` event fires when the dialog is dismissed (modern browsers).
    input.addEventListener("cancel", () => settle(null));
    // Fallback for browsers without `cancel`: when the dialog closes the window
    // regains focus. If no `change` fired shortly after, treat it as a cancel
    // so the promise always settles. `change` populates input.files before it
    // fires, so it always wins the race when a selection was made.
    const onCancel = () => window.setTimeout(() => settle(null), 500);
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
