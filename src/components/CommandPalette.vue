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
        :placeholder="placeholder"
        prepend-inner-icon="mdi-magnify"
        variant="solo"
        flat
        hide-details
        autocomplete="off"
        aria-label="Search commands"
        @keydown="onKeydown"
      >
        <!-- Hands the query to the Nimbus AI panel. mousedown.prevent keeps
             focus in the field (see onKeydown on why focus must stay). -->
        <template #append-inner v-if="canAskAi">
          <v-tooltip :text="`Ask Nimbus AI (${askAiHotkey})`">
            <template #activator="{ props: tooltipProps }">
              <v-btn
                v-bind="tooltipProps"
                variant="text"
                icon
                size="small"
                aria-label="Ask Nimbus AI"
                data-ask-ai
                :disabled="!query.trim()"
                @mousedown.prevent
                @click="askAi"
              >
                <v-icon>mdi-robot-outline</v-icon>
              </v-btn>
            </template>
          </v-tooltip>
        </template>
      </v-text-field>
      <v-divider />
      <v-list
        ref="listRef"
        class="command-palette-list"
        density="compact"
        role="listbox"
        tabindex="-1"
        @mousedown.prevent
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
            tabindex="-1"
            :aria-selected="row.index === activeIndex"
            @click="choose(row.command)"
            @mousemove="onRowPointerMove($event, row.command)"
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
          No matching commands<template v-if="canAskAi && query.trim()"
            >. Press {{ askAiHotkey }} to ask Nimbus AI.</template
          >
        </div>
      </v-list>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import store from "@/store";
import propertyStore from "@/store/properties";
import { logError } from "@/utils/log";
import { enabledCommands, useCommandProvider } from "@/commands/registry";
import { rankCommands } from "@/commands/scorer";
import { recentCommandIds, recordRecentCommand } from "@/commands/recent";
import {
  addToolCommands,
  layerCommands,
  propertyCommands,
  propertyFilterCommands,
  propertyListCommands,
  snapshotCommands,
  toolCommands,
} from "@/commands/providers";
import { COMMAND_GROUP_ORDER, ICommand } from "@/commands/types";
import {
  formatHotkey,
  isAskAiKey,
  isPaletteToggleKey,
} from "@/commands/hotkeys";
import { useViewerContext } from "@/commands/context";
import { paramCommandsForQuery } from "@/actions/parse";
import { aiPromptRequest } from "@/commands/requests";
import {
  EXAMPLES_SHOWN,
  examplePlaceholder,
  examplesThatRun,
  paletteExamples,
} from "@/commands/examples";

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
// The highlighted row is tracked by command, not position: the list can
// re-derive under the user (the worker list landing, an undo finishing), and
// a position would then point at a different command — or past the end.
const activeCommandId = ref<string | null>(null);
const inputRef = ref<{ focus: () => void } | null>(null);
const listRef = ref<{ $el: HTMLElement } | null>(null);
let pendingCommand: ICommand | null = null;

const providerContext = useViewerContext(() => route.name);

// The store-derived providers. Panels, tours and static actions are
// registered by the components that own them (App.vue, DataIOMenu, ...).
useCommandProvider(toolCommands(providerContext));
useCommandProvider(addToolCommands(providerContext));
useCommandProvider(layerCommands(providerContext));
useCommandProvider(snapshotCommands(providerContext));
useCommandProvider(propertyCommands(providerContext));
useCommandProvider(propertyListCommands(providerContext));
useCommandProvider(propertyFilterCommands(providerContext));

// Rotating example queries in the field's placeholder, built from the open
// dataset so each one works here, and advanced on a timer that runs only
// while the palette is open.
const EXAMPLE_ROTATE_MS = 4000;
const exampleOffset = ref(0);
let exampleTimer: ReturnType<typeof setInterval> | null = null;

