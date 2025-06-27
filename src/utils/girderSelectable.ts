import { IGirderFolder, IGirderItem, IGirderSelectAble } from "@/girder";

export function isConfigurationItem(selectable: IGirderSelectAble): boolean {
  return (
    selectable._modelType === "item" &&
    selectable.meta.subtype === "contrastConfiguration" &&
    selectable.meta.compatibility
  );
}

export function toConfigurationItem(
  selectable: IGirderSelectAble,
): IGirderItem | null {
  return isConfigurationItem(selectable) ? (selectable as IGirderItem) : null;
}

export function isDatasetFolder(selectable: IGirderSelectAble): boolean {
  return (
    selectable._modelType === "folder" &&
    selectable.meta.subtype === "contrastDataset"
  );
}

export function toDatasetFolder(
  selectable: IGirderSelectAble,
): IGirderFolder | null {
  return isDatasetFolder(selectable) ? (selectable as IGirderFolder) : null;
}

export const unselectableLocations = [
  "collections",
  "collection",
  "root",
  "users",
  "user",
];
