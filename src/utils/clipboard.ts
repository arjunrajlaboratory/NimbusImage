import { logError } from "@/utils/log";

// Copy text to the clipboard, falling back to the legacy execCommand path
// when the async Clipboard API is unavailable (e.g. non-secure contexts).
// Resolves true when the copy succeeded.
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  const tempTextArea = document.createElement("textarea");
  tempTextArea.value = text;
  tempTextArea.style.position = "fixed";
  document.body.appendChild(tempTextArea);
  tempTextArea.select();
  try {
    document.execCommand("copy");
    return true;
  } catch (error) {
    logError("Failed to copy text: ", error);
    return false;
  } finally {
    document.body.removeChild(tempTextArea);
  }
}