// Only examples whose top result is the command they demonstrate ("show
// objects" while objects are visible would run "Only show objects passing
// filters"). Gated on `open`: the dialog keeps
// its content mounted after the first open, so without the gate this would
// re-score ~10 queries against every command on each Z/time scrub (the
// Navigator commands' enabled() reads the current position).
const examples = computed(() =>
  !open.value
    ? []
    : examplesThatRun(
        paletteExamples({
          inViewer: providerContext.inViewer(),
          isLoggedIn: store.isLoggedIn,
          zCount: store.dataset?.z.length ?? 0,
          timeCount: store.dataset?.time.length ?? 0,
          layerNames: store.layers.map((layer) => layer.name),
          // A nested value's own name ("Area"); a top-level value's path is just
          // the property id, so use the property's name.
          propertyNames: propertyStore.computedPropertyPaths.map((path) =>
            path.length > 1
              ? path[path.length - 1]
              : propertyStore.getPropertyById(path[0])?.name ?? path[0],
          ),
        }),
        // What Enter would run: a typed command first, else the top match.
        (query) =>
          (
            paramCommandsForQuery(query, providerContext)[0] ??
            rankCommands(enabledCommands.value, query, 1)[0]
          )?.id,
      ),
);

const placeholder = computed(() =>
  examplePlaceholder(examples.value, exampleOffset.value),
);

function stopExampleRotation() {
  if (exampleTimer !== null) {
    clearInterval(exampleTimer);
    exampleTimer = null;
  }
}

// A fresh set each time it opens, then the next set every few seconds.
// Immediate, so a palette mounted open rotates too.
watch(
  open,
  (isOpen) => {
    stopExampleRotation();
    if (!isOpen) {
      return;
    }
    exampleOffset.value += EXAMPLES_SHOWN;
    exampleTimer = setInterval(() => {
      exampleOffset.value += EXAMPLES_SHOWN;
    }, EXAMPLE_ROTATE_MS);
  },
  { immediate: true },
);

onBeforeUnmount(stopExampleRotation);

// App.vue's "Open/Close Nimbus AI panel" command; enabled only where the
// panel may open, so it also gates the Ask Nimbus AI button.
const AI_PANEL_ID = "ai.togglePanel";

// Grouped results, flattened into header and command rows. Command rows carry
// their position among commands only, which is what the arrow keys move over.
const rows = computed((): TRow[] => {
  const commands = enabledCommands.value;
  const sections: { key: string; label: string; commands: ICommand[] }[] = [];

  if (query.value.trim()) {
    // "z 12" / "show only dapi": commands instantiated from the query come
    // first, so Enter runs what was typed. They seed their group, so the
    // ranked matches of the same group follow under the same header.
    const byGroup = new Map<string, ICommand[]>();
    for (const command of paramCommandsForQuery(query.value, providerContext)) {
      const group = byGroup.get(command.group) ?? [];
      group.push(command);
      byGroup.set(command.group, group);
    }
    // Then groups ordered by their best match, so the top row is the top
    // result.
    for (const command of rankCommands(commands, query.value, MAX_ROWS)) {
      const group = byGroup.get(command.group) ?? [];
      group.push(command);
      byGroup.set(command.group, group);
    }
    for (const [label, groupCommands] of byGroup) {
      sections.push({ key: label, label, commands: groupCommands });
    }
  } else {
    const byId = new Map(commands.map((command) => [command.id, command]));
    const recent = recentCommandIds.value
      .map((id) => byId.get(id))
      .filter((command): command is ICommand => !!command);
    if (recent.length) {
      sections.push({ key: "Recent", label: "Recent", commands: recent });
    }
    const recentIds = new Set(recent.map((command) => command.id));
    for (const group of COMMAND_GROUP_ORDER) {
      const groupCommands = commands
        .filter(
          (command) => command.group === group && !recentIds.has(command.id),
        )
        .slice(0, OVERVIEW_PER_GROUP);
      if (groupCommands.length) {
        sections.push({ key: group, label: group, commands: groupCommands });
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
      key: `header:${section.key}`,
      label: section.label,
    });
    for (const command of section.commands.slice(0, MAX_ROWS - index)) {
      result.push({
        kind: "command",
        key: `${section.key}:${command.id}`,
        command,
        index: index++,
      });
    }
  }
  return result;
});

