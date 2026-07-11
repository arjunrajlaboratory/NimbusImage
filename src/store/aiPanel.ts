import {
  VuexModule,
  Module,
  Mutation,
  Action,
  getModule,
} from "vuex-module-decorators";
import store from "./root";
import main from "./index";
import { logError } from "@/utils/log";
import {
  IAgentToolResultBlock,
  IAgentToolUseBlock,
  IAgentWireMessage,
  TAgentContentBlock,
} from "./AgentAPI";
import {
  buildInterfaceState,
  describeAgentToolCall,
  executeAgentTool,
  isGatedTool,
  IViewStateSnapshot,
  restoreViewState,
  snapshotViewState,
  viewIdentityChangedSince,
} from "@/agent/executors";
import {
  pruneOldScreenshots,
  repairDanglingToolUse,
} from "@/agent/wireConversation";
import { dataUrlToBase64 } from "@/utils/interfaceCapture";

// AI panel: conversational agent that drives the interface through the tool
// executors in src/agent/executors.ts. The frontend owns the agent loop; the
// backend (claude_agent endpoint) is a stateless relay that attaches the API
// key, system prompt and tool definitions. See
// codebaseDocumentation/AI_PANEL_SPEC.md.

export type TAgentToolStatus =
  | "pending-approval"
  | "running"
  | "done"
  | "error"
  | "declined";

export interface IAgentPanelItem {
  kind: "user" | "assistant" | "tool" | "info" | "error";
  // Message text; for tool items, a human-readable action description
  text: string;
  toolName?: string;
  status?: TAgentToolStatus;
  // Short outcome note for tool items (e.g. "42 annotations affected")
  detail?: string;
}

// Upper bound on model round-trips per user message; the backend has a
// looser backstop on total conversation length.
const MAX_TOOL_ITERATIONS = 20;

// Tools whose effects are captured by the per-turn view snapshot and can be
// reverted with "revert view changes". Annotation edits (color/tag/undo)
// ride the backend undo history instead.
const VIEW_STATE_TOOLS = new Set([
  "set_location",
  "set_camera",
  "set_layer_mode",
  "update_layer",
  "set_layer_visibility",
  "set_display_options",
  "set_view_mode",
  "select_annotations",
  "set_annotation_filter",
  "select_tool",
]);

// Kept outside Vuex state: the wire conversation contains base64 images and
// must not be wrapped in reactive proxies; the resolver and element are not
// serializable state.
let wireMessages: IAgentWireMessage[] = [];
let approvalResolver: ((approved: boolean) => void) | null = null;
let turnSnapshot: IViewStateSnapshot | null = null;
let panelElement: HTMLElement | null = null;
// Bumped on clearConversation so late async notifications (e.g. a worker
// job finishing minutes after its conversation was cleared) are dropped
// instead of landing in an unrelated conversation.
let conversationGeneration = 0;
// Identity of the last authenticated user the conversation belonged to, so a
// login/logout (client-side, no page reload) clears the prior user's history.
// `undefined` until the first check runs.
let lastKnownUserId: string | null | undefined = undefined;

export function setAgentPanelElement(element: HTMLElement | null) {
  panelElement = element;
}

function toResultContent(
  result: any,
  images?: { data: string }[],
): IAgentToolResultBlock["content"] {
  const content: IAgentToolResultBlock["content"] = [
    { type: "text", text: JSON.stringify(result) },
  ];
  for (const image of images ?? []) {
    const source = dataUrlToBase64(image.data);
    if (source) {
      content.push({
        type: "image",
        source: { type: "base64", ...source },
      });
    }
  }
  return content;
}

function toolResultDetail(result: any): string | undefined {
  if (result == null || typeof result !== "object") {
    return undefined;
  }
  if (typeof result.affectedCount === "number") {
    return `${result.affectedCount} annotation${
      result.affectedCount === 1 ? "" : "s"
    } affected`;
  }
  if (typeof result.selectedCount === "number") {
    return `${result.selectedCount} selected`;
  }
  if (typeof result.filteredCount === "number") {
    return `${result.filteredCount} annotations pass the filter`;
  }
  if (result.jobId) {
    return "job started";
  }
  return undefined;
}

