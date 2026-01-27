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
  filename?: string;
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
    const params = new URLSearchParams();
    params.set("datasetId", options.datasetId);

    if (options.configurationId) {
      params.set("configurationId", options.configurationId);
    }
    if (options.includeAnnotations !== undefined) {
      params.set("includeAnnotations", String(options.includeAnnotations));
    }
    if (options.includeConnections !== undefined) {
      params.set("includeConnections", String(options.includeConnections));
    }
    if (options.includeProperties !== undefined) {
      params.set("includeProperties", String(options.includeProperties));
    }
    if (options.includePropertyValues !== undefined) {
      params.set(
        "includePropertyValues",
        String(options.includePropertyValues),
      );
    }
    if (options.filename) {
      params.set("filename", options.filename);
    }

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
}
