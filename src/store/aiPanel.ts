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
} from "@/agent/executors";
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
  clearConversation() {
    if (this.running) {
      return;
    }
    wireMessages = [];
    turnSnapshot = null;
    this.clearItemsImpl();
    this.setCanRevert(false);
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

    this.addItemImpl({ kind: "user", text: trimmed });
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

    try {
      let iteration = 0;
      for (; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const response = await main.agentAPI.postAgentMessage(wireMessages);
        // Push the assistant turn verbatim: thinking blocks must be sent
        // back unchanged on the next request.
        wireMessages.push({ role: "assistant", content: response.content });
        for (const block of response.content) {
          if (block.type === "text" && block.text.trim()) {
            this.addItemImpl({ kind: "assistant", text: block.text });
          }
        }
        if (response.stop_reason !== "tool_use") {
          break;
        }
        const toolUses = response.content.filter(
          (block: TAgentContentBlock): block is IAgentToolUseBlock =>
            block.type === "tool_use",
        );
        // Sequential on purpose: UI actions are order-dependent (e.g. move,
        // then screenshot).
        const results: IAgentToolResultBlock[] = [];
        for (const toolUse of toolUses) {
          results.push(await this.executeToolUse(toolUse));
        }
        wireMessages.push({ role: "user", content: results });
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
    } catch (error: any) {
      logError("Agent loop error:", error);
      this.addItemImpl({
        kind: "error",
        text:
          error?.response?.data?.message ??
          error?.message ??
          "Unknown agent error",
      });
    } finally {
      this.setRunning(false);
      this.setStopRequested(false);
    }
  }

  @Action
  private async executeToolUse(
    toolUse: IAgentToolUseBlock,
  ): Promise<IAgentToolResultBlock> {
    const description = describeAgentToolCall(toolUse.name, toolUse.input);
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
      const { result, images } = await executeAgentTool(
        toolUse.name,
        toolUse.input,
        {
          panelElement,
          notify: (text: string) => this.addItemImpl({ kind: "info", text }),
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
