export function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2") // convert camelCase to kebab
    .replace(/[\s_]+/g, "-") // convert spaces and underscores to hyphens
    .toLowerCase();
}

export function stripHtml(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}

/**
 * Format file size in a human-readable way
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Interface for transcoding progress information
 */
export interface TranscodeProgress {
  progressStatusText: string;
  transcodeProgress: number | undefined;
  currentFrame?: number;
  totalFrames?: number;
}

// data-tour value for a runtime-named entity (tool/tag/param/title).
// Data-dependent — NOT in the static registry, exempt from the static guard.
export function getTourAnchorId(name: string): string {
  return toKebabCase(name);
}

/**
 * Parse transcoding output to extract progress information
 */
export function parseTranscodeOutput(
  text: string,
  existingFileSize?: (bytes: number) => string,
): TranscodeProgress {
  // Look for "Processing frame x/y" pattern
  const frameRegex = /Processing frame (\d+)\/(\d+)/;
  const fileCreatedRegex = /Created a file of size (\d+)/;
  const startingRegex = /Started large image conversion/;
  const fileSizeFormatter = existingFileSize || formatFileSize;

  // Check for "Started large image conversion"
  if (startingRegex.test(text)) {
    return {
      progressStatusText: "Starting transcoding",
      transcodeProgress: 5, // Small initial progress
    };
  }

  // Check for frame processing
  const frameMatch = text.match(frameRegex);
  if (frameMatch) {
    const currentFrame = parseInt(frameMatch[1], 10);
    const totalFrames = parseInt(frameMatch[2], 10);

    return {
      currentFrame,
      totalFrames,
      transcodeProgress: (currentFrame / totalFrames) * 90, // Use 90% of progress bar for processing
      progressStatusText: `Processing frame ${currentFrame}/${totalFrames}`,
    };
  }

  // Check for file creation
  const fileCreatedMatch = text.match(fileCreatedRegex);
  if (fileCreatedMatch) {
    const fileSize = parseInt(fileCreatedMatch[1], 10);
    const formattedSize = fileSizeFormatter(fileSize);
    return {
      transcodeProgress: 99, // Almost complete
      progressStatusText: `Uploading file of size ${formattedSize}`,
    };
  }

  // Check for "Storing result"
  if (text.includes("Storing result")) {
    return {
      transcodeProgress: 100, // Complete
      progressStatusText: "Completing transcoding",
    };
  }

  // Default return if no patterns matched
  return {
    transcodeProgress: undefined,
    progressStatusText: "",
  };
}
