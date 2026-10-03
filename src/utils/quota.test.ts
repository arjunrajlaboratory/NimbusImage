import { describe, it, expect } from "vitest";
import { parseQuotaExceededError, quotaExceededMessage } from "./quota";

const START_MESSAGE =
  "Upload would exceed file storage quota (need 4.20 GB, only 1.10 GB " +
  "available - used 8.90 GB out of 10.00 GB)";
const FINALIZE_MESSAGE =
  "Upload exceeded file storage quota (need 954.06 MB, only 100.00 MB " +
  "available - used 9.90 GB out of 10.00 GB)";

describe("parseQuotaExceededError", () => {
  it("parses the upload-start quota message", () => {
    expect(parseQuotaExceededError(START_MESSAGE)).toEqual({
      needed: "4.20 GB",
      available: "1.10 GB",
      used: "8.90 GB",
      total: "10.00 GB",
    });
  });

  it("parses the upload-finalize quota message", () => {
    expect(parseQuotaExceededError(FINALIZE_MESSAGE)).toEqual({
      needed: "954.06 MB",
      available: "100.00 MB",
      used: "9.90 GB",
      total: "10.00 GB",
    });
  });

  it("finds the message inside a job log traceback", () => {
    const log = [
      "Started large image conversion",
      "Processing frame 12/12",
      "Created a file of size 123456789",
      "Traceback (most recent call last):",
      '  File "/opt/girder/upload.py", line 42, in finalize',
      `girder.exceptions.ValidationException: ${FINALIZE_MESSAGE}`,
    ].join("\n");
    expect(parseQuotaExceededError(log)?.needed).toBe("954.06 MB");
  });

  it("returns null for unrelated errors", () => {
    expect(parseQuotaExceededError("Some other failure")).toBeNull();
    expect(parseQuotaExceededError("")).toBeNull();
  });
});

describe("quotaExceededMessage", () => {
  it("builds a user-facing message with the parsed sizes", () => {
    const message = quotaExceededMessage(START_MESSAGE);
    expect(message).toContain("4.20 GB");
    expect(message).toContain("1.10 GB");
    expect(message).toContain("10.00 GB");
    expect(message).toContain("Free up space");
  });

  it("falls back to a generic message when the sizes cannot be parsed", () => {
    const message = quotaExceededMessage(
      "Error: file storage quota reached for user",
    );
    expect(message).toContain("storage quota was exceeded");
  });

  it("returns null for non-quota errors", () => {
    expect(quotaExceededMessage("Connection reset by peer")).toBeNull();
  });
});
