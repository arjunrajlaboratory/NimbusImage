import { describe, it, expect } from "vitest";
import type { IAgentWireMessage } from "@/store/AgentAPI";
import {
  PRUNED_IMAGE_PLACEHOLDER,
  pruneOldScreenshots,
  repairDanglingToolUse,
} from "./wireConversation";

const image = {
  type: "image" as const,
  source: { type: "base64" as const, media_type: "image/png", data: "AAAA" },
};

describe("pruneOldScreenshots", () => {
  it("replaces image blocks inside user tool_result content", () => {
    const messages: IAgentWireMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: '{"captured":["viewport"]}' },
              image,
            ],
          },
        ],
      },
    ];
    pruneOldScreenshots(messages);
    const result = messages[0].content[0] as any;
    expect(result.content).toEqual([
      { type: "text", text: '{"captured":["viewport"]}' },
      { type: "text", text: PRUNED_IMAGE_PLACEHOLDER },
    ]);
  });

  it("never touches assistant messages (thinking blocks must survive)", () => {
    const assistant: IAgentWireMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig" } as any,
        { type: "tool_use", id: "t1", name: "capture_screenshot", input: {} },
      ],
    };
    const copy = JSON.parse(JSON.stringify(assistant));
    pruneOldScreenshots([assistant]);
    expect(assistant).toEqual(copy);
  });

  it("leaves plain text user messages and non-array content alone", () => {
    const messages: IAgentWireMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t2", content: "plain" as any },
        ],
      },
    ];
    const copy = JSON.parse(JSON.stringify(messages));
    pruneOldScreenshots(messages);
    expect(messages).toEqual(copy);
  });
});

describe("repairDanglingToolUse", () => {
  it("appends one error tool_result per dangling tool_use", () => {
    const messages: IAgentWireMessage[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Moving." },
          { type: "tool_use", id: "a", name: "set_location", input: { z: 2 } },
          { type: "tool_use", id: "b", name: "capture_screenshot", input: {} },
        ],
      },
    ];
    repairDanglingToolUse(messages);
    expect(messages).toHaveLength(3);
    const repair = messages[2];
    expect(repair.role).toBe("user");
    expect(repair.content.map((block: any) => block.tool_use_id)).toEqual([
      "a",
      "b",
    ]);
    for (const block of repair.content as any[]) {
      expect(block.type).toBe("tool_result");
      expect(block.is_error).toBe(true);
    }
    // The assistant message itself is untouched
    expect(messages[1].content).toHaveLength(3);
  });

  it("is a no-op when the conversation ends with a user message", () => {
    const messages: IAgentWireMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];
    repairDanglingToolUse(messages);
    expect(messages).toHaveLength(1);
  });

  it("is a no-op when the last assistant message has no tool_use", () => {
    const messages: IAgentWireMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    repairDanglingToolUse(messages);
    expect(messages).toHaveLength(2);
  });

  it("is a no-op on an empty conversation", () => {
    const messages: IAgentWireMessage[] = [];
    repairDanglingToolUse(messages);
    expect(messages).toHaveLength(0);
  });
});
