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