@Module({ dynamic: true, store, name: "aiPanel" })
export class AiPanel extends VuexModule {
  items: IAgentPanelItem[] = [];
  running: boolean = false;
  stopRequested: boolean = false;
  autoApprove: boolean = false;
  // Index into `items` of the tool card awaiting user approval
  pendingApprovalIndex: number | null = null;
  canRevert: boolean = false;

  @Mutation
  private addItemImpl(item: IAgentPanelItem) {
    this.items.push(item);
  }

  @Mutation
  private updateItemImpl({
    index,
    changes,
  }: {
    index: number;
    changes: Partial<IAgentPanelItem>;
  }) {
    if (this.items[index]) {
      Object.assign(this.items[index], changes);
    }
  }

  @Mutation
  private setRunning(value: boolean) {
    this.running = value;
  }

  @Mutation
  private setStopRequested(value: boolean) {
    this.stopRequested = value;
  }

  @Mutation
  setAutoApprove(value: boolean) {
    this.autoApprove = value;
  }

  @Mutation
  private setPendingApprovalIndex(value: number | null) {
    this.pendingApprovalIndex = value;
  }

  @Mutation
  private setCanRevert(value: boolean) {
    this.canRevert = value;
  }

  @Mutation
  private clearItemsImpl() {
    this.items = [];
  }

  @Action
  requestStop() {
    if (!this.running) {
      return;
    }
    this.setStopRequested(true);
    // A pending approval blocks the loop; resolve it as declined so the
    // stop takes effect immediately.
    if (approvalResolver) {
      approvalResolver(false);
    }
  }

  @Action
  approvePendingTool(approved: boolean) {
    if (approvalResolver) {
      approvalResolver(approved);
    }
  }

  @Action
  async revertViewChanges() {
    if (!turnSnapshot) {
      return;
    }
    if (viewIdentityChangedSince(turnSnapshot)) {
      // The user navigated to a different dataset since the last turn;
      // reverting would alter the wrong dataset's view.
      this.setCanRevert(false);
      this.addItemImpl({
        kind: "error",
        text: "Can't revert: you've switched to a different dataset since those changes were made.",
      });
      return;
    }
    try {
      await restoreViewState(turnSnapshot);
      this.setCanRevert(false);
      this.addItemImpl({
        kind: "info",
        text: "Reverted the view changes from the last message.",
      });
    } catch (error) {
      logError("Failed to revert view state:", error);
      this.addItemImpl({
        kind: "error",
        text: "Failed to revert some view changes; see console for details.",
      });
    }
  }

  @Action
  clearConversation(force = false) {
    if (this.running && !force) {
      return;
    }
    wireMessages = [];
    turnSnapshot = null;
    conversationGeneration++;
    this.clearItemsImpl();
    this.setCanRevert(false);
    // A forced clear during an in-flight run (e.g. the authenticated user
    // changed) also stops the loop, which checks the generation and bails
    // without pushing anything into the fresh conversation.
    if (this.running) {
      this.setStopRequested(true);
      // A gated tool may be blocking the loop on the approval promise; resolve
      // it as declined (same as requestStop) so the loop unwinds immediately
      // instead of hanging until the user happens to press Stop.
      if (approvalResolver) {
        approvalResolver(false);
      }
    }
  }

  // Clear the conversation when the authenticated user changes, so one user's
  // prompts, annotation results and interface metadata are never sent to the
  // backend as part of another user's session. Wired to a watcher on the
  // logged-in user in App.vue. No-op when the identity is unchanged.
  @Action
  handleAuthenticatedUserChange(userId: string | null) {
    if (userId === lastKnownUserId) {
      return;
    }
    lastKnownUserId = userId;
    this.clearConversation(true);
  }

