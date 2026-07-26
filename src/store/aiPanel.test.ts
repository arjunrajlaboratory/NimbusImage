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

vi.mock("@/agent/conversationStore", () => ({
  loadStoredConversation: vi.fn(async () => null),
  saveStoredConversation: vi.fn(async () => {}),
  clearStoredConversation: vi.fn(async () => {}),
  selectPlotsForStorage: vi.fn(() => []),
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
  isGatedTool,
  restoreViewState,
  viewIdentityChangedSince,
} from "@/agent/executors";
import {
  loadStoredConversation,
  saveStoredConversation,
  clearStoredConversation,
} from "@/agent/conversationStore";

const postAgentMessage = (main as any).agentAPI.postAgentMessage;
const mockExecuteAgentTool = executeAgentTool as any;
const mockIsGatedTool = isGatedTool as any;
const mockRestoreViewState = restoreViewState as any;
const mockViewIdentityChangedSince = viewIdentityChangedSince as any;
const mockLoad = loadStoredConversation as any;
const mockSave = saveStoredConversation as any;
const mockClearStore = clearStoredConversation as any;

// Yield to the event loop until `cond` holds (or we give up), for driving the
// module-level async loop to a known point (e.g. a pending approval).
async function waitFor(cond: () => boolean, tries = 100) {
  for (let i = 0; i < tries && !cond(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

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
  mockIsGatedTool.mockReturnValue(false);
  mockExecuteAgentTool.mockResolvedValue({ result: { ok: true } });
  // Reset module-level conversation state between tests.
  aiPanel.clearConversation(true);
});

describe("AI panel conversation isolation across users", () => {
  it("clears the conversation when the authenticated user changes", async () => {
    await aiPanel.handleAuthenticatedUserChange("userA");
    await aiPanel.sendUserMessage("secret from A");
    expect(lastSentPayload()).toContain("secret from A");

    // A different user logs in: the prior history must be dropped.
    await aiPanel.handleAuthenticatedUserChange("userB");
    await aiPanel.sendUserMessage("hello from B");

    const sent = lastSentPayload();
    expect(sent).toContain("hello from B");
    expect(sent).not.toContain("secret from A");
  });

  it("keeps the conversation when the same user is re-observed", async () => {
    await aiPanel.handleAuthenticatedUserChange("userA");
    await aiPanel.sendUserMessage("first from A");

    // Same identity (e.g. an unrelated reactive tick) must not clear.
    await aiPanel.handleAuthenticatedUserChange("userA");
    await aiPanel.sendUserMessage("second from A");

    const sent = lastSentPayload();
    expect(sent).toContain("first from A");
    expect(sent).toContain("second from A");
  });

  it("does not leak a response that arrives after a user change mid-run", async () => {
    await aiPanel.handleAuthenticatedUserChange("userA");

    // The API call for A's turn resolves only after B has logged in.
    let resolveA: (value: any) => void = () => {};
    postAgentMessage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveA = resolve;
      }),
    );
    const aTurn = aiPanel.sendUserMessage("secret from A");
    await aiPanel.handleAuthenticatedUserChange("userB");
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
    await aiPanel.handleAuthenticatedUserChange("userA");
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

  it("stops running later tools when the dataset changes mid-batch", async () => {
    await aiPanel.handleAuthenticatedUserChange("userA");
    postAgentMessage.mockResolvedValueOnce({
      content: [
        { type: "tool_use", id: "tu1", name: "set_location", input: {} },
        { type: "tool_use", id: "tu2", name: "color_annotations", input: {} },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    // Identity is fine before the first tool, then changes before the second.
    mockViewIdentityChangedSince
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await aiPanel.sendUserMessage("move, then color");

    // Only the first tool ran; the second was declined, not executed.
    expect(mockExecuteAgentTool).toHaveBeenCalledTimes(1);
    expect(
      aiPanel.items.some(
        (item) => item.kind === "error" && /switched datasets/.test(item.text),
      ),
    ).toBe(true);
  });

  it("does not revert when the dataset changed since the last turn", async () => {
    await aiPanel.handleAuthenticatedUserChange("userA");
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

  it("declines a gated tool approved after the dataset changed", async () => {
    await aiPanel.handleAuthenticatedUserChange("userA");
    mockIsGatedTool.mockReturnValue(true);
    aiPanel.setAutoApprove(false);
    postAgentMessage.mockResolvedValueOnce(toolUseResponse("run_worker"));

    // The loop parks on the approval promise for the gated tool.
    const turn = aiPanel.sendUserMessage("run the worker");
    await waitFor(() => aiPanel.pendingApprovalIndex !== null);

    // The user navigates to a different dataset while the prompt is open, then
    // approves. The tool must be declined, not run against the new dataset.
    mockViewIdentityChangedSince.mockReturnValue(true);
    aiPanel.approvePendingTool(true);
    await turn;

    expect(mockExecuteAgentTool).not.toHaveBeenCalled();
    expect(lastSentPayload()).toContain("active dataset changed");
  });
});

describe("AI panel forced clear (finding P2-D)", () => {
  it("resolves a pending approval so a forced clear doesn't hang the loop", async () => {
    await aiPanel.handleAuthenticatedUserChange("userA");
    mockIsGatedTool.mockReturnValue(true);
    aiPanel.setAutoApprove(false);
    postAgentMessage.mockResolvedValueOnce(toolUseResponse("run_worker"));

    // Don't await: the loop parks on the approval promise for a gated tool.
    const turn = aiPanel.sendUserMessage("run the worker");
    await waitFor(() => aiPanel.pendingApprovalIndex !== null);
    expect(aiPanel.pendingApprovalIndex).not.toBeNull();

    // A forced clear (e.g. the authenticated user changed) must unwind the
    // loop rather than leave it suspended on the approval promise.
    aiPanel.clearConversation(true);
    await turn;
    expect(aiPanel.running).toBe(false);
    expect(aiPanel.pendingApprovalIndex).toBeNull();
  });
});

describe("AI panel persistence", () => {
  // handleAuthenticatedUserChange no-ops when userId === lastKnownUserId, and
  // lastKnownUserId is module-level state that outlives the outer
  // beforeEach's clearConversation(true) call (which only resets the
  // in-memory conversation, not the last-known identity). Without this reset,
  // "restores a stored conversation for the same user" would inherit
  // lastKnownUserId === "userA" from the previous test and its
  // handleAuthenticatedUserChange("userA") call would be treated as a no-op,
  // never reaching the restore branch. Force a null identity first so every
  // test's own handleAuthenticatedUserChange call is a genuine transition.
  beforeEach(async () => {
    await aiPanel.handleAuthenticatedUserChange(null);
    mockSave.mockClear();
    mockLoad.mockClear();
    mockClearStore.mockClear();
  });

  it("saves the conversation after a completed turn", async () => {
    await aiPanel.handleAuthenticatedUserChange("userA");
    await aiPanel.sendUserMessage("remember this");
    expect(mockSave).toHaveBeenCalled();
    const saved = mockSave.mock.calls.at(-1)[0];
    expect(saved.userId).toBe("userA");
    expect(JSON.stringify(saved.wireMessages)).toContain("remember this");
  });

  it("restores a stored conversation for the same user", async () => {
    mockLoad.mockResolvedValueOnce({
      userId: "userA",
      items: [{ kind: "assistant", text: "restored line" }],
      wireMessages: [
        { role: "user", content: [{ type: "text", text: "old prompt" }] },
      ],
      updatedAt: 1,
    });
    await aiPanel.handleAuthenticatedUserChange("userA");
    expect(aiPanel.items.some((i) => i.text === "restored line")).toBe(true);
    // The restored wire history is resent on the next turn.
    await aiPanel.sendUserMessage("new prompt");
    expect(lastSentPayload()).toContain("old prompt");
  });

  it("wipes storage when a different user logs in", async () => {
    mockLoad.mockResolvedValueOnce({
      userId: "userA",
      items: [{ kind: "user", text: "A's data" }],
      wireMessages: [],
      updatedAt: 1,
    });
    await aiPanel.handleAuthenticatedUserChange("userB");
    expect(mockClearStore).toHaveBeenCalled();
    expect(aiPanel.items.some((i) => i.text === "A's data")).toBe(false);
  });

  it("clearConversationAndStorage wipes the store", async () => {
    await aiPanel.handleAuthenticatedUserChange("userA");
    await aiPanel.sendUserMessage("something");
    await aiPanel.clearConversationAndStorage();
    expect(mockClearStore).toHaveBeenCalled();
    expect(aiPanel.items).toHaveLength(0);
  });

  it("restores after a reload (null fire then the same user) without wiping", async () => {
    // The module-level `lastKnownUserId` this describe's own beforeEach
    // leaves behind is already `null` (not `undefined`), which makes
    // `handleAuthenticatedUserChange(null)` a guaranteed no-op regardless of
    // Fix 1 (userId === lastKnownUserId short-circuits before the wipe
    // branch). The real boot bug only reproduces on the very first call ever
    // made against the module, when lastKnownUserId is still `undefined` --
    // so exercise a genuinely fresh module instance here (same pattern as
    // src/pipelines/onnxModels.test.ts) instead of the already-imported
    // `aiPanel` singleton the other tests in this file share.
    vi.resetModules();
    const { default: freshAiPanel } = await import("./aiPanel");
    const {
      loadStoredConversation: freshLoad,
      clearStoredConversation: freshClear,
    } = (await import("@/agent/conversationStore")) as any;

    // Boot fires the watcher with null first (identity not yet resolved),
    // then again with the real id once the user fetch resolves.
    await freshAiPanel.handleAuthenticatedUserChange(null);
    expect(freshClear).not.toHaveBeenCalled(); // the null fire must NOT wipe

    freshLoad.mockResolvedValueOnce({
      userId: "userA",
      items: [{ kind: "assistant", text: "from before reload" }],
      wireMessages: [],
      updatedAt: 1,
    });
    await freshAiPanel.handleAuthenticatedUserChange("userA");
    expect(
      freshAiPanel.items.some((i: any) => i.text === "from before reload"),
    ).toBe(true);
  });

  it("does not restore an earlier user's conversation after a rapid switch", async () => {
    // A's stored-conversation load resolves only AFTER B has logged in.
    let resolveA: (value: any) => void = () => {};
    mockLoad
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveA = resolve;
        }),
      )
      .mockResolvedValueOnce(null);

    const aChange = aiPanel.handleAuthenticatedUserChange("userA");
    await aiPanel.handleAuthenticatedUserChange("userB"); // B settles first
    // A's load now resolves with A's transcript; it is stale and must be
    // discarded rather than surfacing in B's session.
    resolveA({
      userId: "userA",
      items: [{ kind: "assistant", text: "A private line" }],
      wireMessages: [],
      updatedAt: 1,
    });
    await aChange;

    expect(aiPanel.items.some((i) => i.text === "A private line")).toBe(false);
  });

  it("blocks sending until hydration finishes", async () => {
    let resolveLoad: (value: any) => void = () => {};
    mockLoad.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );

    const change = aiPanel.handleAuthenticatedUserChange("userA");
    // A send while the stored conversation is still loading must be a no-op,
    // so it can't be clobbered when that history lands.
    await aiPanel.sendUserMessage("typed too early");
    expect(postAgentMessage).not.toHaveBeenCalled();

    // Once hydration settles, sending works again.
    resolveLoad(null);
    await change;
    await aiPanel.sendUserMessage("now it works");
    expect(postAgentMessage).toHaveBeenCalled();
    expect(lastSentPayload()).toContain("now it works");
  });

  it("discards a plot from a tool whose conversation was cleared mid-run", async () => {
    await aiPanel.handleAuthenticatedUserChange("userA");
    postAgentMessage.mockResolvedValueOnce(
      toolUseResponse("create_scatter_plot"),
    );

    // The plot tool resolves only after the conversation is cleared (e.g. an
    // account change mid-analysis). Its plot must not leak into the now-current
    // conversation's transcript.
    let resolveTool: (value: any) => void = () => {};
    mockExecuteAgentTool.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTool = resolve;
      }),
    );
    const turn = aiPanel.sendUserMessage("plot it");
    await waitFor(() => mockExecuteAgentTool.mock.calls.length > 0);

    aiPanel.clearConversation(true); // bumps the generation mid-tool
    resolveTool({
      result: { plotId: "plot-leak" },
      plots: [{ id: "plot-leak", title: "leaked plot" }],
    });
    await turn;

    expect(aiPanel.items.some((i) => i.kind === "plot")).toBe(false);
  });

  it("releases the hydration guard when cleared mid-load", async () => {
    // A plain clearConversation during the hydration await bumps
    // conversationGeneration. The guard release keys off a dedicated hydration
    // counter, not conversationGeneration -- otherwise this in-flight hydration
    // mistakes the clear for a newer hydration, skips releasing `hydrating`,
    // and strands it true so every later send is silently swallowed.
    let resolveLoad: (value: any) => void = () => {};
    mockLoad.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );

    const change = aiPanel.handleAuthenticatedUserChange("userCleared");
    aiPanel.clearConversation(); // bumps conversationGeneration mid-hydration
    resolveLoad(null);
    await change;

    // The guard must be released, so a subsequent send is not swallowed.
    await aiPanel.sendUserMessage("after the clear");
    expect(postAgentMessage).toHaveBeenCalled();
    expect(lastSentPayload()).toContain("after the clear");
  });
});
