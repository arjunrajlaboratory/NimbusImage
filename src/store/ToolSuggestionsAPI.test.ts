import { describe, expect, it, vi } from "vitest";
import ToolSuggestionsAPI from "./ToolSuggestionsAPI";
import type { RestClientInstance } from "@/girder";

const params = { images: [], catalog: [], channels: [], layers: [] };

describe("ToolSuggestionsAPI.getToolSuggestions", () => {
  it("returns the backend's suggestions", async () => {
    const suggestions = [{ toolId: "manual:blob", reason: "Blobs seen." }];
    const post = vi.fn().mockResolvedValue({ data: { suggestions } });
    const api = new ToolSuggestionsAPI({
      post,
    } as unknown as RestClientInstance);
    expect(await api.getToolSuggestions(params)).toEqual(suggestions);
    expect(post).toHaveBeenCalledWith("claude_suggest_tools", params);
  });

  it("throws on an {error} body so the store takes its retryable failure path", async () => {
    // The backend returns {error} (HTTP 200) for a refusal or max_tokens stop.
    // Resolving it as an empty list would let the store persist the
    // configuration as "suggested" and never retry.
    const post = vi.fn().mockResolvedValue({
      data: { error: "Tool suggestion stopped early (refusal)" },
    });
    const api = new ToolSuggestionsAPI({
      post,
    } as unknown as RestClientInstance);
    await expect(api.getToolSuggestions(params)).rejects.toThrow(
      "Tool suggestion stopped early (refusal)",
    );
  });
});
