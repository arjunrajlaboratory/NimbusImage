<template>
  <div ref="rootEl">
    <v-card class="ai-panel">
      <div class="ai-header">
        <v-icon size="small" class="mr-2">mdi-robot-outline</v-icon>
        <span class="ai-title">Nimbus AI</span>
        <div class="ai-header-actions">
          <v-tooltip text="Revert the view changes from the last message">
            <template v-slot:activator="{ props: activatorProps }">
              <v-btn
                v-bind="activatorProps"
                v-if="canRevert && !running"
                icon
                variant="text"
                size="small"
                @click="aiPanelStore.revertViewChanges()"
              >
                <v-icon size="small">mdi-restore</v-icon>
              </v-btn>
            </template>
          </v-tooltip>
          <v-btn
            icon
            variant="text"
            size="small"
            :disabled="running"
            @click="aiPanelStore.clearConversationAndStorage()"
          >
            <v-icon size="small">mdi-refresh</v-icon>
          </v-btn>
          <v-btn icon variant="text" size="small" @click="emit('close')">
            <v-icon size="small">mdi-close</v-icon>
          </v-btn>
        </div>
      </div>
      <v-card-text>
        <div class="ai-items">
          <div v-if="items.length === 0" class="ai-empty">
            Ask me to drive the interface: move to a location, recolor layers or
            annotations, filter annotations, run workers…
          </div>
          <template v-for="(item, index) in reversedItems" :key="index">
            <div
              v-if="item.kind === 'user' || item.kind === 'assistant'"
              :class="item.kind"
            >
              <div
                v-if="item.kind === 'assistant'"
                v-html="renderAssistantMarkdown(item.text)"
              ></div>
              <div v-else>{{ item.text }}</div>
            </div>
            <div v-else-if="item.kind === 'tool'" class="tool-card">
              <span class="tool-status">
                <v-progress-circular
                  v-if="item.status === 'running'"
                  indeterminate
                  size="14"
                  width="2"
                />
                <v-icon v-else size="small" :color="statusColor(item.status)">
                  {{ statusIcon(item.status) }}
                </v-icon>
              </span>
              <span class="tool-text">
                {{ item.text }}
                <span v-if="item.detail" class="tool-detail">
                  — {{ item.detail }}
                </span>
              </span>
              <span
                v-if="isPendingApproval(item)"
                class="tool-approval-actions"
              >
                <v-btn
                  color="primary"
                  variant="flat"
                  size="small"
                  @click="aiPanelStore.approvePendingTool(true)"
                >
                  Run
                </v-btn>
                <v-btn
                  variant="text"
                  size="small"
                  @click="aiPanelStore.approvePendingTool(false)"
                >
                  Cancel
                </v-btn>
              </span>
            </div>
            <div v-else :class="item.kind">{{ item.text }}</div>
          </template>
        </div>
      </v-card-text>
      <v-card-actions>
        <div class="bottom-inputs">
          <v-textarea
            v-model="textInput"
            class="ai-input"
            :placeholder="running ? 'Working…' : 'Ask me to do something…'"
            rows="2"
            no-resize
            density="compact"
            variant="outlined"
            hide-details
            :disabled="running"
            @keyup.enter="!$event.shiftKey ? send() : undefined"
          />
          <v-btn
            v-if="running"
            icon
            variant="flat"
            size="small"
            color="error"
            @click="aiPanelStore.requestStop()"
          >
            <v-icon size="small">mdi-stop</v-icon>
          </v-btn>
          <v-btn
            v-else
            icon
            variant="flat"
            size="small"
            color="primary"
            @click="send"
          >
            <v-icon size="small">mdi-send</v-icon>
          </v-btn>
        </div>
        <div class="panel-options">
          <v-tooltip
            text="Skip the confirmation for every action that needs approval: worker runs, property computation, and tool / property / scale creation."
            location="top"
          >
            <template v-slot:activator="{ props: activatorProps }">
              <v-switch
                v-bind="activatorProps"
                v-model="autoApprove"
                density="compact"
                hide-details
                color="warning"
                class="auto-approve-switch"
              >
                <template v-slot:label>
                  <span class="auto-approve-label">
                    Auto-approve all actions
                  </span>
                </template>
              </v-switch>
            </template>
          </v-tooltip>
        </div>
      </v-card-actions>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { renderAssistantMarkdown } from "@/utils/renderMarkdown";
import aiPanelStore, {
  IAgentPanelItem,
  setAgentPanelElement,
  TAgentToolStatus,
} from "@/store/aiPanel";

const emit = defineEmits<{
  (e: "close"): void;
}>();

const rootEl = ref<HTMLElement>();
const textInput = ref("");

const items = computed(() => aiPanelStore.items);
// Rendered bottom-up in a column-reverse container so the latest entry is
// always in view (same trick as ChatComponent)
const reversedItems = computed(() => [...items.value].reverse());
const running = computed(() => aiPanelStore.running);
const canRevert = computed(() => aiPanelStore.canRevert);