const canAskAi = computed(() =>
  enabledCommands.value.some((command) => command.id === AI_PANEL_ID),
);
const askAiHotkey = formatHotkey("mod+enter");

// Hand the query to the Nimbus AI panel (the field's robot button, or ⌘↵).
// Goes through choose(), so it runs after the dialog leaves like any command;
// `generated` keeps it out of the recent list.
function askAi() {
  const prompt = query.value.trim();
  if (!prompt || !canAskAi.value) {
    return;
  }
  choose({
    id: "ai.ask",
    title: `Ask Nimbus AI: "${prompt}"`,
    group: "Actions",
    generated: true,
    run: () => {
      aiPromptRequest.value = prompt;
    },
  });
}

const commandRows = computed(() =>
  rows.value.filter(
    (row): row is Extract<TRow, { kind: "command" }> => row.kind === "command",
  ),
);

// Falls back to the first row when nothing is highlighted or the highlighted
// command has left the list.
const activeIndex = computed(() =>
  Math.max(
    0,
    commandRows.value.findIndex(
      (row) => row.command.id === activeCommandId.value,
    ),
  ),
);

watch(query, () => {
  activeCommandId.value = null;
});

watch(open, (isOpen) => {
  if (!isOpen) {
    return;
  }
  // Reopened before the close transition finished: after-leave won't fire,
  // so run the command the user already chose instead of dropping it.
  runPendingCommand();
  query.value = "";
  activeCommandId.value = null;
  // The worker list fills in only after login and is otherwise fetched only
  // when the Add-tool dialog mounts; refresh it so "Add tool: <worker>" is
  // offered (the provider re-derives when it lands).
  if (providerContext.inViewer() && store.isLoggedIn) {
    propertyStore.fetchWorkerImageList().catch((error) => {
      logError("Failed to refresh the worker list", error);
    });
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
  const next = (activeIndex.value + delta + count) % count;
  activeCommandId.value = commandRows.value[next].command.id;
  scrollActiveIntoView();
}

function onKeydown(event: KeyboardEvent) {
  // Enter that confirms an IME composition (Japanese, Chinese, Korean input)
  // belongs to the composition, not to the list.
  if (event.isComposing) {
    return;
  }
  // Closing from the field is handled here and stopped, so the app-wide ⌘K
  // binding (which also fires inside inputs) doesn't toggle it straight back.
  if (isPaletteToggleKey(event)) {
    event.preventDefault();
    event.stopPropagation();
    open.value = false;
    return;
  }
  if (isAskAiKey(event)) {
    event.preventDefault();
    askAi();
    return;
  }
  switch (event.key) {
    // Focus stays in the field: app hotkeys (layer digits, tool keys,
    // ⌘⌫ delete) are muted only while a text field has focus, and they would
    // otherwise act on the viewer behind the palette. Tab is the keyboard way
    // out; the list's @mousedown.prevent closes the pointer way.
    case "Tab":
      event.preventDefault();
      break;
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

// Only a real pointer move changes the highlight. Scrolling the list under a
// resting pointer (the arrow keys do) also emits mousemove, and must not pull
// the highlight away from the keyboard's choice.
let lastPointer: { x: number; y: number } | null = null;
function onRowPointerMove(event: MouseEvent, command: ICommand) {
  if (lastPointer?.x === event.clientX && lastPointer?.y === event.clientY) {
    return;
  }
  lastPointer = { x: event.clientX, y: event.clientY };
  activeCommandId.value = command.id;
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
  // Commands generated from the query have ids that never resolve in the
  // registry; recording them would only waste recent slots.
  if (!command.generated) {
    recordRecentCommand(command.id);
  }
  try {
    await command.run();
  } catch (error) {
    logError(`Command "${command.id}" failed`, error);
  }
}

defineExpose({
  query,
  rows,
  commandRows,
  activeIndex,
  activeCommandId,
  choose,
});
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
