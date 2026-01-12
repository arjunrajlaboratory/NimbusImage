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
}