const autoApprove = computed({
  get: () => aiPanelStore.autoApprove,
  set: (value: boolean) => aiPanelStore.setAutoApprove(value),
});

function isPendingApproval(item: IAgentPanelItem) {
  return (
    item.status === "pending-approval" &&
    aiPanelStore.pendingApprovalIndex !== null &&
    items.value[aiPanelStore.pendingApprovalIndex] === item
  );
}

function statusIcon(status?: TAgentToolStatus) {
  switch (status) {
    case "done":
      return "mdi-check";
    case "error":
      return "mdi-alert-circle-outline";
    case "declined":
      return "mdi-cancel";
    case "pending-approval":
      return "mdi-help-circle-outline";
    default:
      return "mdi-cog-outline";
  }
}

function statusColor(status?: TAgentToolStatus) {
  switch (status) {
    case "done":
      return "success";
    case "error":
      return "error";
    case "declined":
      return "warning";
    default:
      return undefined;
  }
}

async function send() {
  const text = textInput.value.trim();
  if (!text || running.value) {
    return;
  }
  textInput.value = "";
  await aiPanelStore.sendUserMessage(text);
}

onMounted(() => {
  setAgentPanelElement(rootEl.value ?? null);
});

onBeforeUnmount(() => {
  // Closing the panel while a gated tool is awaiting approval would suspend
  // the run invisibly; treat the close as declining the pending action.
  if (aiPanelStore.pendingApprovalIndex !== null) {
    aiPanelStore.approvePendingTool(false);
  }
  setAgentPanelElement(null);
});
</script>

<style scoped>
/* Same footprint and position as the ChatComponent card; App.vue keeps the
   two panels mutually exclusive since they would fully overlap. */
.ai-panel {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 520px;
  height: 680px;
  max-height: 680px;
  z-index: 2001;
  background-color: rgba(var(--v-theme-surface-bright), 0.88);
  backdrop-filter: blur(12px);
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  border: 1px solid var(--nimbus-border-strong);
  border-radius: var(--nimbus-radius-lg);
}

.ai-header {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.ai-title {
  font-size: 0.9rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  opacity: 0.9;
}

.ai-header-actions {
  margin-left: auto;
  display: flex;
  gap: 2px;
}

:deep(.v-card-text) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 8px;
}

.ai-items {
  display: flex;
  flex-direction: column-reverse;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  gap: 8px;
  padding: 4px;
}

.ai-empty {
  text-align: center;
  font-size: 0.85rem;
  opacity: 0.6;
  padding: 16px;
}

.user {
  align-self: flex-end;
  color: #ffffff;
  background-color: rgba(33, 150, 243, 0.25);
  border: 1px solid rgba(33, 150, 243, 0.3);
  padding: 8px 12px;
  border-radius: 12px 12px 2px 12px;
  max-width: 80%;
  width: fit-content;
  font-size: 0.85rem;
  line-height: 1.4;
}

.assistant {
  align-self: flex-start;
  color: rgba(255, 255, 255, 0.92);
  background-color: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.06);
  padding: 10px 14px;
  border-radius: 12px 12px 12px 2px;
  max-width: 90%;
  width: fit-content;
  font-size: 0.85rem;
  line-height: 1.5;
}

.assistant :deep(p) {
  margin: 0.25em 0;
}

.assistant :deep(ul),
.assistant :deep(ol) {
  padding-left: 1.4em;
  margin: 0.25em 0;
}

.assistant :deep(code) {
  background: rgba(255, 255, 255, 0.1);
  padding: 0.1em 0.35em;
  border-radius: 3px;
  font-size: 0.82rem;
}

/* Action transcript cards */
.tool-card {
  display: flex;
  align-items: center;
  gap: 8px;
  align-self: stretch;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.75);
  background-color: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 6px 10px;
}

.tool-status {
  display: inline-flex;
  align-items: center;
  width: 20px;
  justify-content: center;
  flex-shrink: 0;
}

.tool-text {
  flex: 1;
  min-width: 0;
}

.tool-detail {
  opacity: 0.7;
}

.tool-approval-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.info,
.error {
  text-align: center;
  font-size: 0.8rem;
  border-radius: 8px;
  padding: 6px 12px;
  margin: 2px 0;
}

.info {
  color: rgba(255, 255, 255, 0.65);
  background-color: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.error {
  color: rgba(255, 255, 255, 0.7);
  background-color: rgba(255, 80, 80, 0.15);
  border: 1px solid rgba(255, 80, 80, 0.2);
}

:deep(.v-card-actions) {
  flex-direction: column;
  align-items: stretch;
  flex-shrink: 0;
  padding: 0;
}

.bottom-inputs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 10px 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.ai-input {
  flex: 1;
}

.panel-options {
  display: flex;
  justify-content: flex-end;
  padding: 0 10px 4px;
}

.auto-approve-switch {
  flex: none;
}

.auto-approve-label {
  font-size: 0.75rem;
  opacity: 0.8;
}
</style>
