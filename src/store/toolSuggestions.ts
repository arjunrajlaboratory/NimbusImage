import {
  VuexModule,
  Module,
  Mutation,
  Action,
  getModule,
} from "vuex-module-decorators";
import { logError } from "@/utils/log";
import store from "./root";
import main from "./index";
import properties from "./properties";
import persister from "./Persister";
import {
  IResolvedToolSuggestion,
  IToolSuggestion,
  IToolSuggestionLayerContext,
  TToolSuggestionStatus,
} from "./model";
import {
  buildCatalog,
  buildToolConfiguration,
} from "@/tools/creation/toolFromCatalog";
import {
  captureInterfaceScreenshot,
  captureViewportScreenshot,
  dataUrlToBase64,
} from "@/utils/interfaceCapture";

// Feature flag. The whole flow is a first pass (see
// codebaseDocumentation/AUTO_TOOL_SUGGESTIONS.md); keep it easy to disable
// while it is being refined.
const AUTO_SUGGEST_ENABLED = true;
const TOOL_SUGGESTIONS_PANEL_SELECTOR = "[data-tool-suggestions-panel]";

// Auto-suggest fires once per collection, the first time it is opened with no
// tools. We remember the collections we've already suggested for in
// localStorage so reopening or reloading (in any later session) never
// re-triggers the flow. Creation time is deliberately NOT used: with batch
// uploads the collection is created up front but its first viewer open can come
// many minutes later, so an age-based gate would wrongly expire before that
// first open.
const SUGGESTED_CONFIG_IDS_STORAGE_KEY = "toolSuggestions.suggestedConfigIds";
// Keep only the most recently suggested-for collections so the list can't grow
// unbounded for power users. 500 ids is ~14 KB and, in practice, larger than
// any single user's collection count — so eviction (which would let an evicted,
// still-toolless collection re-suggest on reopen) effectively never happens.
const MAX_REMEMBERED_SUGGESTED_CONFIGS = 500;

// The persisted "already suggested" set. Backed directly by localStorage rather
// than mirrored in Vuex state: it's not rendered anywhere, and localStorage is
// the single source of truth across sessions.
function getSuggestedConfigurationIds(): string[] {
  return persister.get<string[]>(SUGGESTED_CONFIG_IDS_STORAGE_KEY, []);
}

// Record that we've completed suggestions for a collection. Moves an existing
// id to most-recent, then trims oldest so the list stays within the cap.
function rememberSuggestedConfigurationId(configurationId: string): void {
  const ids = getSuggestedConfigurationIds().filter(
    (id) => id !== configurationId,
  );
  ids.push(configurationId);
  persister.set(
    SUGGESTED_CONFIG_IDS_STORAGE_KEY,
    ids.slice(-MAX_REMEMBERED_SUGGESTED_CONFIGS),
  );
}

function getToolSuggestionsPanel(): HTMLElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  return document.querySelector(TOOL_SUGGESTIONS_PANEL_SELECTOR);
}

function buildLayerContext(): IToolSuggestionLayerContext[] {
  const dataset = main.dataset;
  if (!dataset) {
    return [];
  }
  return main.layers.map((layer) => ({
    id: layer.id,
    name: layer.name,
    channel: layer.channel,
    channelName:
      dataset.channelNames.get(layer.channel) || `Channel ${layer.channel}`,
    color: layer.color,
    visible: layer.visible,
  }));
}

@Module({ dynamic: true, store, name: "toolSuggestions" })
export class ToolSuggestions extends VuexModule {
  status: TToolSuggestionStatus = "idle";
  suggestions: IResolvedToolSuggestion[] = [];
  errorMessage: string | null = null;
  // Configuration ids we have already run suggestions for, so opening the same
  // collection twice in one session doesn't re-prompt. Cross-session
  // de-duplication lives in localStorage (see the suggested-config helpers).
  seenConfigurationIds: string[] = [];
  dismissed: boolean = false;

  @Mutation
  private setStatus(status: TToolSuggestionStatus) {
    this.status = status;
  }

  @Mutation
  private setSuggestions(suggestions: IResolvedToolSuggestion[]) {
    this.suggestions = suggestions;
  }

  @Mutation
  private setErrorMessage(message: string | null) {
    this.errorMessage = message;
  }

  @Mutation
  private markConfigurationSeen(configurationId: string) {
    if (!this.seenConfigurationIds.includes(configurationId)) {
      this.seenConfigurationIds.push(configurationId);
    }
  }

  @Mutation
  private unmarkConfigurationSeen(configurationId: string) {
    this.seenConfigurationIds = this.seenConfigurationIds.filter(
      (id) => id !== configurationId,
    );
  }

  @Mutation
  setDismissed(value: boolean) {
    this.dismissed = value;
  }

  @Mutation
  removeSuggestionByToolId(toolId: string) {
    this.suggestions = this.suggestions.filter((s) => s.tool.id !== toolId);
  }

  @Action
  clear() {
    this.setSuggestions([]);
    this.setStatus("idle");
    this.setErrorMessage(null);
    this.setDismissed(false);
  }

