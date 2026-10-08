import { describe, expect, it } from "vitest";
import {
  buildSnapshotFilename,
  MAX_SNAPSHOT_FILENAME_BYTES,
  truncateMiddleToBytes,
  utf8Length,
} from "./snapshotFilename";

const baseParts = {
  snapshotName: "snap",
  label: "DAPI",
  datasetName: "dataset",
  configurationName: "collection",
  dateStr: "2026-10-08 06_06",
  coordinateSuffix: " - XY1_T3_Z1",
  extension: "tiff",
};

describe("snapshotFilename", () => {
  it("leaves short snapshot filenames unchanged", () => {
    expect(buildSnapshotFilename(baseParts)).toEqual({
      fileName:
        "snap - DAPI - dataset - collection - 2026-10-08 06_06 - XY1_T3_Z1.tiff",
      shortened: false,
    });
  });

  it("shortens collection and dataset names before the snapshot name and label", () => {
    const { fileName, shortened } = buildSnapshotFilename({
      ...baseParts,
      snapshotName: "My snapshot",
      label: "488 Brightfield-Disk",
      datasetName: "D".repeat(150),
      configurationName: "C".repeat(150),
    });
    expect(shortened).toBe(true);
    expect(utf8Length(fileName)).toBeLessThanOrEqual(
      MAX_SNAPSHOT_FILENAME_BYTES,
    );
    expect(fileName.startsWith("My snapshot - 488 Brightfield-Disk - D")).toBe(
      true,
    );
    expect(fileName.endsWith(" - 2026-10-08 06_06 - XY1_T3_Z1.tiff")).toBe(
      true,
    );
  });

  it("keeps every name within the byte limit even when all fields are long", () => {
    const { fileName } = buildSnapshotFilename({
      ...baseParts,
      snapshotName: "s".repeat(300),
      label: "é".repeat(300),
      datasetName: "d".repeat(300),
      configurationName: "c".repeat(300),
    });
    expect(utf8Length(fileName)).toBeLessThanOrEqual(
      MAX_SNAPSHOT_FILENAME_BYTES,
    );
    expect(fileName).toContain("é");
    expect(fileName.endsWith(" - XY1_T3_Z1.tiff")).toBe(true);
  });

  it("truncates in the middle on UTF-8 character boundaries", () => {
    const truncated = truncateMiddleToBytes(`ab${"é".repeat(20)}yz`, 11);
    expect(utf8Length(truncated)).toBeLessThanOrEqual(11);
    expect(truncated.startsWith("ab")).toBe(true);
    expect(truncated.endsWith("yz")).toBe(true);
    expect(truncated).toContain("...");
    expect(truncated).not.toContain("�");
  });
});
