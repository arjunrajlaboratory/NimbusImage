import { format, isValid } from "date-fns";

// A timestamp from stored data may be missing (e.g. a dataset view created
// through the REST API carries no lastViewed). date-fns `format` throws
// "RangeError: Invalid time value" on such dates, which during a render
// takes the whole component down, so these helpers return "" instead.
function toValidDate(timestamp: number | undefined | null): Date | null {
  if (timestamp == null) return null;
  const date = new Date(timestamp);
  return isValid(date) ? date : null;
}

export function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = ("0" + (d.getMonth() + 1)).slice(-2);
  const day = ("0" + d.getDate()).slice(-2);
  const hour = ("0" + d.getHours()).slice(-2);
  const minute = ("0" + d.getMinutes()).slice(-2);

  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function formatDateString(dateString: string) {
  if (!dateString) return "";
  try {
    const date = new Date(dateString);
    return format(date, "MMM d, yyyy h:mm a");
    // This would output something like: "Dec 31, 2024 1:07 PM"
  } catch {
    return dateString;
  }
}

export function formatDateNumber(timestamp?: number | null): string {
  const date = toValidDate(timestamp);
  return date ? format(date, "MMM d, yyyy h:mm a") : "";
}

// Short calendar day, dropping the year when it matches the current year.
// e.g. "Apr 24" (current year) or "Apr 24, 2024" (other years).
export function formatDayShort(timestamp?: number | null): string {
  const date = toValidDate(timestamp);
  if (!date) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return format(date, sameYear ? "MMM d" : "MMM d, yyyy");
}

// Time of day in 12-hour format with AM/PM, e.g. "10:50 AM".
export function formatTimeOfDay(timestamp?: number | null): string {
  const date = toValidDate(timestamp);
  return date ? format(date, "h:mm a") : "";
}

export function formatDuration(milliseconds: number): string {
  if (!milliseconds || milliseconds <= 0) {
    return "00:00:00";
  }

  // Calculate hours, minutes, and seconds
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  // Format with leading zeros
  const formattedHours = hours.toString().padStart(2, "0");
  const formattedMinutes = minutes.toString().padStart(2, "0");
  const formattedSeconds = seconds.toString().padStart(2, "0");

  return `${formattedHours}:${formattedMinutes}:${formattedSeconds}`;
}
