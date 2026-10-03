// Helpers for detecting storage-quota errors raised by the girder-user-quota
// plugin. When an upload would push a user past their storage quota, the
// plugin rejects it with a ValidationException whose message looks like:
//   "Upload would exceed file storage quota (need 4.2 GB, only 1.1 GB
//    available - used 8.9 GB out of 10.0 GB)"
// (or "Upload exceeded file storage quota (...)" when caught at upload
// finalization). For uploads performed server-side — large_image transcoding
// jobs, worker jobs uploading their output — this message only ever appears
// in the job log, so these helpers are used to recognize it there and turn it
// into actionable user feedback.

export interface IQuotaExceededInfo {
  needed: string;
  available: string;
  used: string;
  total: string;
}

const QUOTA_EXCEEDED_REGEX =
  /file storage quota\s*\(need (.+?), only (.+?) available - used (.+?) out of (.+?)\)/i;

export function parseQuotaExceededError(
  text: string,
): IQuotaExceededInfo | null {
  const match = text.match(QUOTA_EXCEEDED_REGEX);
  if (!match) {
    return null;
  }
  const [, needed, available, used, total] = match;
  return { needed, available, used, total };
}

// Returns a user-facing message if the text indicates a storage quota breach,
// or null otherwise.
export function quotaExceededMessage(text: string): string | null {
  const info = parseQuotaExceededError(text);
  if (info) {
    return (
      `This operation needs ${info.needed} of storage, but only ` +
      `${info.available} of your ${info.total} quota remains ` +
      `(${info.used} used). Free up space by deleting datasets you no ` +
      `longer need, or upgrade your account for more storage.`
    );
  }
  // Fallback in case the plugin message format changes but still mentions the
  // quota.
  if (/file storage quota/i.test(text)) {
    return (
      "Your storage quota was exceeded. Free up space by deleting datasets " +
      "you no longer need, or upgrade your account for more storage."
    );
  }
  return null;
}
