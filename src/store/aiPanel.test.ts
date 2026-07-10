import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression tests for AI_PANEL_REVIEW.md finding #4: the conversation must
// not survive an authenticated-user change (login/logout is client-side with
// no page reload, so the module-level wire history would otherwise carry one
// user's prompts and results into the next user's session).

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

vi.mock("@/utils/interfaceCapture", () => ({
  dataUrlToBase64: vi.fn(() => null),
}));

vi.mock("@/agent/wireConversation", () => ({
  pruneOldScreenshots: vi.fn(),
  repairDanglingToolUse: vi.fn(),
}));

vi.mock("@/agent/executors", () => ({
  buildInterfaceState: vi.fn(() => ({ dataset: null })),
  snapshotViewState: vi.fn(() => ({ datasetId: "ds1" })),
  describeAgentToolCall: vi.fn(() => "action"),
  executeAgentTool: vi.fn(),
  isGatedTool: vi.fn(() => false),
  restoreViewState: vi.fn(),
  viewIdentityChangedSince: vi.fn(() => false),
}));

// Mocked relative to the module under test, same directory, so it resolves to
// the same "./index" aiPanel.ts imports.
vi.mock("./index", () => ({
  default: {
    agentAPI: { postAgentMessage: vi.fn() },
  },
}));

import aiPanel from "./aiPanel";
import main from "./index";
import {
  executeAgentTool,
  restoreViewState,
  viewIdentityChangedSince,
} from "@/agent/executors";

const postAgentMessage = (main as any).agentAPI.postAgentMessage;
const mockExecuteAgentTool = executeAgentTool as any;
const mockRestoreViewState = restoreViewState as any;
const mockViewIdentityChangedSince = viewIdentityChangedSince as any;

function toolUseResponse(name: string) {
  return {
    content: [{ type: "tool_use", id: "tu1", name, input: {} }],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

// A terminal response (no tool_use) so sendUserMessage runs one iteration.
function terminalResponse(text: string) {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function lastSentPayload(): string {
  const calls = postAgentMessage.mock.calls;
  return JSON.stringify(calls[calls.length - 1][0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  postAgentMessage.mockResolvedValue(terminalResponse("reply"));
  // clearAllMocks keeps implementations, so reset the ones tests override.
  mockViewIdentityChangedSince.mockReturnValue(false);
  mockExecuteAgentTool.mockResolvedValue({ result: { ok: true } });
  // Reset module-level conversation state between tests.
  aiPanel.clearConversation(true);
});

describe("AI panel conversation isolation across users", () => {
  it("clears the conversation when the authenticated user changes", async () => {
    aiPanel.handleAuthenticatedUserChange("userA");
    await aiPanel.sendUserMessage("secret from A");
    expect(lastSentPayload()).toContain("secret from A");

    // A different user logs in: the prior history must be dropped.
    aiPanel.handleAuthenticatedUserChange("userB");
    await aiPanel.sendUserMessage("hello from B");

    const sent = lastSentPayload();
    expect(sent).toContain("hello from B");
    expect(sent).not.toContain("secret from A");
  });

  it("keeps the conversation when the same user is re-observed", async () => {
    aiPanel.handleAuthenticatedUserChange("userA");
    await aiPanel.sendUserMessage("first from A");

    // Same identity (e.g. an unrelated reactive tick) must not clear.
    aiPanel.handleAuthenticatedUserChange("userA");
    await aiPanel.sendUserMessage("second from A");

    const sent = lastSentPayload();
    expect(sent).toContain("first from A");
    expect(sent).toContain("second from A");
  });

  it("does not leak a response that arrives after a user change mid-run", async () => {
    aiPanel.handleAuthenticatedUserChange("userA");

    // The API call for A's turn resolves only after B has logged in.
    let resolveA: (value: any) => void = () => {};
    postAgentMessage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveA = resolve;
      }),
    );
    const aTurn = aiPanel.sendUserMessage("secret from A");
    aiPanel.handleAuthenticatedUserChange("userB");
    resolveA(terminalResponse("late reply for A"));
    await aTurn;

    // B sends: A's late response must not be part of B's wire history.
    await aiPanel.sendUserMessage("hello from B");
    const sent = lastSentPayload();
    expect(sent).toContain("hello from B");
    expect(sent).not.toContain("secret from A");
    expect(sent).not.toContain("late reply for A");
  });
});

describe("AI panel dataset binding (finding #1)", () => {
  it("aborts the turn without running tools when the dataset changes", async () => {
    aiPanel.handleAuthenticatedUserChange("userA");
    postAgentMessage.mockResolvedValueOnce(
      toolUseResponse("color_annotations"),
    );
    // The user navigated to a different dataset during the response.
    mockViewIdentityChangedSince.mockReturnValue(true);

    await aiPanel.sendUserMessage("color all my nuclei");

    expect(mockExecuteAgentTool).not.toHaveBeenCalled();
    expect(
      aiPanel.items.some(
        (item) => item.kind === "error" && /switched datasets/.test(item.text),
      ),
    ).toBe(true);
  });

  it("does not revert when the dataset changed since the last turn", async () => {
    aiPanel.handleAuthenticatedUserChange("userA");
    await aiPanel.sendUserMessage("do something"); // sets the turn snapshot
    mockViewIdentityChangedSince.mockReturnValue(true);

    await aiPanel.revertViewChanges();

    expect(mockRestoreViewState).not.toHaveBeenCalled();
    expect(
      aiPanel.items.some(
        (item) => item.kind === "error" && /Can't revert/.test(item.text),
      ),
    ).toBe(true);
  });
});
