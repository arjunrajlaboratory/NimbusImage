import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchTranscriptsSchema: vi.fn(),
  goToAnnotationLocation: vi.fn(),
  main: null as any,
}));

// Reactive, like the real store: the hasTranscripts getter is cached on its
// reactive dependencies, and main.dataset is one of them.
vi.mock("@/store/index", async () => {
  const { reactive } = await import("vue");
  mocks.main = reactive({
    dataset: { id: "ds1" } as { id: string } | null,
    spatialAPI: {
      fetchTranscriptsSchema: (...a: any[]) =>
        mocks.fetchTranscriptsSchema(...a),
    },
  });
  return { default: mocks.main };
});

vi.mock("@/utils/annotationNavigation", () => ({
  goToAnnotationLocation: (...a: any[]) => mocks.goToAnnotationLocation(...a),
}));

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import transcriptsStore, {
  TRANSCRIPT_GENE_COLORS,
  MAX_TRANSCRIPT_GENES,
} from "./transcripts";

const SCHEMA = {
  itemId: "i",
  levels: 2,
  gridSizeMicrons: 250,
  pixelSize: 0.2,
  transform: null,
  genes: 3,
  totalPoints: 7,
  tiles: [],
};

describe("transcripts store", () => {
  beforeEach(() => {
    mocks.main.dataset = { id: "ds1" };
    mocks.fetchTranscriptsSchema.mockReset().mockResolvedValue(SCHEMA);
    mocks.goToAnnotationLocation.mockReset();
    transcriptsStore.setSchema({ datasetId: "", schema: null });
    transcriptsStore.setError(null);
  });

  it("knows the store only for the dataset it was fetched for", async () => {
    await transcriptsStore.refreshSchema();
    expect(transcriptsStore.hasTranscripts).toBe(true);
    mocks.main.dataset = { id: "ds2" };
    expect(transcriptsStore.hasTranscripts).toBe(false);
    // ensureSchema refetches for the new dataset, once.
    mocks.fetchTranscriptsSchema.mockResolvedValue(null);
    await transcriptsStore.ensureSchema();
    await transcriptsStore.ensureSchema();
    expect(mocks.fetchTranscriptsSchema).toHaveBeenCalledTimes(2);
    expect(transcriptsStore.hasTranscripts).toBe(false);
    expect(transcriptsStore.error).toBeNull();
  });

  it("keeps 'could not ask' distinct from 'no store'", async () => {
    mocks.fetchTranscriptsSchema.mockRejectedValue(new Error("boom"));
    await transcriptsStore.refreshSchema();
    expect(transcriptsStore.error).toContain("Could not read");
    expect(transcriptsStore.hasTranscripts).toBe(false);
  });

  it("discards a stale answer after a dataset switch", async () => {
    let resolve!: (value: any) => void;
    mocks.fetchTranscriptsSchema.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const pending = transcriptsStore.refreshSchema();
    mocks.main.dataset = { id: "ds2" };
    resolve(SCHEMA);
    await pending;
    expect(transcriptsStore.schemaDatasetId).not.toBe("ds1");
  });

  it("assigns and keeps gene colors, and resets with the dataset", () => {
    transcriptsStore.setSchema({ datasetId: "ds1", schema: SCHEMA });
    transcriptsStore.setSymbols(["CD3E", "MS4A1"]);
    expect(transcriptsStore.genes).toEqual([
      { symbol: "CD3E", color: TRANSCRIPT_GENE_COLORS[0] },
      { symbol: "MS4A1", color: TRANSCRIPT_GENE_COLORS[1] },
    ]);
    transcriptsStore.setGeneColor({ symbol: "CD3E", color: "#123456" });
    // Removing the first gene keeps the second's color; a new gene takes the
    // first free palette color rather than reusing a taken one.
    transcriptsStore.setSymbols(["MS4A1", "CCL19"]);
    expect(transcriptsStore.genes).toEqual([
      { symbol: "MS4A1", color: TRANSCRIPT_GENE_COLORS[1] },
      { symbol: "CCL19", color: TRANSCRIPT_GENE_COLORS[0] },
    ]);
    transcriptsStore.setSymbols(
      Array.from({ length: MAX_TRANSCRIPT_GENES + 3 }, (_, i) => `G${i}`),
    );
    expect(transcriptsStore.genes).toHaveLength(MAX_TRANSCRIPT_GENES);
    transcriptsStore.setEnabled(true);
    transcriptsStore.setReadout({
      symbol: "G0",
      x: 1,
      y: 2,
      quality: 30,
      annotationId: "ann1",
    });
    transcriptsStore.setSchema({ datasetId: "ds2", schema: SCHEMA });
    expect(transcriptsStore.genes).toEqual([]);
    expect(transcriptsStore.enabled).toBe(false);
    expect(transcriptsStore.readout).toBeNull();
  });

  it("drops the readout when its gene is removed or the overlay is turned off", () => {
    transcriptsStore.setSymbols(["CD3E"]);
    transcriptsStore.setReadout({
      symbol: "CD3E",
      x: 1,
      y: 2,
      quality: null,
      annotationId: null,
    });
    transcriptsStore.setSymbols(["MS4A1"]);
    expect(transcriptsStore.readout).toBeNull();
    transcriptsStore.setReadout({
      symbol: "MS4A1",
      x: 1,
      y: 2,
      quality: null,
      annotationId: null,
    });
    transcriptsStore.setEnabled(false);
    expect(transcriptsStore.readout).toBeNull();
  });

  it("changes the request signature for refetch inputs only", () => {
    transcriptsStore.setSymbols(["CD3E"]);
    const before = transcriptsStore.requestSignature;
    transcriptsStore.setGeneColor({ symbol: "CD3E", color: "#000000" });
    transcriptsStore.setStatus({
      rendering: "points",
      level: 0,
      points: 1,
      note: null,
    });
    expect(transcriptsStore.requestSignature).toBe(before);
    transcriptsStore.setMinQv(25);
    expect(transcriptsStore.requestSignature).not.toBe(before);
  });

  it("navigates to a molecule's cell by annotation id", async () => {
    await transcriptsStore.goToCell("ann7");
    expect(mocks.goToAnnotationLocation).toHaveBeenCalledWith("ann7");
  });
});
