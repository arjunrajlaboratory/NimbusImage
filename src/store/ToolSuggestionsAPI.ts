import { RestClientInstance } from "@/girder";
import {
  IToolSuggestion,
  IToolSuggestionCatalogEntry,
  IToolSuggestionLayerContext,
} from "./model";

function errorFromResponse(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : fallbackMessage);
}

// Auto tool-suggestion for a freshly opened dataset. Formerly part of ChatAPI;
// split out so it survives the removal of the chat feature.
export default class ToolSuggestionsAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  async getToolSuggestions(params: {
    images: { media_type: string; data: string }[];
    catalog: IToolSuggestionCatalogEntry[];
    channels: string[];
    layers: IToolSuggestionLayerContext[];
  }): Promise<IToolSuggestion[]> {
    const response = await this.client.post("claude_suggest_tools", params);
    const { data } = response;
    if (!data) {
      return [];
    }
    if ("error" in data) {
      throw errorFromResponse(data.error, "Claude tool suggestion failed.");
    }
    return data.suggestions ?? [];
  }
}
