import { RestClientInstance } from "@/girder";
import {
  IChatImage,
  IChatMessage,
  IToolSuggestion,
  IToolSuggestionCatalogEntry,
} from "./model";

interface IClaudeAPIChatMessage {
  role: "user" | "assistant";
  content: {
    type: string;
    text?: string;
    source?: {
      type: string;
      media_type: string;
      data: string;
    };
  }[];
}

function toClaudeApiMessages(
  messages: IChatMessage[],
): IClaudeAPIChatMessage[] {
  const outputConversation: IClaudeAPIChatMessage[] = [];
  for (const message of messages) {
    const currentRole = message.type;
    // The only two possible roles are assistant and user
    if (currentRole !== "assistant" && currentRole !== "user") {
      continue;
    }

    // The first message has to be from the user
    const previousRole =
      outputConversation[outputConversation.length - 1]?.role;
    if (!previousRole && currentRole !== "user") {
      continue;
    }

    const messageContent: IClaudeAPIChatMessage["content"] = [
      { type: "text", text: message.content },
    ];
    message.images?.forEach((image: IChatImage) => {
      const match = image.data.match(
        /data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*,(.*)/,
      );
      if (match?.length === 3) {
        const [, mediaType, data] = match;
        messageContent.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data,
          },
        });
      }
    });

    const claudeApiMessage: IClaudeAPIChatMessage = {
      role: currentRole,
      content: messageContent,
    };
    // The API specifies that the same role can't appear twice in a row
    // It is usually because an error occured, and the user didn't receive an answer to his message
    // In this case, the last message from the user should be used, so the last message is replaced
    // Otherwise the message is pushed in the conversation
    if (previousRole === currentRole) {
      outputConversation[outputConversation.length - 1] = claudeApiMessage;
    } else {
      outputConversation.push(claudeApiMessage);
    }
  }
  return outputConversation;
}

function toChatMessage(item: any): IChatMessage | null {
  if (item?.response) {
    return {
      type: "assistant",
      content: item.response,
    };
  }
  return null;
}

export default class ChatAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  async getChatBotAnswerToConversation(
    messages: IChatMessage[],
  ): Promise<IChatMessage | null> {
    const response = await this.client.post("claude_chat", {
      messages: toClaudeApiMessages(messages),
    });
    const { data } = response;
    if (!data) {
      return null;
    }
    if ("error" in data) {
      throw data.error;
    }
    return toChatMessage(data);
  }

  // Ask Claude which tools to suggest for a freshly opened dataset, given
  // screenshots of the interface + viewport, the catalog of tools the frontend
  // can set up, and the dataset's channel names. Returns raw suggestions that
  // reference the catalog by id (see store/toolSuggestions.ts for resolution).
  async getToolSuggestions(params: {
    images: { media_type: string; data: string }[];
    catalog: IToolSuggestionCatalogEntry[];
    channels: string[];
  }): Promise<IToolSuggestion[]> {
    const response = await this.client.post("claude_suggest_tools", params);
    const { data } = response;
    if (!data) {
      return [];
    }
    if ("error" in data) {
      throw data.error;
    }
    return data.suggestions ?? [];
  }
}
