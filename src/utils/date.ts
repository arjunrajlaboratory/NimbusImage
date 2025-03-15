import { format } from "date-fns";

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
  } catch (e) {
    return dateString;
  }
}

export function formatDateNumber(timestamp: number) {
  const date = new Date(timestamp).toLocaleString();
  try {
    return format(date, "MMM d, yyyy h:mm a");
  } catch (e) {
    return date;
  }
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
