import { RestClientInstance } from "@/girder";

// Anthropic wire-format types for the AI-panel agent loop.
// The frontend owns the loop (see codebaseDocumentation/AI_PANEL_SPEC.md):
// it keeps the conversation in this format and posts it to the backend's
// claude_agent endpoint, which attaches the API key, system prompt and tool
// definitions.

export interface IAgentTextBlock {
  type: "text";
  text: string;
}

export interface IAgentImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface IAgentToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface IAgentToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: (IAgentTextBlock | IAgentImageBlock)[];
  is_error?: boolean;
}

// Thinking blocks (adaptive thinking) must be passed back to the API
// verbatim on the next request, so they are kept in the wire messages.
export interface IAgentOpaqueBlock {
  type: "thinking" | "redacted_thinking";
  [key: string]: any;
}

export type TAgentContentBlock =
  | IAgentTextBlock
  | IAgentImageBlock
  | IAgentToolUseBlock
  | IAgentToolResultBlock
  | IAgentOpaqueBlock;

export interface IAgentWireMessage {
  role: "user" | "assistant";
  content: TAgentContentBlock[];
}

export interface IAgentResponse {
  content: TAgentContentBlock[];
  stop_reason: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export default class AgentAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  async postAgentMessage(
    messages: IAgentWireMessage[],
  ): Promise<IAgentResponse> {
    const { data } = await this.client.post("claude_agent", { messages });
    if (!data) {
      throw new Error("Empty response from the agent endpoint");
    }
    if (data.error) {
      throw new Error(data.error);
    }
    return data as IAgentResponse;
  }
}
