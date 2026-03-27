import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/download", () => ({
  downloadToClient: vi.fn(),
}));

import ExportAPI from "./ExportAPI";

function createMockClient() {
  return {
    apiRoot: "http://localhost:8080/api/v1",
    token: "test-token",
  } as any;
}

describe("ExportAPI", () => {
  let api: ExportAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    api = new ExportAPI(createMockClient());
  });

  describe("exportBulkCsv", () => {
    beforeEach(() => {
      // Mock fetch for exportCsv calls
      const mockBlob = new Blob(["csv-content"], { type: "text/csv" });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(mockBlob),
      });
      global.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
      global.URL.revokeObjectURL = vi.fn();
    });

    it("calls exportCsv for each dataset", async () => {
      const exportCsvSpy = vi.spyOn(api, "exportCsv");

      const promise = api.exportBulkCsv({
        datasets: [
          { datasetId: "ds1", datasetName: "Dataset1" },
          { datasetId: "ds2", datasetName: "Dataset2" },
        ],
        propertyPaths: [["propA", "sub1"]],
        undefinedValue: "NA",
        delimiter: ",",
      });

      // Advance past delays
      await vi.runAllTimersAsync();
      await promise;

      expect(exportCsvSpy).toHaveBeenCalledTimes(2);
      expect(exportCsvSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          datasetId: "ds1",
          filename: "Dataset1.csv",
          propertyPaths: [["propA", "sub1"]],
          undefinedValue: "NA",
          delimiter: ",",
        }),
      );
      expect(exportCsvSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          datasetId: "ds2",
          filename: "Dataset2.csv",
        }),
      );
    });

    it("uses .tsv extension when delimiter is tab", async () => {
      const exportCsvSpy = vi.spyOn(api, "exportCsv");

      const promise = api.exportBulkCsv({
        datasets: [{ datasetId: "ds1", datasetName: "Dataset1" }],
        delimiter: "\t",
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(exportCsvSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: "Dataset1.tsv",
          delimiter: "\t",
        }),
      );
    });

    it("uses .csv extension when delimiter is comma", async () => {
      const exportCsvSpy = vi.spyOn(api, "exportCsv");

      const promise = api.exportBulkCsv({
        datasets: [{ datasetId: "ds1", datasetName: "Dataset1" }],
        delimiter: ",",
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(exportCsvSpy).toHaveBeenCalledWith(
        expect.objectContaining({ filename: "Dataset1.csv" }),
      );
    });

    it("calls onProgress after each dataset", async () => {
      const onProgress = vi.fn();

      const promise = api.exportBulkCsv({
        datasets: [
          { datasetId: "ds1", datasetName: "DS1" },
          { datasetId: "ds2", datasetName: "DS2" },
          { datasetId: "ds3", datasetName: "DS3" },
        ],
        onProgress,
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(onProgress).toHaveBeenCalledTimes(3);
      expect(onProgress).toHaveBeenCalledWith(1, 3);
      expect(onProgress).toHaveBeenCalledWith(2, 3);
      expect(onProgress).toHaveBeenCalledWith(3, 3);
    });

    it("handles empty datasets array", async () => {
      const exportCsvSpy = vi.spyOn(api, "exportCsv");

      await api.exportBulkCsv({ datasets: [] });

      expect(exportCsvSpy).not.toHaveBeenCalled();
    });

    it("does not call onProgress when not provided", async () => {
      const promise = api.exportBulkCsv({
        datasets: [{ datasetId: "ds1", datasetName: "DS1" }],
      });

      await vi.runAllTimersAsync();
      await promise;

      // Should not throw
    });

    it("handles single dataset without delay", async () => {
      const exportCsvSpy = vi.spyOn(api, "exportCsv");

      const promise = api.exportBulkCsv({
        datasets: [{ datasetId: "ds1", datasetName: "DS1" }],
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(exportCsvSpy).toHaveBeenCalledTimes(1);
    });
  });
});
