import type {
  IAgentToolResultBlock,
  IAgentToolUseBlock,
  IAgentWireMessage,
} from "@/store/AgentAPI";

// Pure helpers that keep the AI panel's wire conversation (the Anthropic
// message array) valid and affordable across turns. Kept free of store
// imports so they can be unit tested in isolation; the aiPanel store calls
// them on its module-level wireMessages array.

export const PRUNED_IMAGE_PLACEHOLDER =
  "[screenshot from an earlier turn omitted — capture again if needed]";

// Screenshots are large base64 blobs; left in the conversation they would
// be resent on every subsequent API call and grow the conversation without
// bound. Called at the start of each new turn: every message already in the
// conversation belongs to a previous turn, so image blocks inside
// tool_result content can be replaced with a short text placeholder. Only
// user-role tool_result content is touched — assistant messages (including
// thinking blocks) are never modified.
export function pruneOldScreenshots(messages: IAgentWireMessage[]) {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    for (const block of message.content) {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) {
        continue;
      }
      block.content = block.content.map((inner) =>
        inner.type === "image"
          ? { type: "text", text: PRUNED_IMAGE_PLACEHOLDER }
          : inner,
      );
    }
  }
}

// If a turn failed after an assistant message with tool_use blocks was
// pushed but before the matching tool_result user message was appended, the
// conversation is left with dangling tool_use blocks and every subsequent
// API call fails validation. Append synthetic error tool_results (one per
// tool_use id) so the conversation stays valid. Assistant messages are
// never modified.
export function repairDanglingToolUse(messages: IAgentWireMessage[]) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") {
    return;
  }
  const toolUseBlocks = last.content.filter(
    (block): block is IAgentToolUseBlock => block.type === "tool_use",
  );
  if (toolUseBlocks.length === 0) {
    return;
  }
  messages.push({
    role: "user",
    content: toolUseBlocks.map(
      (block): IAgentToolResultBlock => ({
        type: "tool_result",
        tool_use_id: block.id,
        content: [
          { type: "text", text: "Tool execution was interrupted by an error" },
        ],
        is_error: true,
      }),
    ),
  });
}