  @Action
  async sendUserMessage(text: string) {
    const trimmed = text.trim();
    if (this.running || !trimmed) {
      return;
    }
    this.setRunning(true);
    this.setStopRequested(false);
    turnSnapshot = snapshotViewState();
    this.setCanRevert(false);
    // If the conversation is cleared mid-run (e.g. the user logs out/in),
    // conversationGeneration is bumped; the loop below bails on any mismatch
    // so a stale response is never pushed into the fresh conversation.
    const generationAtStart = conversationGeneration;

    // Drop base64 screenshots from earlier turns before this turn's calls.
    pruneOldScreenshots(wireMessages);

    this.addItemImpl({ kind: "user", text: trimmed });
    // Every turn should end with something visible below the user message;
    // compare against this to detect empty turns (e.g. a refusal).
    const itemCountAfterUserMessage = this.items.length;
    wireMessages.push({
      role: "user",
      content: [
        { type: "text", text: trimmed },
        {
          type: "text",
          text:
            "Current interface state (auto-attached):\n" +
            JSON.stringify(buildInterfaceState()),
        },
      ],
    });

    // Whether any assistant message was appended to wireMessages this turn;
    // drives the failure-recovery in the catch block.
    let assistantPushedThisTurn = false;
    try {
      let iteration = 0;
      for (; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const response = await main.agentAPI.postAgentMessage(wireMessages);
        if (conversationGeneration !== generationAtStart) {
          // Cleared/cancelled during the API call (e.g. user changed); discard
          // this response rather than mutating the fresh conversation.
          return;
        }
        // Push the assistant turn verbatim: thinking blocks must be sent
        // back unchanged on the next request.
        wireMessages.push({ role: "assistant", content: response.content });
        assistantPushedThisTurn = true;
        for (const block of response.content) {
          if (block.type === "text" && block.text.trim()) {
            this.addItemImpl({ kind: "assistant", text: block.text });
          }
        }
        if (response.stop_reason !== "tool_use") {
          if (response.stop_reason === "max_tokens") {
            this.addItemImpl({
              kind: "info",
              text: "The response was cut short (output limit reached). Ask the assistant to continue if something is missing.",
            });
          }
          break;
        }
        const toolUses = response.content.filter(
          (block: TAgentContentBlock): block is IAgentToolUseBlock =>
            block.type === "tool_use",
        );
        // Sequential on purpose: UI actions are order-dependent (e.g. move,
        // then screenshot). Recheck the dataset identity before EACH tool: the
        // user can navigate to a different dataset while an earlier async tool
        // runs, so later tools must not execute against the new one. Once it
        // changes, decline the remaining tools (with valid tool_results so the
        // wire history stays consistent) rather than acting on the wrong data.
        const results: IAgentToolResultBlock[] = [];
        let datasetChanged = false;
        for (const toolUse of toolUses) {
          if (turnSnapshot && viewIdentityChangedSince(turnSnapshot)) {
            datasetChanged = true;
          }
          results.push(
            datasetChanged
              ? {
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: toResultContent({
                    declined: true,
                    reason:
                      "Aborted: the active dataset changed; not executing " +
                      "against a different dataset than the request targeted.",
                  }),
                }
              : await this.executeToolUse(toolUse),
          );
        }
        if (conversationGeneration !== generationAtStart) {
          // Cleared/cancelled while tools ran; drop the results.
          return;
        }
        wireMessages.push({ role: "user", content: results });
        if (datasetChanged) {
          this.addItemImpl({
            kind: "error",
            text: "You switched datasets mid-response, so I stopped without running all the pending actions. Send a new message to continue on this dataset.",
          });
          break;
        }
        if (this.stopRequested) {
          this.addItemImpl({ kind: "info", text: "Stopped." });
          break;
        }
      }
      if (iteration >= MAX_TOOL_ITERATIONS) {
        this.addItemImpl({
          kind: "info",
          text: `Stopped after ${MAX_TOOL_ITERATIONS} tool calls. Send a message to continue.`,
        });
      }
      if (this.items.length === itemCountAfterUserMessage) {
        // No text, no tool calls, no info — e.g. a refusal or an empty
        // reply. Show something so the turn doesn't look like a hang.
        this.addItemImpl({
          kind: "info",
          text: "The assistant returned no visible output for this message.",
        });
      }
    } catch (error: any) {
      logError("Agent loop error:", error);
      this.addItemImpl({
        kind: "error",
        text:
          error?.response?.data?.message ??
          error?.message ??
          "Unknown agent error",
      });
      if (assistantPushedThisTurn) {
        // If the failure left a dangling tool_use with no tool_result,
        // append synthetic error results so the conversation stays valid.
        repairDanglingToolUse(wireMessages);
      } else if (
        wireMessages.length > 0 &&
        wireMessages[wireMessages.length - 1].role === "user"
      ) {
        // The loop failed before any assistant turn; drop the user message
        // we optimistically pushed so a retry starts clean and doesn't
        // produce consecutive user messages or a stale interface-state block.
        wireMessages.pop();
      }
    } finally {
      this.setRunning(false);
      this.setStopRequested(false);
    }
  }

