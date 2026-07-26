import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindDatasetViews = vi.fn();
const mockBatchResources = vi.fn();

vi.mock("@/store", () => ({
  default: {
    api: {
      findDatasetViews: (...args: any[]) => mockFindDatasetViews(...args),
      batchResources: (...args: any[]) => mockBatchResources(...args),
    },
  },
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
}));

import { collectionsToDatasetChips } from "./collectionChips";

describe("collectionsToDatasetChips", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFindDatasetViews.mockResolvedValue([]);
    mockBatchResources.mockResolvedValue({ folder: {} });
  });

  it("returns an empty result and issues no requests for an empty list", async () => {
    expect(await collectionsToDatasetChips([])).toEqual({});
    expect(mockFindDatasetViews).not.toHaveBeenCalled();
  });

  it("resolves every collection with two batch requests", async () => {
    mockFindDatasetViews.mockResolvedValue([
      { id: "v1", datasetId: "ds1", configurationId: "col1" },
      { id: "v2", datasetId: "ds2", configurationId: "col2" },
      { id: "v3", datasetId: "ds1", configurationId: "col2" },
    ]);
    mockBatchResources.mockResolvedValue({
      folder: { ds1: { name: "Dataset A" }, ds2: { name: "Dataset B" } },
    });

    const result = await collectionsToDatasetChips(["col1", "col2", "col3"]);

    expect(mockFindDatasetViews).toHaveBeenCalledTimes(1);
    expect(mockFindDatasetViews).toHaveBeenCalledWith({
      configurationIds: ["col1", "col2", "col3"],
    });
    expect(mockBatchResources).toHaveBeenCalledTimes(1);
    expect(mockBatchResources).toHaveBeenCalledWith({
      folder: ["ds1", "ds2"],
    });

    expect(result.col1.chips).toEqual([
      {
        text: "Dataset A",
        color: "dataset",
        to: { name: "dataset", params: { datasetId: "ds1" } },
      },
    ]);
    expect(result.col2.chips.map((chip) => chip.text)).toEqual([
      "Dataset B",
      "Dataset A",
    ]);
    // Collections with no views still get an entry, so callers can tell
    // "resolved to nothing" apart from "not resolved yet".
    expect(result.col3).toEqual({ chips: [], type: "collection" });
  });

  it("skips views whose dataset no longer exists", async () => {
    mockFindDatasetViews.mockResolvedValue([
      { id: "v1", datasetId: "deleted", configurationId: "col1" },
    ]);
    mockBatchResources.mockResolvedValue({ folder: {} });
    const result = await collectionsToDatasetChips(["col1"]);
    expect(result.col1.chips).toEqual([]);
  });

  it("skips the dataset lookup when no views come back", async () => {
    const result = await collectionsToDatasetChips(["col1"]);
    expect(mockBatchResources).not.toHaveBeenCalled();
    expect(result.col1).toEqual({ chips: [], type: "collection" });
  });

  // Swallowing the failure here would resolve with empty chips, which the table
  // renders as "No datasets" — indistinguishable from a collection that really
  // has none — and would leave the caller no way to know a retry is warranted.
  // Propagate instead and let the caller decide.
  it("propagates a failed view lookup instead of reporting empty chips", async () => {
    mockFindDatasetViews.mockRejectedValue(new Error("boom"));
    await expect(collectionsToDatasetChips(["col1", "col2"])).rejects.toThrow(
      "boom",
    );
  });
});
