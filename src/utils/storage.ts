// Single source of truth for how storage-quota usage is escalated in the UI.
// Consumed by the store (isNearStorageLimit / storageSeverity) and by the
// profile popup and user-menu badge, so the thresholds and colors stay in sync.

export type TStorageSeverity = "ok" | "warning" | "error";

// Percent-of-quota thresholds at which the storage UI escalates its warning.
const WARNING_PERCENTAGE = 90;
const ERROR_PERCENTAGE = 95;

export function storageSeverityFromPercentage(
  percentage: number | null,
): TStorageSeverity {
  if (percentage == null) {
    return "ok";
  }
  if (percentage > ERROR_PERCENTAGE) {
    return "error";
  }
  if (percentage > WARNING_PERCENTAGE) {
    return "warning";
  }
  return "ok";
}

// Vuetify color name for a given severity (progress bar, text, and badge).
export function storageSeverityColor(severity: TStorageSeverity): string {
  switch (severity) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    default:
      return "primary";
  }
}
