# Merge Nimbus Chat into the AI Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold Nimbus Chat's knowledge and persistence into the AI panel, then delete chat — leaving one Claude surface.

**Architecture:** The agent gains (1) a hybrid knowledge system — a concepts core in its cached system prompt plus per-topic `help/*.md` files fetched on demand by a new `read_help_topic` tool served from the plugin, and (2) browser-local IndexedDB persistence of the conversation, restored for the same user and wiped when a different user logs in. Then `ChatComponent.vue`, `chat.ts`, and the `claude_chat` endpoint are removed, with `getToolSuggestions` relocated out of the deleted `ChatAPI.ts`.

**Tech Stack:** Vue 3 `<script setup>`, Vuex (`vuex-module-decorators`), TypeScript, Vitest, `fake-indexeddb` (new dev dep), Girder plugin (Python), pytest/tox.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-10-merge-chat-into-ai-panel-design.md`.
- Knowledge is **reorganized, not compressed** — topic files carry the original `system_prompt_2.txt` prose essentially verbatim; drop only literal duplication and re-point "click here" UI directions.
- Persistence is **browser-local IndexedDB only**; no backend/Mongo storage. A single stored record tagged with the user id; same user restores, different user wipes.
- Do **not** persist `turnSnapshot` / `canRevert` / pending approvals.
- Backend plugin assets ship via `package_data` and require `docker compose build girder && docker compose up -d girder` to go live (restart does not reload plugin code). Tox tests run against source regardless.
- Frontend gates: `pnpm tsc`, `pnpm lint:ci`, `pnpm test`. Backend gate: `tox` from `devops/girder/plugins/girder-claude-chat`.
- Tool names in `src/agent/executors.ts` must match `agent_tools.json` exactly.
- Commit messages end with the repo's `Co-Authored-By` / `Claude-Session` trailers (see CLAUDE.md).

## File Structure

**Phase A — Knowledge**
- Create: `devops/girder/plugins/girder-claude-chat/girder_claude_chat/concepts_core.md` — concepts core folded into the cached agent prompt.
- Create: `devops/girder/plugins/girder-claude-chat/girder_claude_chat/help/*.md` — 14 topic files (near-verbatim slices of `system_prompt_2.txt`).
- Modify: `.../girder_claude_chat/__init__.py` — load concepts core + help topics, assemble the system prompt, add `GET claude_agent/help`.
- Modify: `.../girder-claude-chat/setup.py` — `package_data` gains `*.md` and `help/*.md`.
- Modify: `.../tests/test_plugin.py` — help-topic packaging + validation test.
- Modify: `.../girder_claude_chat/agent_tools.json` — add `read_help_topic` (29th tool).
- Modify: `src/store/AgentAPI.ts` — `getHelpTopic(topic)`.
- Modify: `src/agent/executors.ts` — `read_help_topic` executor + describe case.
- Modify: `src/agent/executors.test.ts` — executor tests + `agentAPI` mock.

**Phase B — Persistence**
- Create: `src/agent/conversationStore.ts` — IndexedDB single-record wrapper.
- Create: `src/agent/conversationStore.test.ts`.
- Modify: `package.json` — add `fake-indexeddb` dev dependency.
- Modify: `src/store/aiPanel.ts` — save/restore/wipe wiring; `setItems`, `clearConversationAndStorage`.
- Modify: `src/store/aiPanel.test.ts` — persistence tests (mock `conversationStore`).
- Modify: `src/components/AiPanel.vue` — clear button calls `clearConversationAndStorage`.

**Phase C — Chat removal**
- Create: `src/store/ToolSuggestionsAPI.ts` — `getToolSuggestions` (moved from `ChatAPI.ts`).
- Delete: `src/store/ChatAPI.ts`, `src/store/chat.ts`, `src/components/ChatComponent.vue`.
- Modify: `src/store/index.ts` — swap `chatAPI` → `toolSuggestionsAPI`.
- Modify: `src/store/toolSuggestions.ts` — call `main.toolSuggestionsAPI`.
- Modify: `src/App.vue` — remove chat button, `chatbotOpen`, imports, mutual-exclusion.
- Modify: `.../girder_claude_chat/__init__.py` — remove `ClaudeChatResource` + registration.
- Delete: `.../girder_claude_chat/system_prompt_2.txt`.
- Modify: `.../tests/test_plugin.py` — drop `ClaudeChatResource` tests.

---

## Task A1: Curate the prompt into concepts core + help topics

**Files:**
- Create: `devops/girder/plugins/girder-claude-chat/girder_claude_chat/concepts_core.md`
- Create: `devops/girder/plugins/girder-claude-chat/girder_claude_chat/help/<slug>.md` (14 files)
- Read (source): `.../girder_claude_chat/system_prompt_2.txt` (1487 lines)

**Interfaces:**
- Produces: a `help/` directory whose filenames (minus `.md`) are the topic slugs the backend and tool use; a `concepts_core.md` at the package root.

This task is content, not code: **copy the prose verbatim** from the source line ranges into each file. Only drop literal duplication and rewrite "click the X button" phrasings into feature descriptions where the agent now has a tool. Do **not** summarize.

- [ ] **Step 1: Create `concepts_core.md`** from `system_prompt_2.txt` lines **29–79** (the "Core Concepts" subsections: Objects, Connections, Properties, Tags, Datasets & Collections). Copy verbatim under a short heading `# NimbusImage core concepts`. Do NOT include Section 1 (lines 1–26, the chat-assistant framing) — the agent has its own role prompt.

- [ ] **Step 2: Create the 14 `help/*.md` topic files** by copying these source ranges verbatim (each file starts with the section's `#`/`##` heading):

| Slug (`help/<slug>.md`) | Source lines | Covers |
|---|---|---|
| `sharing-projects-zenodo` | 80–182 | Sharing, Projects, Zenodo publishing |
| `file-formats-and-upload` | 185–233 | Supported formats, Uploading data |
| `interface-navigation` | 234–266 | Navigating the interface, basic viewing (the kept walkthroughs) |
| `managing-files` | 267–321 | File management, upload options, storage, operations |
| `annotation-tools` | 322–488 | Manual / automated / semi-automated / selection-editing / tool creation |
| `interacting-with-objects` | 489–534 | Selection, object browser, filtering, annotation list, properties |
| `image-processing` | 535–639 | Crop, registration, histogram matching, blur, deconvolution |
| `connections` | 640–721 | Manual / automated / timelapse connections, managing |
| `analysis-and-measurement` | 722–848 | Property workers, intensity/geometric/count/distance, filtering results |
| `workflows` | 849–1019 | Cell seg, similar objects, RNA spots, 3D, tracking, point assignment |
| `visualization` | 1020–1173 | Contrast, layers, 3D volume, snapshots, exporting images |
| `import-export` | 1174–1236 | Export CSV/JSON, importing annotations, ownership |
| `advanced-features` | 1237–1350 | Batch processing, custom workflows, retraining, external tools |
| `troubleshooting` | 1351–1487 | Performance, import problems, accuracy, errors, recovery |

- [ ] **Step 3: Verify coverage.** Every source line 27–1487 lands in exactly one file (lines 1–26 intentionally dropped). Run this check:

```bash
cd devops/girder/plugins/girder-claude-chat/girder_claude_chat
echo "concepts_core.md words:"; wc -w concepts_core.md
echo "help topic count (expect 14):"; ls help/*.md | wc -l
echo "total help words (should be within ~10% of source sections):"; cat help/*.md | wc -w
wc -w system_prompt_2.txt
```
Expected: 14 help files; combined help + concepts word count within ~10% of the source's 10,503 words (confirms we split rather than compressed).

- [ ] **Step 4: Commit**

```bash
git add devops/girder/plugins/girder-claude-chat/girder_claude_chat/concepts_core.md \
        devops/girder/plugins/girder-claude-chat/girder_claude_chat/help/
git commit -m "Split chat knowledge base into concepts core + help topics"
```

---

## Task A2: Backend — load knowledge, assemble prompt, serve topics

**Files:**
- Modify: `devops/girder/plugins/girder-claude-chat/girder_claude_chat/__init__.py`
- Modify: `devops/girder/plugins/girder-claude-chat/setup.py`
- Test: `devops/girder/plugins/girder-claude-chat/tests/test_plugin.py`

**Interfaces:**
- Consumes: `concepts_core.md` and `help/*.md` from Task A1.
- Produces: `ClaudeAgentResource.help_topics: dict[str, str]`; `ClaudeAgentResource.get_help_topic_markdown(topic) -> str` (raises `RestException(400)` on unknown); a `GET /api/v1/claude_agent/help?topic=<slug>` route returning `{'topic', 'markdown'}`; the concepts core + topic index folded into `self.system_prompt`.

- [ ] **Step 1: Write the failing test** in `tests/test_plugin.py` (append):

```python
@pytest.mark.plugin('girder_claude_chat')
def testAgentHelpTopicsPackagedAndValidated(monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'FAKE_API_KEY')
    resource = ClaudeAgentResource()
    # Help topics ship inside the package and load.
    assert resource.help_topics, 'help topics not packaged'
    # The concepts core is folded into the cached system prompt.
    assert 'object' in resource.system_prompt.lower()
    # The topic index lists slugs so the model can choose one.
    a_slug = sorted(resource.help_topics)[0]
    assert a_slug in resource.system_prompt
    # A known topic returns markdown; unknown/garbage 400s.
    assert resource.get_help_topic_markdown(a_slug)
    with pytest.raises(RestException) as excinfo:
        resource.get_help_topic_markdown('does-not-exist')
    assert excinfo.value.code == 400
    with pytest.raises(RestException):
        resource.get_help_topic_markdown(123)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd devops/girder/plugins/girder-claude-chat && tox -e py -- tests/test_plugin.py::testAgentHelpTopicsPackagedAndValidated`
Expected: FAIL — `AttributeError: 'ClaudeAgentResource' object has no attribute 'help_topics'`.

- [ ] **Step 3: Add module-level paths** in `__init__.py`, next to `AGENT_TOOLS_PATH`:

```python
CONCEPTS_CORE_PATH = os.path.join(PACKAGE_DIR, 'concepts_core.md')
HELP_DIR = os.path.join(PACKAGE_DIR, 'help')
```

- [ ] **Step 4: Load knowledge in `ClaudeAgentResource.__init__`.** Replace the existing agent-system-prompt load block:

```python
        try:
            with open(AGENT_PROMPT_PATH, 'r') as f:
                self.system_prompt = f.read().strip()
            logger.info('Successfully loaded agent system prompt')
        except IOError:
            logger.error('Failed to load agent system prompt')
            self.system_prompt = ''
```

with:

```python
        self.help_topics = self._load_help_topics()
        self.system_prompt = self._assemble_system_prompt()
```

- [ ] **Step 5: Add the loader/assembler/validator methods** to `ClaudeAgentResource` (above `_check_rate_limit`):

```python
    def _read_text(self, path):
        try:
            with open(path, 'r') as f:
                return f.read().strip()
        except IOError:
            logger.error('Failed to read %s', path)
            return ''

    def _load_help_topics(self):
        """Load help/<slug>.md into a {slug: markdown} dict."""
        topics = {}
        if not os.path.isdir(HELP_DIR):
            logger.error('Help topic directory missing: %s', HELP_DIR)
            return topics
        for name in sorted(os.listdir(HELP_DIR)):
            if name.endswith('.md'):
                topics[name[:-3]] = self._read_text(
                    os.path.join(HELP_DIR, name)
                )
        logger.info('Loaded %d help topics', len(topics))
        return topics

    def _assemble_system_prompt(self):
        """Base agent prompt + concepts core + on-demand topic index."""
        base = self._read_text(AGENT_PROMPT_PATH)
        concepts = self._read_text(CONCEPTS_CORE_PATH)
        index = ''
        if self.help_topics:
            slugs = '\n'.join(
                '- ' + slug for slug in sorted(self.help_topics)
            )
            index = (
                'When you need deeper detail on how a NimbusImage feature '
                'works, or how the user can do something themselves in the '
                'UI, call read_help_topic with one of these topics:\n' + slugs
            )
        return '\n\n'.join(part for part in [base, concepts, index] if part)

    def get_help_topic_markdown(self, topic):
        """Return a topic's markdown, or raise RestException(400)."""
        if not isinstance(topic, str) or topic not in self.help_topics:
            raise RestException(
                'Unknown help topic. Available: '
                + ', '.join(sorted(self.help_topics)),
                code=400,
            )
        return self.help_topics[topic]
```

- [ ] **Step 6: Register the route** in `ClaudeAgentResource.__init__`, after the existing `self.route('POST', (), self.agent_message)`:

```python
        self.route('GET', ('help',), self.get_help_topic)
```

- [ ] **Step 7: Add the route handler** (below `agent_message`):

```python
    @access.user
    @autoDescribeRoute(
        Description('Fetch a NimbusImage help topic as markdown.')
        .param('topic', 'Help topic slug', required=True)
    )
    def get_help_topic(self, topic):
        return {
            'topic': topic,
            'markdown': self.get_help_topic_markdown(topic),
        }
```

- [ ] **Step 8: Ship the markdown** — in `setup.py`, change the `package_data` line:

```python
    package_data={'girder_claude_chat': ['*.txt', '*.json']},
```

to:

```python
    package_data={
        'girder_claude_chat': ['*.txt', '*.json', '*.md', 'help/*.md'],
    },
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd devops/girder/plugins/girder-claude-chat && tox -r -e py -- tests/test_plugin.py::testAgentHelpTopicsPackagedAndValidated`
(`-r` recreates the env so the sdist re-includes the new package data.)
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add devops/girder/plugins/girder-claude-chat/girder_claude_chat/__init__.py \
        devops/girder/plugins/girder-claude-chat/setup.py \
        devops/girder/plugins/girder-claude-chat/tests/test_plugin.py
git commit -m "Serve help topics and fold concepts core into the agent prompt"
```

---

## Task A3: Frontend — `read_help_topic` tool

**Files:**
- Modify: `devops/girder/plugins/girder-claude-chat/girder_claude_chat/agent_tools.json`
- Modify: `src/store/AgentAPI.ts`
- Modify: `src/agent/executors.ts`
- Test: `src/agent/executors.test.ts`

**Interfaces:**
- Consumes: `GET claude_agent/help?topic=` from Task A2.
- Produces: `AgentAPI.getHelpTopic(topic: string): Promise<string>`; a `read_help_topic` registry executor returning `{ topic, markdown }`.

- [ ] **Step 1: Add the tool schema** — append this object as the **last** element of the array in `agent_tools.json` (the backend puts the cache breakpoint on the last tool, so order matters — last is correct):

```json
{
  "name": "read_help_topic",
  "description": "Read NimbusImage documentation on a topic — how a feature works, or how the user can do something themselves in the UI. Call this before explaining a workflow you are unsure about. The available topic slugs are listed in the system prompt.",
  "input_schema": {
    "type": "object",
    "properties": {
      "topic": {
        "type": "string",
        "description": "The topic slug to read (e.g. \"workflows\", \"image-processing\"). Must be one of the slugs listed in the system prompt."
      }
    },
    "required": ["topic"]
  }
}
```

- [ ] **Step 2: Add the API method** in `src/store/AgentAPI.ts` (inside `class AgentAPI`, after `postAgentMessage`):

```typescript
  async getHelpTopic(topic: string): Promise<string> {
    const { data } = await this.client.get("claude_agent/help", {
      params: { topic },
    });
    if (!data || typeof data.markdown !== "string") {
      throw new Error(`No help topic "${topic}"`);
    }
    return data.markdown;
  }
```

- [ ] **Step 3: Write the failing executor tests** in `src/agent/executors.test.ts`. First add `agentAPI` to the `@/store` mock (in the `default: {` object): add `agentAPI: { getHelpTopic: vi.fn() },`. Then append a describe block:

```typescript
describe("read_help_topic", () => {
  it("returns a topic's markdown", async () => {
    mockMain.agentAPI = {
      getHelpTopic: vi.fn(async () => "# Workflows\nStep one…"),
    };
    const { result } = await executeAgentTool(
      "read_help_topic",
      { topic: "workflows" },
      context,
    );
    expect(mockMain.agentAPI.getHelpTopic).toHaveBeenCalledWith("workflows");
    expect(result.topic).toBe("workflows");
    expect(result.markdown).toContain("Workflows");
  });

  it("requires a topic string", async () => {
    await expect(
      executeAgentTool("read_help_topic", {}, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});
```

Also add `"read_help_topic"` to the `toolNames` array in the `describeAgentToolCall` describe block (so the never-throws test covers it).

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run src/agent/executors.test.ts -t "read_help_topic"`
Expected: FAIL — `Unknown tool "read_help_topic"`.

- [ ] **Step 5: Add the executor** in `src/agent/executors.ts`, in the `registry` object (place it near `get_interface_state`, alphabetically-ish among the read tools):

```typescript
  read_help_topic: {
    execute: async (input: { topic?: string }) => {
      if (typeof input.topic !== "string" || !input.topic) {
        throw new ToolExecutionError("topic is required");
      }
      const markdown = await main.agentAPI.getHelpTopic(input.topic);
      return { result: { topic: input.topic, markdown } };
    },
  },
```

- [ ] **Step 6: Add a describe case** in `describeAgentToolCall`, before `default:`:

```typescript
    case "read_help_topic":
      return `Read help on "${input?.topic ?? ""}"`;
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/agent/executors.test.ts`
Expected: PASS (all, including the two new ones).

- [ ] **Step 8: Typecheck + lint + commit**

```bash
pnpm tsc
npx eslint src/store/AgentAPI.ts src/agent/executors.ts src/agent/executors.test.ts --max-warnings 0
git add src/store/AgentAPI.ts src/agent/executors.ts src/agent/executors.test.ts \
        devops/girder/plugins/girder-claude-chat/girder_claude_chat/agent_tools.json
git commit -m "Add read_help_topic agent tool"
```

---

## Task B1: `conversationStore.ts` — IndexedDB persistence

**Files:**
- Create: `src/agent/conversationStore.ts`
- Test: `src/agent/conversationStore.test.ts`
- Modify: `package.json` (dev dependency)

**Interfaces:**
- Produces:
  - `interface IStoredAgentConversation { userId: string; items: IAgentPanelItem[]; wireMessages: IAgentWireMessage[]; updatedAt: number; }`
  - `loadStoredConversation(): Promise<IStoredAgentConversation | null>`
  - `saveStoredConversation(record: IStoredAgentConversation): Promise<void>`
  - `clearStoredConversation(): Promise<void>`

- [ ] **Step 1: Add the test dependency**

Run: `pnpm add -D fake-indexeddb`

- [ ] **Step 2: Write the failing test** `src/agent/conversationStore.test.ts`:

```typescript
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadStoredConversation,
  saveStoredConversation,
  clearStoredConversation,
} from "./conversationStore";

beforeEach(async () => {
  await clearStoredConversation();
});

const record = {
  userId: "userA",
  items: [{ kind: "user" as const, text: "hi" }],
  wireMessages: [{ role: "user" as const, content: [] }],
  updatedAt: 1,
};

describe("conversationStore", () => {
  it("returns null when nothing is stored", async () => {
    expect(await loadStoredConversation()).toBeNull();
  });

  it("round-trips a saved conversation", async () => {
    await saveStoredConversation(record);
    const loaded = await loadStoredConversation();
    expect(loaded?.userId).toBe("userA");
    expect(loaded?.items[0].text).toBe("hi");
  });

  it("keeps only the latest record (single slot)", async () => {
    await saveStoredConversation(record);
    await saveStoredConversation({ ...record, userId: "userB" });
    expect((await loadStoredConversation())?.userId).toBe("userB");
  });

  it("clears the stored conversation", async () => {
    await saveStoredConversation(record);
    await clearStoredConversation();
    expect(await loadStoredConversation()).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/agent/conversationStore.test.ts`
Expected: FAIL — cannot resolve `./conversationStore`.

- [ ] **Step 4: Implement** `src/agent/conversationStore.ts`:

```typescript
import type { IAgentPanelItem } from "@/store/aiPanel";
import type { IAgentWireMessage } from "@/store/AgentAPI";
import { logError } from "@/utils/log";

// Browser-local persistence for the AI-panel conversation. A single stored
// record (one slot), tagged with the owning user id — the aiPanel store
// restores it for the same user and wipes it for a different one. No Vuex
// reactivity: IndexedDB's structured clone can't handle Vue proxies.
// Durable server-side storage is deliberately out of scope (see the spec).

const DB_NAME = "AgentConversationDB";
const STORE_NAME = "conversation";
const RECORD_KEY = "current";

export interface IStoredAgentConversation {
  userId: string;
  items: IAgentPanelItem[];
  wireMessages: IAgentWireMessage[];
  updatedAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadStoredConversation(): Promise<IStoredAgentConversation | null> {
  try {
    const db = await openDatabase();
    const store = db
      .transaction([STORE_NAME], "readonly")
      .objectStore(STORE_NAME);
    const result = await requestToPromise(store.get(RECORD_KEY));
    return (result as IStoredAgentConversation) ?? null;
  } catch (error) {
    logError("Failed to load stored agent conversation:", error);
    return null;
  }
}

export async function saveStoredConversation(
  record: IStoredAgentConversation,
): Promise<void> {
  try {
    const db = await openDatabase();
    const store = db
      .transaction([STORE_NAME], "readwrite")
      .objectStore(STORE_NAME);
    // Strip Vue reactive proxies — structured clone rejects them.
    const plain = JSON.parse(JSON.stringify(record));
    await requestToPromise(store.put(plain, RECORD_KEY));
  } catch (error) {
    logError("Failed to save agent conversation:", error);
  }
}

export async function clearStoredConversation(): Promise<void> {
  try {
    const db = await openDatabase();
    const store = db
      .transaction([STORE_NAME], "readwrite")
      .objectStore(STORE_NAME);
    await requestToPromise(store.delete(RECORD_KEY));
  } catch (error) {
    logError("Failed to clear agent conversation:", error);
  }
}
```

- [ ] **Step 5: Run to verify passing**

Run: `npx vitest run src/agent/conversationStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm tsc
git add package.json pnpm-lock.yaml src/agent/conversationStore.ts src/agent/conversationStore.test.ts
git commit -m "Add IndexedDB conversation store for the AI panel"
```

---

## Task B2: Wire persistence into `aiPanel.ts`

**Files:**
- Modify: `src/store/aiPanel.ts`
- Modify: `src/components/AiPanel.vue`
- Test: `src/store/aiPanel.test.ts`

**Interfaces:**
- Consumes: `loadStoredConversation` / `saveStoredConversation` / `clearStoredConversation` (Task B1), `pruneOldScreenshots` (existing).
- Produces: `AiPanel.setItems(items)`, `AiPanel.clearConversationAndStorage()`; `handleAuthenticatedUserChange` and `sendUserMessage` become persistence-aware.

- [ ] **Step 1: Write the failing tests** in `src/store/aiPanel.test.ts`. Add a `conversationStore` mock near the other `vi.mock` calls:

```typescript
vi.mock("@/agent/conversationStore", () => ({
  loadStoredConversation: vi.fn(async () => null),
  saveStoredConversation: vi.fn(async () => {}),
  clearStoredConversation: vi.fn(async () => {}),
}));
```

Import the mocks under the existing imports:

```typescript
import {
  loadStoredConversation,
  saveStoredConversation,
  clearStoredConversation,
} from "@/agent/conversationStore";
const mockLoad = loadStoredConversation as any;
const mockSave = saveStoredConversation as any;
const mockClearStore = clearStoredConversation as any;
```

Append a describe block:

```typescript
describe("AI panel persistence", () => {
  it("saves the conversation after a completed turn", async () => {
    aiPanel.handleAuthenticatedUserChange("userA");
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
    aiPanel.handleAuthenticatedUserChange("userA");
    await aiPanel.sendUserMessage("something");
    await aiPanel.clearConversationAndStorage();
    expect(mockClearStore).toHaveBeenCalled();
    expect(aiPanel.items).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/store/aiPanel.test.ts -t "persistence"`
Expected: FAIL — `clearConversationAndStorage` is not a function / saves not called.

- [ ] **Step 3: Import the store helpers** at the top of `src/store/aiPanel.ts` (after the `wireConversation` import):

```typescript
import {
  clearStoredConversation,
  loadStoredConversation,
  saveStoredConversation,
} from "@/agent/conversationStore";
```

- [ ] **Step 4: Add a `setItems` mutation** to the `AiPanel` class (next to `clearItemsImpl`):

```typescript
  @Mutation
  private setItems(items: IAgentPanelItem[]) {
    this.items = items;
  }
```

- [ ] **Step 5: Make `handleAuthenticatedUserChange` restore/wipe.** Replace the existing action body:

```typescript
  @Action
  handleAuthenticatedUserChange(userId: string | null) {
    if (userId === lastKnownUserId) {
      return;
    }
    lastKnownUserId = userId;
    this.clearConversation(true);
  }
```

with:

```typescript
  @Action
  async handleAuthenticatedUserChange(userId: string | null) {
    if (userId === lastKnownUserId) {
      return;
    }
    lastKnownUserId = userId;
    // Drop the in-memory conversation (also stops any in-flight run).
    this.clearConversation(true);
    if (!userId) {
      await clearStoredConversation();
      return;
    }
    const stored = await loadStoredConversation();
    if (stored && stored.userId === userId) {
      // Same user (e.g. a page reload): rehydrate the conversation.
      wireMessages = stored.wireMessages;
      this.setItems(stored.items);
    } else {
      // A different user's conversation must never surface here.
      await clearStoredConversation();
    }
  }
```

- [ ] **Step 6: Add the store-clearing action** (below `clearConversation`):

```typescript
  // The explicit "clear" button: wipe both memory and persistence.
  @Action
  async clearConversationAndStorage() {
    this.clearConversation();
    await clearStoredConversation();
  }
```

- [ ] **Step 7: Persist after each turn.** In `sendUserMessage`, replace the `finally` block:

```typescript
    } finally {
      this.setRunning(false);
      this.setStopRequested(false);
    }
```

with:

```typescript
    } finally {
      this.setRunning(false);
      this.setStopRequested(false);
      // Persist only if this turn's conversation is still the active one
      // (not cleared or switched to another user mid-run).
      if (conversationGeneration === generationAtStart && lastKnownUserId) {
        // Drop screenshots before writing — same treatment they get at the
        // start of the next turn, so base64 blobs never hit disk.
        pruneOldScreenshots(wireMessages);
        await saveStoredConversation({
          userId: lastKnownUserId,
          items: [...this.items],
          wireMessages,
          updatedAt: Date.now(),
        });
      }
    }
```

- [ ] **Step 8: Point the clear button at the new action** in `src/components/AiPanel.vue` — change:

```html
            @click="aiPanelStore.clearConversation()"
```

to:

```html
            @click="aiPanelStore.clearConversationAndStorage()"
```

- [ ] **Step 9: Run tests to verify passing**

Run: `npx vitest run src/store/aiPanel.test.ts`
Expected: PASS (all, incl. the 4 persistence tests and the pre-existing isolation/binding tests).

- [ ] **Step 10: Typecheck + lint + commit**

```bash
pnpm tsc
npx eslint src/store/aiPanel.ts src/store/aiPanel.test.ts src/components/AiPanel.vue --max-warnings 0
git add src/store/aiPanel.ts src/store/aiPanel.test.ts src/components/AiPanel.vue
git commit -m "Persist the AI-panel conversation per user via IndexedDB"
```

---

## Task C1: Relocate `getToolSuggestions`, delete `ChatAPI.ts`

**Files:**
- Create: `src/store/ToolSuggestionsAPI.ts`
- Delete: `src/store/ChatAPI.ts`
- Modify: `src/store/index.ts`, `src/store/toolSuggestions.ts`

**Interfaces:**
- Produces: `ToolSuggestionsAPI` with `getToolSuggestions(params)` (identical signature to the current `ChatAPI.getToolSuggestions`); `main.toolSuggestionsAPI`.

- [ ] **Step 1: Create `src/store/ToolSuggestionsAPI.ts`** by moving the `getToolSuggestions` method and the imports/helpers it needs out of `ChatAPI.ts`:

```typescript
import { RestClientInstance } from "@/girder";
import {
  IToolSuggestion,
  IToolSuggestionCatalogEntry,
  IToolSuggestionLayerContext,
} from "./model";

function errorFromResponse(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : fallbackMessage);
}

// Auto tool-suggestion for a freshly opened dataset. Formerly part of ChatAPI;
// split out so it survives the removal of the chat feature.
export default class ToolSuggestionsAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  async getToolSuggestions(params: {
    images: { media_type: string; data: string }[];
    catalog: IToolSuggestionCatalogEntry[];
    channels: string[];
    layers: IToolSuggestionLayerContext[];
  }): Promise<IToolSuggestion[]> {
    const response = await this.client.post("claude_suggest_tools", params);
    const { data } = response;
    if (!data) {
      return [];
    }
    if ("error" in data) {
      throw errorFromResponse(data.error, "Claude tool suggestion failed.");
    }
    return data.suggestions ?? [];
  }
}
```

- [ ] **Step 2: Swap the API in `src/store/index.ts`.** Change the import:

```typescript
import ChatAPI from "./ChatAPI";
```

to:

```typescript
import ToolSuggestionsAPI from "./ToolSuggestionsAPI";
```

and the instantiation:

```typescript
  chatAPI = new ChatAPI(this.girderRestProxy);
```

to:

```typescript
  toolSuggestionsAPI = new ToolSuggestionsAPI(this.girderRestProxy);
```

- [ ] **Step 3: Update the caller** in `src/store/toolSuggestions.ts` — change `main.chatAPI.getToolSuggestions(` to `main.toolSuggestionsAPI.getToolSuggestions(`.

- [ ] **Step 4: Delete the old API**

```bash
git rm src/store/ChatAPI.ts
```

- [ ] **Step 5: Verify no dangling references**

Run: `grep -rn "chatAPI\|ChatAPI" src/ | grep -v "\.test\."`
Expected: no output (nothing references the removed symbol).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm tsc
git add src/store/ToolSuggestionsAPI.ts src/store/index.ts src/store/toolSuggestions.ts
git commit -m "Move getToolSuggestions to ToolSuggestionsAPI; drop ChatAPI"
```

---

## Task C2: Delete the chat component and store, clean up `App.vue`

**Files:**
- Delete: `src/components/ChatComponent.vue`, `src/store/chat.ts`
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: nothing new. Removes `chatbotOpen` and the chat button; the AI panel is the sole surface. `toggleAiPanel` no longer needs to close a chat panel.

- [ ] **Step 1: Delete the files**

```bash
git rm src/components/ChatComponent.vue src/store/chat.ts
```

- [ ] **Step 2: Remove the chat button** in `src/App.vue` — delete the `v-tooltip` block whose button has `@click="toggleChatbot"` (the `mdi-chat` icon button), and delete the `<chat-component v-if="chatbotOpen" @close="chatbotOpen = false" />` element.

- [ ] **Step 3: Remove chat imports/wiring** in `src/App.vue`:
  - Delete `import ChatComponent from "@/components/ChatComponent.vue";`
  - Delete `void ChatComponent;`
  - Delete `const chatbotOpen = ref(false);`
  - Delete the `function toggleChatbot() { … }` block.
  - In `toggleAiPanel`, delete the `chatbotOpen.value = false;` line (nothing to close now):

```typescript
function toggleAiPanel() {
  if (!canUseAiPanel.value) {
    return;
  }
  aiPanelOpen.value = !aiPanelOpen.value;
}
```

  - In the `defineExpose({ … })` object, delete the `chatbotOpen,` entry.

- [ ] **Step 4: Verify no dangling references**

Run: `grep -rn "chatbotOpen\|toggleChatbot\|ChatComponent\|@/store/chat\b\|chatStore" src/`
Expected: no output.

- [ ] **Step 5: Typecheck, lint, test, commit**

```bash
pnpm tsc
npx eslint src/App.vue --max-warnings 0
npx vitest run
git add src/App.vue
git commit -m "Remove Nimbus Chat component and store; AI panel is the sole surface"
```

---

## Task C3: Remove the `claude_chat` backend endpoint

**Files:**
- Modify: `devops/girder/plugins/girder-claude-chat/girder_claude_chat/__init__.py`
- Delete: `devops/girder/plugins/girder-claude-chat/girder_claude_chat/system_prompt_2.txt`
- Modify: `devops/girder/plugins/girder-claude-chat/tests/test_plugin.py`

**Interfaces:**
- Removes `ClaudeChatResource` and the `claude_chat` route. `ClaudeAgentResource` and `ClaudeSuggestToolsResource` are unchanged; `_make_anthropic_client` / `_list_param` stay.

- [ ] **Step 1: Delete the `ClaudeChatResource` class** in `__init__.py` — the entire `class ClaudeChatResource(Resource): …` block (its `__init__`, `query_claude`, `query_claude_imp`).

- [ ] **Step 2: Remove its registration** in `GirderClaudeChatPlugin.load` — delete:

```python
        info['apiRoot'].claude_chat = ClaudeChatResource()
```

- [ ] **Step 3: Remove the now-unused system-prompt path** — delete the `SYSTEM_PROMPT_PATH = os.path.join(PACKAGE_DIR, 'system_prompt_2.txt')` assignment and its comment block (the chat endpoint was its only consumer; `_read_text`/agent prompt use `AGENT_PROMPT_PATH`). Confirm with `grep -n SYSTEM_PROMPT_PATH __init__.py` → no remaining refs.

- [ ] **Step 4: Delete the prompt file**

```bash
git rm devops/girder/plugins/girder-claude-chat/girder_claude_chat/system_prompt_2.txt
```

- [ ] **Step 5: Update tests** in `tests/test_plugin.py`:
  - Remove `ClaudeChatResource` from the `from girder_claude_chat import (…)` line.
  - Delete the three chat tests: `testClaudeChatImplementation`, `testClaudeChatMissingApiKey`, `testClaudeChatUsesSonnet5AndCollectsTextBlocks`.

- [ ] **Step 6: Run the backend suite**

Run: `cd devops/girder/plugins/girder-claude-chat && tox -r`
Expected: PASS (agent + suggest + rate-limit + help-topic tests; no chat tests; flake8 clean).

- [ ] **Step 7: Commit**

```bash
git add devops/girder/plugins/girder-claude-chat/girder_claude_chat/__init__.py \
        devops/girder/plugins/girder-claude-chat/tests/test_plugin.py
git commit -m "Remove the claude_chat endpoint and its system prompt"
```

---

## Final verification (all phases)

- [ ] **Frontend gates**

Run: `pnpm tsc && pnpm lint:ci && pnpm test`
Expected: clean (ignore any failures under `.tox/**` — vitest glob artifact).

- [ ] **Backend gate + live rebuild**

Run: `cd devops/girder/plugins/girder-claude-chat && tox -r`
Then, to exercise it live: `docker compose build girder && docker compose up -d girder` (restart alone does not reload plugin code).

- [ ] **Live smoke test** (see the in-browser-testing skill): open the AI panel, ask "how do I count RNA spots?" and confirm the agent calls `read_help_topic` and answers from the topic; reload the page and confirm the conversation is restored; verify the chat button is gone and the auto tool-suggestion flow still works.

---

## Self-review notes

- **Spec coverage:** knowledge hybrid (A1–A3), walkthroughs kept as `interface-navigation` (A1), backend package for topics (A2, setup.py), persist both transcript + wire (B2), screenshots pruned before write (B2 step 7), snapshot/revert not persisted (unchanged — B2 touches neither), single-record wipe-on-different-user (B2 steps 5), backend-DB deferral (no task — correct), chat removal + `getToolSuggestions` relocation (C1–C3). All covered.
- **Naming consistency:** `getHelpTopic` (AgentAPI) ↔ `read_help_topic` (tool/executor) ↔ `get_help_topic` / `get_help_topic_markdown` (backend) are intentionally distinct layers; `loadStoredConversation`/`saveStoredConversation`/`clearStoredConversation` used identically in B1 and B2; `clearConversationAndStorage` defined in B2 step 6 and referenced in B2 step 8.
- **Ordering:** Phase A and B are independent; Phase C must come last (C1 before C2/C3 so `toolSuggestionsAPI` exists before `ChatAPI` is deleted).
