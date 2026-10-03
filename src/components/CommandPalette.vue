<template>
  <v-dialog
    v-model="open"
    max-width="640px"
    class="command-palette"
    @after-enter="focusInput"
    @after-leave="runPendingCommand"
  >
    <v-card class="command-palette-card">
      <v-text-field
        ref="inputRef"
        v-model="query"
        class="command-palette-input"
        placeholder="Search commands, tools, panels, layers…"
        prepend-inner-icon="mdi-magnify"
        variant="solo"
        flat
        hide-details
        autofocus
        autocomplete="off"
        aria-label="Search commands"
        @keydown="onKeydown"
      />
      <v-divider />
      <v-list
        ref="listRef"
        class="command-palette-list"
        density="compact"
        role="listbox"
      >
        <template v-for="row in rows" :key="row.key">
          <v-list-subheader v-if="row.kind === 'header'">
            {{ row.label }}
          </v-list-subheader>
          <v-list-item
            v-else
            :active="row.index === activeIndex"
            :data-command-row="row.command.id"
            color="primary"
            role="option"
            :aria-selected="row.index === activeIndex"
            @click="choose(row.command)"
            @mousemove="activeIndex = row.index"
          >
            <template #prepend v-if="row.command.icon">
              <v-icon size="18">{{ row.command.icon }}</v-icon>
            </template>
            <v-list-item-title>{{ row.command.title }}</v-list-item-title>
            <v-list-item-subtitle v-if="row.command.description">
              {{ row.command.description }}
            </v-list-item-subtitle>
            <template #append v-if="row.command.hotkey">
              <kbd class="command-palette-hotkey">
                {{ formatHotkey(row.command.hotkey) }}
              </kbd>
            </template>
          </v-list-item>
        </template>
        <div v-if="commandRows.length === 0" class="command-palette-empty">
          No matching commands
        </div>
      </v-list>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRoute } from "vue-router";
import store from "@/store";
import propertyStore from "@/store/properties";
import { logError } from "@/utils/log";
import { enabledCommands, useCommandProvider } from "@/commands/registry";
import { rankCommands } from "@/commands/scorer";
import { recentCommandIds, recordRecentCommand } from "@/commands/recent";
import {
  IProviderContext,
  addToolCommands,
  layerCommands,
  propertyCommands,
  snapshotCommands,
  toolCommands,
} from "@/commands/providers";
import { COMMAND_GROUP_ORDER, ICommand } from "@/commands/types";
import { formatHotkey } from "@/commands/hotkeys";

// Results are capped so a broad query stays a short, scannable list.
const MAX_ROWS = 50;
// With an empty query, how many of each group to show under the recents.
const OVERVIEW_PER_GROUP = 4;

const open = defineModel<boolean>({ default: false });

type TRow =
  | { kind: "header"; key: string; label: string }
  | { kind: "command"; key: string; command: ICommand; index: number };

const route = useRoute();
const query = ref("");
const activeIndex = ref(0);
const inputRef = ref<{ focus: () => void } | null>(null);
const listRef = ref<{ $el: HTMLElement } | null>(null);
let pendingCommand: ICommand | null = null;

const providerContext: IProviderContext = {
  inViewer: () => route.name === "datasetview" && !!store.dataset,
};

// The store-derived providers. Panels, tours and static actions are
// registered by the components that own them (App.vue, DataIOMenu, ...).
useCommandProvider(toolCommands(providerContext));
useCommandProvider(addToolCommands(providerContext));
useCommandProvider(layerCommands(providerContext));
useCommandProvider(snapshotCommands(providerContext));
useCommandProvider(propertyCommands(providerContext));

