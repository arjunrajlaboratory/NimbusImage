import { RestClientInstance } from "@/girder";

export interface IAnalysisPropertyRef {
  id: string;
  name: string;
}

export interface IAnalysisPropertyPathRef {
  path: string[];
  fullName: string | null;
}

export interface IAnalysisRequest {
  datasetId: string;
  instructions: string;
  properties: IAnalysisPropertyRef[];
  propertyPaths: IAnalysisPropertyPathRef[];
}

export interface IAnalysisPlot {
  id: string;
  title: string;
  data: unknown[];
  layout: Record<string, unknown>;
}

export interface IAnalysisToolLogEntry {
  tool: string;
  input: Record<string, unknown>;
  summary: string;
}

export interface IAnalysisResult {
  summary: string;
  plots: IAnalysisPlot[];
  toolLog: IAnalysisToolLogEntry[];
  error: string | null;
}

export default class AnalysisAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  async runAnalysis(request: IAnalysisRequest): Promise<IAnalysisResult> {
    const response = await this.client.post("claude_analysis", {
      ...request,
    });
    const { data } = response;
    if (data?.error) {
      throw new Error(data.error);
    }
    return data as IAnalysisResult;
  }
}
