import { describe, it, expect, vi, afterEach } from "vitest";

// Regression tests for addMultiSourceMetadata's error propagation.
//
// This action deliberately throws on failure (e.g. a storage quota breach
// during transcoding) so MultiSourceConfiguration.vue can show the real
// reason instead of a frozen spinner. Unlike most store tests, this file
// does NOT mock "@/store"/"./index": vuex-module-decorators wraps any error
// thrown from an @Action in a generic "ERR_ACTION_ACCESS_UNDEFINED" message
// unless the action is declared with { rawError: true } - a library quirk
// that silently defeats this kind of error surfacing (see the fix that
// added rawError: true to this action). These tests dispatch the REAL Vuex
// action so a regression - e.g. someone removing rawError: true - fails
// here instead of only showing up against a live backend.
import main from "./index";
import jobs from "./jobs";
import rootStore from "./root";
import "./filters";
import "./properties";
// Registers hydrateTrackLabelPath, which hydrateAnnotationBrowserState
// dispatches by name.
import "./connectionList";

function mockSuccessfulUploadAndTiles() {
  vi.spyOn(main.api, "uploadJSONFile").mockResolvedValue({
    data: { itemId: "item1" },
  } as any);
  vi.spyOn(main.api, "getItems").mockResolvedValue([]);
  vi.spyOn(main.api, "removeLargeImageForItem").mockResolvedValue({} as any);
  vi.spyOn(main.api, "generateTiles").mockResolvedValue({
    data: { _id: "job1" },
  } as any);
}

// `.rejects.toThrow(string)` only checks that the message CONTAINS the
// string. A vuex-module-decorators "ERR_ACTION_ACCESS_UNDEFINED" wrapper
// embeds the original error's message as part of its own `.stack` text, so a
// substring match would pass even when rawError is missing and the real
// message never reaches the caller as `error.message`. Assert the exact
// message instead so a regression is actually caught.
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the promise to reject, but it resolved");
}

describe("addMultiSourceMetadata error propagation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces the friendly storage-quota message when the transcode job fails due to quota", async () => {
    mockSuccessfulUploadAndTiles();
    vi.spyOn(jobs, "addJob").mockImplementation(async (job: any) => {
      job.eventCallback?.({
        _id: "job1",
        text:
          "Upload would exceed file storage quota (need 9.7 MB, only 1.9 " +
          "MB available - used 15.4 GB out of 15.4 GB)\n",
      });
      return false;
    });

    const message = await messageOf(
      main.addMultiSourceMetadata({
        parentId: "folder1",
        metadata: "{}",
        transcode: true,
      }),
    );

    expect(message).toBe(
      "This operation needs 9.7 MB of storage, but only 1.9 MB of your " +
        "15.4 GB quota remains (15.4 GB used). Free up space by deleting " +
        "datasets you no longer need, or upgrade your account for more " +
        "storage.",
    );
  });

  it("surfaces a plain transcode-failure message (not a mangled vuex-module-decorators error) when the job fails for an unrelated reason", async () => {
    mockSuccessfulUploadAndTiles();
    vi.spyOn(jobs, "addJob").mockResolvedValue(false);

    const message = await messageOf(
      main.addMultiSourceMetadata({
        parentId: "folder1",
        metadata: "{}",
        transcode: true,
      }),
    );

    expect(message).toBe(
      "Failed to transcode the large image: the transcoding job failed. " +
        "See the transcoding log for details.",
    );
  });

  it("resolves with the item id when transcoding succeeds", async () => {
    mockSuccessfulUploadAndTiles();
    vi.spyOn(jobs, "addJob").mockResolvedValue(true);

    await expect(
      main.addMultiSourceMetadata({
        parentId: "folder1",
        metadata: "{}",
        transcode: true,
      }),
    ).resolves.toBe("item1");
  });
});

describe("annotation-browser hydration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates plots without directly dispatching a duplicate analysis refresh", async () => {
    (main as any).setConfigurationImpl({
      id: "config-1",
      data: {
        id: "config-1",
        name: "config",
        layers: [],
        tools: [],
        scales: {},
        propertyIds: [],
        annotationBrowserConfig: { analysisPlots: [] },
      },
    });
    const actionNames: string[] = [];
    const unsubscribe = rootStore.subscribeAction(({ type }) =>
      actionNames.push(type),
    );

    await main.hydrateAnnotationBrowserState();
    unsubscribe();

    expect(actionNames).toContain("hydrateAnalysisPlots");
    expect(actionNames).toContain("hydrateTrackLabelPath");
    // Viewer owns the one refresh through its analysisInputSignature watcher;
    // hydration only changes the state that drives that watcher.
    expect(actionNames).not.toContain("refreshAnalysis");
  });
});