// Grouped results, flattened into header and command rows. Command rows carry
// their position among commands only, which is what the arrow keys move over.
const rows = computed((): TRow[] => {
  const commands = enabledCommands.value;
  const sections: { label: string; commands: ICommand[] }[] = [];

  if (query.value.trim()) {
    // Groups ordered by their best match, so the top row is the top result.
    const byGroup = new Map<string, ICommand[]>();
    for (const command of rankCommands(commands, query.value, MAX_ROWS)) {
      const group = byGroup.get(command.group) ?? [];
      group.push(command);
      byGroup.set(command.group, group);
    }
    for (const [label, groupCommands] of byGroup) {
      sections.push({ label, commands: groupCommands });
    }
  } else {
    const byId = new Map(commands.map((command) => [command.id, command]));
    const recent = recentCommandIds.value
      .map((id) => byId.get(id))
      .filter((command): command is ICommand => !!command);
    if (recent.length) {
      sections.push({ label: "Recent", commands: recent });
    }
    const recentIds = new Set(recent.map((command) => command.id));
    for (const group of COMMAND_GROUP_ORDER) {
      const groupCommands = commands
        .filter(
          (command) => command.group === group && !recentIds.has(command.id),
        )
        .slice(0, OVERVIEW_PER_GROUP);
      if (groupCommands.length) {
        sections.push({ label: group, commands: groupCommands });
      }
    }
  }

  const result: TRow[] = [];
  let index = 0;
  for (const section of sections) {
    if (index >= MAX_ROWS) {
      break;
    }
    result.push({
      kind: "header",
      key: `header:${section.label}`,
      label: section.label,
    });
    for (const command of section.commands.slice(0, MAX_ROWS - index)) {
      result.push({
        kind: "command",
        key: `${section.label}:${command.id}`,
        command,
        index: index++,
      });
    }
  }
  return result;
});

const commandRows = computed(() =>
  rows.value.filter(
    (row): row is Extract<TRow, { kind: "command" }> => row.kind === "command",
  ),
);

watch(query, () => {
  activeIndex.value = 0;
});

watch(open, (isOpen) => {
  if (!isOpen) {
    return;
  }
  query.value = "";
  activeIndex.value = 0;
  pendingCommand = null;
  // The worker list fills in only after login and is otherwise fetched only
  // when the Add-tool dialog mounts; refresh it so "Add tool: <worker>" is
  // offered (the provider re-derives when it lands).
  if (providerContext.inViewer() && store.isLoggedIn) {
    propertyStore.fetchWorkerImageList();
  }
  nextTick(focusInput);
});

function focusInput() {
  inputRef.value?.focus();
}

function scrollActiveIntoView() {
  nextTick(() => {
    listRef.value?.$el
      ?.querySelector?.(".v-list-item--active")
      ?.scrollIntoView?.({ block: "nearest" });
  });
}

function moveActive(delta: number) {
  const count = commandRows.value.length;
  if (count === 0) {
    return;
  }
  activeIndex.value = (activeIndex.value + delta + count) % count;
  scrollActiveIntoView();
}

function onKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      moveActive(1);
      break;
    case "ArrowUp":
      event.preventDefault();
      moveActive(-1);
      break;
    case "Enter": {
      event.preventDefault();
      const row = commandRows.value[activeIndex.value];
      if (row) {
        choose(row.command);
      }
      break;
    }
    default:
      break;
  }
}

// Close first, run once the dialog has fully left: a command that opens a
// dialog of its own would otherwise open it while this one is still closing,
// which can leave focus or the scrim stuck.
function choose(command: ICommand) {
  pendingCommand = command;
  open.value = false;
}

async function runPendingCommand() {
  const command = pendingCommand;
  pendingCommand = null;
  if (!command) {
    return;
  }
  recordRecentCommand(command.id);
  try {
    await command.run();
  } catch (error) {
    logError(`Command "${command.id}" failed`, error);
  }
}

defineExpose({ query, rows, commandRows, activeIndex, choose });
</script>

<style lang="scss">
// Unscoped: the dialog is teleported to the overlay container.
.command-palette.v-dialog {
  align-items: flex-start;
}

.command-palette .v-overlay__content {
  margin-top: 12vh;
}
</style>

<style lang="scss" scoped>
.command-palette-list {
  max-height: min(420px, 60vh);
  overflow-y: auto;
}

.command-palette-hotkey {
  font-family: inherit;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  opacity: 0.8;
}

.command-palette-empty {
  padding: 16px;
  text-align: center;
  opacity: 0.7;
}
</style>
