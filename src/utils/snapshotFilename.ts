// Filesystems cap a single name at 255 bytes; macOS Archive Utility then
// extracts nothing from a ZIP and reports the whole archive as empty. Stay
// well under it so a " (n)" duplicate suffix and Windows' 260-character path
// limit (extraction folder + name) still fit.
export const MAX_SNAPSHOT_FILENAME_BYTES = 200;

// A field is never shortened below this, so each part stays recognizable.
const MIN_FIELD_BYTES = 24;

// ASCII on purpose: some unzippers (e.g. macOS's bundled unzip) ignore the
// ZIP UTF-8 flag and would show a Unicode ellipsis as mojibake.
const ELLIPSIS = "...";

const utf8Encoder = new TextEncoder();

export function utf8Length(text: string) {
  return utf8Encoder.encode(text).length;
}

function codePointBytes(char: string) {
  const codePoint = char.codePointAt(0)!;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

// Shortens text to at most maxBytes of UTF-8, replacing its middle with "...".
export function truncateMiddleToBytes(text: string, maxBytes: number) {
  if (utf8Length(text) <= maxBytes) {
    return text;
  }
  const chars = Array.from(text);
  let headBudget = Math.floor((maxBytes - ELLIPSIS.length) / 2);
  let tailBudget = maxBytes - ELLIPSIS.length - headBudget;
  let head = "";
  for (const char of chars) {
    const bytes = codePointBytes(char);
    if (bytes > headBudget) break;
    head += char;
    headBudget -= bytes;
  }
  let tail = "";
  for (let index = chars.length - 1; index >= 0; index--) {
    const bytes = codePointBytes(chars[index]);
    if (bytes > tailBudget) break;
    tail = chars[index] + tail;
    tailBudget -= bytes;
  }
  return `${head.trimEnd()}${ELLIPSIS}${tail.trimStart()}`;
}

export interface ISnapshotFilenameParts {
  snapshotName: string;
  // The channel name, or the joined layer names: what tells files apart.
  label: string;
  datasetName: string;
  configurationName: string;
  dateStr: string;
  coordinateSuffix: string;
  extension: string;
}

// Builds "<snapshot> - <label> - <dataset> - <configuration> - <date><coords>.<ext>"
// within MAX_SNAPSHOT_FILENAME_BYTES. Over the limit, the least identifying
// fields shrink first (configuration, dataset, then snapshot name, then the
// label); the date, coordinates and extension are never shortened, so files
// from one export stay distinguishable.
export function buildSnapshotFilename(parts: ISnapshotFilenameParts): {
  fileName: string;
  shortened: boolean;
} {
  const fields = {
    snapshotName: parts.snapshotName,
    label: parts.label,
    datasetName: parts.datasetName,
    configurationName: parts.configurationName,
  };
  const compose = () =>
    `${fields.snapshotName} - ${fields.label} - ${fields.datasetName} - ${fields.configurationName} - ${parts.dateStr}${parts.coordinateSuffix}.${parts.extension}`;

  let excess = utf8Length(compose()) - MAX_SNAPSHOT_FILENAME_BYTES;
  if (excess <= 0) {
    return { fileName: compose(), shortened: false };
  }
  const shrinkOrder = [
    "configurationName",
    "datasetName",
    "snapshotName",
    "label",
  ] as const;
  for (const minBytes of [MIN_FIELD_BYTES, 0]) {
    for (const key of shrinkOrder) {
      if (excess <= 0) break;
      const fieldBytes = utf8Length(fields[key]);
      const target = Math.max(minBytes, fieldBytes - excess);
      if (target >= fieldBytes) continue;
      fields[key] =
        target > ELLIPSIS.length
          ? truncateMiddleToBytes(fields[key], target)
          : "";
      excess = utf8Length(compose()) - MAX_SNAPSHOT_FILENAME_BYTES;
    }
  }
  return { fileName: compose(), shortened: true };
}
