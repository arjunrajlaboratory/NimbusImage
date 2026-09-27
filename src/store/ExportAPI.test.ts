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

  describe("exportCsv", () => {
    beforeEach(() => {
      const mockBlob = new Blob(["csv-content"], { type: "text/csv" });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(mockBlob),
      });
      global.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
      global.URL.revokeObjectURL = vi.fn();
    });

    it("sends sanitizeColumnNames in the request body", async () => {
      await api.exportCsv({
        datasetId: "ds1",
        propertyPaths: [["propA", "sub1"]],
        sanitizeColumnNames: true,
      });

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(body.sanitizeColumnNames).toBe(true);
    });

    it("defaults sanitizeColumnNames to false", async () => {
      await api.exportCsv({ datasetId: "ds1" });

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(body.sanitizeColumnNames).toBe(false);
    });

    it("omits annotationIds when no subset is supplied", async () => {
      await api.exportCsv({ datasetId: "ds1" });

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(body).not.toHaveProperty("annotationIds");
    });

    it("preserves an explicitly empty annotation subset", async () => {
      await api.exportCsv({ datasetId: "ds1", annotationIds: [] });

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(body.annotationIds).toEqual([]);
    });
  });

  describe("exportGeoJson", () => {
    beforeEach(() => {
      const mockBlob = new Blob(["{}"], { type: "application/geo+json" });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(mockBlob),
      });
      global.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
      global.URL.revokeObjectURL = vi.fn();
    });

    it("posts to export/geojson and downloads under the given name", async () => {
      const { downloadToClient } = await import("@/utils/download");
      await api.exportGeoJson({
        datasetId: "ds1",
        filename: "My data-annotations.geojson",
      });

      const [url, init] = (global.fetch as any).mock.calls[0];
      expect(url).toBe("http://localhost:8080/api/v1/export/geojson");
      expect(init.method).toBe("POST");
      expect(init.headers["Girder-Token"]).toBe("test-token");
      expect(JSON.parse(init.body)).toEqual({
        datasetId: "ds1",
        filename: "My data-annotations.geojson",
      });
      expect(downloadToClient).toHaveBeenCalledWith({
        href: "blob:mock-url",
        download: "My data-annotations.geojson",
      });
    });

    it("omits annotationIds for everything, keeps an empty subset", async () => {
      await api.exportGeoJson({ datasetId: "ds1" });
      await api.exportGeoJson({ datasetId: "ds1", annotationIds: [] });
      await api.exportGeoJson({ datasetId: "ds1", annotationIds: ["a"] });

      const bodies = (global.fetch as any).mock.calls.map((call: any) =>
        JSON.parse(call[1].body),
      );
      expect(bodies[0]).not.toHaveProperty("annotationIds");
      expect(bodies[1].annotationIds).toEqual([]);
      expect(bodies[2].annotationIds).toEqual(["a"]);
    });

    it("throws when the server refuses the export", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        statusText: "Bad Request",
      });
      await expect(api.exportGeoJson({ datasetId: "ds1" })).rejects.toThrow(
        "GeoJSON export failed: Bad Request",
      );
    });
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
        sanitizeColumnNames: true,
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
          sanitizeColumnNames: true,
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