  @Action
  private async executeToolUse(
    toolUse: IAgentToolUseBlock,
  ): Promise<IAgentToolResultBlock> {
    // describeAgentToolCall runs on unvalidated model input; never let a
    // formatting error abort the turn (which would strand this tool_use).
    let description: string;
    try {
      description = describeAgentToolCall(toolUse.name, toolUse.input);
    } catch {
      description = toolUse.name;
    }
    const itemIndex = this.items.length;
    const gated = isGatedTool(toolUse.name) && !this.autoApprove;
    this.addItemImpl({
      kind: "tool",
      toolName: toolUse.name,
      text: description,
      status: gated ? "pending-approval" : "running",
    });

    if (this.stopRequested) {
      // Every tool_use block needs a matching tool_result, even after stop
      this.updateItemImpl({
        index: itemIndex,
        changes: { status: "declined", detail: "stopped" },
      });
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: toResultContent({
          declined: true,
          reason: "The user stopped the run before this action executed.",
        }),
      };
    }

    if (gated) {
      this.setPendingApprovalIndex(itemIndex);
      const approved = await new Promise<boolean>((resolve) => {
        approvalResolver = resolve;
      });
      approvalResolver = null;
      this.setPendingApprovalIndex(null);
      if (!approved) {
        this.updateItemImpl({
          index: itemIndex,
          changes: { status: "declined" },
        });
        return {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: toResultContent({
            declined: true,
            reason:
              "The user declined this action. Do not retry it; adjust your plan or ask the user what they would like instead.",
          }),
        };
      }
      this.updateItemImpl({ index: itemIndex, changes: { status: "running" } });
    }

    try {
      // Late notifications (e.g. worker completion) reference this
      // conversation; drop them if it has been cleared in the meantime.
      const generation = conversationGeneration;
      const { result, images } = await executeAgentTool(
        toolUse.name,
        toolUse.input,
        {
          panelElement,
          notify: (text: string) => {
            if (generation === conversationGeneration) {
              this.addItemImpl({ kind: "info", text });
            }
          },
        },
      );
      this.updateItemImpl({
        index: itemIndex,
        changes: { status: "done", detail: toolResultDetail(result) },
      });
      if (VIEW_STATE_TOOLS.has(toolUse.name)) {
        this.setCanRevert(true);
      }
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: toResultContent(result, images),
      };
    } catch (error: any) {
      const message = error?.message ?? "Tool execution failed";
      this.updateItemImpl({
        index: itemIndex,
        changes: { status: "error", detail: message },
      });
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: toResultContent({ error: message }),
        is_error: true,
      };
    }
  }
}

export default getModule(AiPanel);

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}