  // Run suggestions for the current configuration the first time it is opened
  // with no tools: it exists, has no tools yet, we have never completed
  // suggestions for it (persisted across sessions), and we haven't already
  // started suggesting for it this session. Safe to call on every configuration
  // change.
  @Action
  async maybeSuggestForCurrentConfiguration() {
    if (!AUTO_SUGGEST_ENABLED) {
      return;
    }
    const configuration = main.configuration;
    if (!configuration || !main.dataset) {
      return;
    }
    if (configuration.tools.length > 0) {
      return;
    }
    // Already suggested for this collection in some session — never re-prompt.
    if (getSuggestedConfigurationIds().includes(configuration.id)) {
      return;
    }
    if (this.seenConfigurationIds.includes(configuration.id)) {
      return;
    }
    // A completed run is persisted permanently, so only run once everything a
    // *complete* suggestion needs is ready — otherwise a startup race would
    // persist a degraded result and suppress the real suggestions forever.
    // Both preconditions below are populated asynchronously at startup and can
    // lose the race with the first layers-ready; bailing here (without marking
    // or persisting) lets a later open retry once they're ready.
    //   - isLoggedIn: fetchWorkerImageList() early-returns when not logged in
    //     (properties.ts), so the catalog would lack Cellpose/Piscis/etc. and
    //     we'd offer only the manual blob. (A stored token authenticates the
    //     request before main.initialize() flips isLoggedIn, so the run can
    //     otherwise succeed in this state.)
    //   - toolTemplateList: loaded by App.vue fetchConfig(); without it
    //     buildToolConfiguration() can't resolve any backend suggestion into a
    //     tool. A non-empty list means the create/segmentation templates exist.
    if (!main.isLoggedIn || main.toolTemplateList.length === 0) {
      return;
    }
    // Mark seen before the async call so a second layers-ready doesn't kick
    // off a duplicate request. If the request fails, un-mark it so a later
    // layers-ready can retry.
    this.markConfigurationSeen(configuration.id);
    await this.suggestForCurrentConfiguration();
    if (this.status === "error") {
      this.unmarkConfigurationSeen(configuration.id);
    } else if (this.status === "done") {
      // The flow ran to completion (even with zero suggestions) — persist so it
      // never runs again for this collection in any future session.
      rememberSuggestedConfigurationId(configuration.id);
    }
  }

  // Capture screenshots, ask the backend, and resolve suggestions into
  // ready-to-add tool configurations.
  @Action
  async suggestForCurrentConfiguration() {
    if (!main.dataset) {
      return;
    }
    // Remember which configuration this run is for, so we can discard the
    // result if the user navigates to a different collection mid-request.
    const startConfigurationId = main.configuration?.id ?? null;
    this.setDismissed(false);
    this.setErrorMessage(null);
    this.setStatus("loading");
    this.setSuggestions([]);
    try {
      // The worker image list is otherwise only loaded by the tool-picker /
      // worker-menu UI. On a first open the user hasn't touched those, so
      // ensure it's populated here — otherwise the catalog would contain only
      // manual tools and could never suggest Cellpose/Piscis/etc.
      await properties.fetchWorkerImageList();

      const map = main.maps[0]?.map;
      const viewportShot = await captureViewportScreenshot(map);
      // Tool suggestions only need the rendered image. Avoid html2canvas's
      // full-DOM clone in the common case because browser extensions can inject
      // unsupported CSS into that clone and spam the console. Keep a fallback
      // for unusual cases where GeoJS can't produce a viewport screenshot.
      const interfaceShot = viewportShot
        ? null
        : await captureInterfaceScreenshot(getToolSuggestionsPanel());

      const images: { media_type: string; data: string }[] = [];
      for (const shot of [viewportShot, interfaceShot]) {
        if (!shot) {
          continue;
        }
        const parsed = dataUrlToBase64(shot.data);
        if (parsed) {
          images.push(parsed);
        }
      }
      if (images.length === 0) {
        this.setStatus("error");
        this.setErrorMessage("Could not capture a screenshot of the dataset.");
        return;
      }

      const catalog = buildCatalog();
      const currentDataset = main.dataset;
      if (!currentDataset) {
        this.setStatus("idle");
        this.setSuggestions([]);
        return;
      }
      const channels = [...currentDataset.channelNames.values()];
      const layers = buildLayerContext();

      const rawSuggestions: IToolSuggestion[] =
        await main.toolSuggestionsAPI.getToolSuggestions({
          images,
          catalog,
          channels,
          layers,
        });

      // If the user switched collections while the request was in flight,
      // discard the result: it was computed for the old configuration's
      // channels/layers and must not be applied to the new one.
      if ((main.configuration?.id ?? null) !== startConfigurationId) {
        this.setStatus("idle");
        this.setSuggestions([]);
        return;
      }

      const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
      const resolved: IResolvedToolSuggestion[] = [];
      for (const suggestion of rawSuggestions) {
        const entry = catalogById.get(suggestion.toolId);
        if (!entry) {
          continue;
        }
        const tool = buildToolConfiguration(entry, {
          channelName: suggestion.channelName,
        });
        if (!tool) {
          continue;
        }
        resolved.push({ suggestion, catalogEntry: entry, tool });
      }

      this.setSuggestions(resolved);
      this.setStatus("done");
    } catch (error) {
      logError("Failed to get tool suggestions:", error);
      this.setStatus("error");
      this.setErrorMessage(
        typeof error === "string" ? error : "Failed to get tool suggestions.",
      );
    }
  }

  // Add a single suggested tool to the current configuration.
  @Action
  acceptSuggestion(resolved: IResolvedToolSuggestion) {
    main.addToolToConfiguration(resolved.tool);
    this.removeSuggestionByToolId(resolved.tool.id);
  }

  // Add all remaining suggested tools in a single configuration sync.
  @Action
  async acceptAllSuggestions() {
    const tools = this.suggestions.map((resolved) => resolved.tool);
    if (tools.length > 0) {
      main.addToolsToConfiguration(tools);
    }
    this.setSuggestions([]);
  }
}

export default getModule(ToolSuggestions);

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}
