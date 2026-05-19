import { DeflateOptions, Zip, ZipDeflate } from "fflate";

import { RestClientInstance } from "@/girder";
import { downloadToClient } from "@/utils/download";

export interface IExportOptions {
  datasetId: string;
  configurationId?: string;
  includeAnnotations?: boolean;
  includeConnections?: boolean;
  includeProperties?: boolean;
  includePropertyValues?: boolean;
  filename?: string;
}

export interface ICsvExportOptions {
  datasetId: string;
  propertyPaths?: string[][];
  annotationIds?: string[];
  undefinedValue?: "" | "NA" | "NaN";
  delimiter?: "," | "\t";
  filename?: string;
}

export interface IBulkExportDataset {
  datasetId: string;
  datasetName: string;
}

export interface IBulkJsonExportOptions {
  datasets: IBulkExportDataset[];
  configurationId?: string;
  includeAnnotations?: boolean;
  includeConnections?: boolean;
  includeProperties?: boolean;
  includePropertyValues?: boolean;
  zipFilename?: string;
  onProgress?: (completed: number, total: number) => void;
}

export interface IBulkCsvExportOptions {
  datasets: IBulkExportDataset[];
  propertyPaths?: string[][];
  undefinedValue?: "" | "NA" | "NaN";
  delimiter?: "," | "\t";
  onProgress?: (completed: number, total: number) => void;
}

// Dataset names are user-controlled, so collapse anything that would turn
// the ZIP entry into a nested or traversal path into a flat filename.
function sanitizeZipEntryName(name: string): string {
  const sanitized = name.replace(/[\\/]/g, "_").trim();
  return sanitized || "dataset";
}

interface IJsonExportParams {
  datasetId: string;
  configurationId?: string;
  includeAnnotations?: boolean;
  includeConnections?: boolean;
  includeProperties?: boolean;
  includePropertyValues?: boolean;
  filename?: string;
}

function buildJsonExportParams(opts: IJsonExportParams): URLSearchParams {
  const params = new URLSearchParams();
  params.set("datasetId", opts.datasetId);
  if (opts.configurationId) {
    params.set("configurationId", opts.configurationId);
  }
  if (opts.includeAnnotations !== undefined) {
    params.set("includeAnnotations", String(opts.includeAnnotations));
  }
  if (opts.includeConnections !== undefined) {
    params.set("includeConnections", String(opts.includeConnections));
  }
  if (opts.includeProperties !== undefined) {
    params.set("includeProperties", String(opts.includeProperties));
  }
  if (opts.includePropertyValues !== undefined) {
    params.set("includePropertyValues", String(opts.includePropertyValues));
  }
  if (opts.filename) {
    params.set("filename", opts.filename);
  }
  return params;
}

export default class ExportAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  /**
   * Export dataset as JSON via direct browser download.
   * Uses streaming from backend - no frontend memory usage.
   */
  exportJson(options: IExportOptions): void {
    const params = buildJsonExportParams(options);

    // Add auth token for authenticated downloads
    const token = (this.client as any).token;
    if (token && token !== "#/") {
      params.set("token", token);
    }

    const url = `${this.client.apiRoot}/export/json?${params.toString()}`;

    downloadToClient({
      href: url,
      download: options.filename || "export.json",
    });
  }

  /**
   * Export dataset annotations as CSV via POST request.
   * Uses POST to avoid URL length limits with large property/annotation lists.
   * Streams response from backend - handles large datasets without memory issues.
   */
  async exportCsv(options: ICsvExportOptions): Promise<void> {
    const url = `${this.client.apiRoot}/export/csv`;
    const token = (this.client as any).token;

    const body = {
      datasetId: options.datasetId,
      propertyPaths: options.propertyPaths || [],
      annotationIds: options.annotationIds || [],
      undefinedValue: options.undefinedValue ?? "",
      delimiter: options.delimiter || ",",
      filename: options.filename || "export.csv",
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token && token !== "#/") {
      headers["Girder-Token"] = token;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`CSV export failed: ${response.statusText}`);
    }

    // Get the blob and trigger download
    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);

    downloadToClient({
      href: downloadUrl,
      download: options.filename || "export.csv",
    });

    // Clean up the object URL after a short delay
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  }

  /**
   * Export multiple datasets as a single ZIP file containing one JSON per
   * dataset. Each dataset is fetched sequentially and streamed into the zip,
   * so only one dataset's JSON is held in memory at a time. The browser is
   * prompted to save once for the whole archive.
   */
  async exportBulkJson(options: IBulkJsonExportOptions): Promise<void> {
    const { datasets, onProgress } = options;
    if (datasets.length === 0) return;

    const zip = new Zip();
    // The full archive is buffered in memory before the save prompt. JSON
    // exports are small in practice, but very large bulk exports could OOM
    // the tab. See issue #1169 for a streaming download alternative.
    const zipChunks: Uint8Array[] = [];
    const zipDone = new Promise<Blob>((resolve, reject) => {
      zip.ondata = (err, data, final) => {
        if (err) {
          reject(err);
          return;
        }
        zipChunks.push(data);
        if (final) {
          resolve(
            new Blob(zipChunks as BlobPart[], { type: "application/zip" }),
          );
        }
      };
    });

    const deflateOptions: DeflateOptions = { level: 9 };
    const usedFilenames = new Set<string>();

    for (let i = 0; i < datasets.length; i++) {
      const dataset = datasets[i];

      const baseName = sanitizeZipEntryName(dataset.datasetName);
      let fileName = `${baseName}.json`;
      for (let counter = 1; usedFilenames.has(fileName); counter++) {
        fileName = `${baseName} (${counter}).json`;
      }
      usedFilenames.add(fileName);

      const params = buildJsonExportParams({
        datasetId: dataset.datasetId,
        configurationId: options.configurationId,
        includeAnnotations: options.includeAnnotations,
        includeConnections: options.includeConnections,
        includeProperties: options.includeProperties,
        includePropertyValues: options.includePropertyValues,
        filename: fileName,
      });

      const { data } = await this.client.get(
        `export/json?${params.toString()}`,
        { responseType: "arraybuffer" },
      );

      const zipFile = new ZipDeflate(fileName, deflateOptions);
      zip.add(zipFile);
      zipFile.push(new Uint8Array(data), true);

      if (onProgress) {
        onProgress(i + 1, datasets.length);
      }
    }

    zip.end();

    const blob = await zipDone;
    const downloadUrl = URL.createObjectURL(blob);
    downloadToClient({
      href: downloadUrl,
      download: options.zipFilename || "datasets.zip",
    });
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  }

  /**
   * Export multiple datasets as CSV files (one file per dataset).
   * Downloads are triggered sequentially with a delay to avoid browser issues.
   */
  async exportBulkCsv(options: IBulkCsvExportOptions): Promise<void> {
    const { datasets, onProgress } = options;
    const delay = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const extension = options.delimiter === "\t" ? ".tsv" : ".csv";

    for (let i = 0; i < datasets.length; i++) {
      const dataset = datasets[i];
      const filename = `${dataset.datasetName}${extension}`;

      await this.exportCsv({
        datasetId: dataset.datasetId,
        propertyPaths: options.propertyPaths,
        undefinedValue: options.undefinedValue,
        delimiter: options.delimiter,
        filename,
      });

      if (onProgress) {
        onProgress(i + 1, datasets.length);
      }

      // Add a small delay between downloads to allow browser to process
      if (i < datasets.length - 1) {
        await delay(500);
      }
    }
  }
}
