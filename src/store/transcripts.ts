import {
  Action,
  Module,
  Mutation,
  VuexModule,
  getModule,
} from "vuex-module-decorators";
import store from "./root";
import main from "./index";
import {
  ISpatialTranscriptsSchema,
  ITranscriptGene,
  ITranscriptOverlayStatus,
  ITranscriptReadout,
  TTranscriptRenderMode,
} from "./model";
import { logError } from "@/utils/log";
import { goToAnnotationLocation } from "@/utils/annotationNavigation";

/** Colors handed to genes in the order they are added; the user can change
 * each afterwards. Distinct on a dark image and from each other. */
export const TRANSCRIPT_GENE_COLORS = [
  "#FF5252",
  "#40C4FF",
  "#69F0AE",
  "#FFD740",
  "#E040FB",
  "#FF6E40",
  "#18FFFF",
  "#B2FF59",
];
export const MAX_TRANSCRIPT_GENES = TRANSCRIPT_GENE_COLORS.length;
export const DEFAULT_TRANSCRIPT_MIN_QV = 20;
export const DEFAULT_TRANSCRIPT_POINT_BUDGET = 300_000;
export const TRANSCRIPT_POINT_BUDGETS = [100_000, 300_000, 1_000_000];

/**
 * The transcript overlay's state (SPATIAL_PLUGIN.md, Phase 3): which genes
 * to show, how, and what the overlay last did. The molecules themselves never
 * enter the store — `TranscriptOverlay.vue` streams them straight into GeoJS.
 *
 * `schemaDatasetId` says which dataset `schema` describes, so a stale answer
 * from the previous dataset is never shown as the current one; the selection
 * resets with the dataset because gene names are per panel.
 */
@Module({ dynamic: true, store, name: "transcripts" })
export class Transcripts extends VuexModule {
  schema: ISpatialTranscriptsSchema | null = null;
  schemaDatasetId: string | null = null;
  loading = false;
  // "no store" (null schema, no error) and "could not ask" stay distinct so
  // the feature is not hidden on a network blip.
  error: string | null = null;

  enabled = false;
  genes: ITranscriptGene[] = [];
  minQv = DEFAULT_TRANSCRIPT_MIN_QV;
  mode: TTranscriptRenderMode = "auto";
  pointBudget = DEFAULT_TRANSCRIPT_POINT_BUDGET;
  status: ITranscriptOverlayStatus | null = null;
  readout: ITranscriptReadout | null = null;

  get hasTranscripts(): boolean {
    return (
      this.schema !== null &&
      this.schemaDatasetId === (main.dataset?.id ?? null)
    );
  }

  get symbols(): string[] {
    return this.genes.map((gene) => gene.symbol);
  }

  /** What the overlay must refetch on: the gene list, threshold and mode,
   * but not colors (a restyle) or the status it writes itself. */
  get requestSignature(): string {
    return JSON.stringify([
      this.enabled,
      this.symbols,
      this.minQv,
      this.mode,
      this.pointBudget,
    ]);
  }

  @Mutation
  setSchema(payload: {
    datasetId: string;
    schema: ISpatialTranscriptsSchema | null;
  }) {
    if (payload.datasetId !== this.schemaDatasetId) {
      this.enabled = false;
      this.genes = [];
      this.status = null;
      this.readout = null;
    }
    this.schemaDatasetId = payload.datasetId;
    this.schema = payload.schema;
  }

  @Mutation
  setLoading(loading: boolean) {
    this.loading = loading;
  }

  @Mutation
  setError(error: string | null) {
    this.error = error;
  }

  @Mutation
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      this.readout = null;
    }
  }

  /** Replace the gene list, keeping the color of every gene that stays and
   * handing new ones the first colors not in use. */
  @Mutation
  setSymbols(symbols: string[]) {
    const kept = new Map(this.genes.map((gene) => [gene.symbol, gene.color]));
    const used = new Set<string>();
    const next: ITranscriptGene[] = [];
    for (const symbol of symbols.slice(0, MAX_TRANSCRIPT_GENES)) {
      const color = kept.get(symbol);
      if (color !== undefined) {
        used.add(color);
        next.push({ symbol, color });
      } else {
        next.push({ symbol, color: "" });
      }
    }
    for (const gene of next) {
      if (gene.color === "") {
        gene.color =
          TRANSCRIPT_GENE_COLORS.find((color) => !used.has(color)) ??
          TRANSCRIPT_GENE_COLORS[next.indexOf(gene) % MAX_TRANSCRIPT_GENES];
        used.add(gene.color);
      }
    }
    this.genes = next;
    if (this.readout && !symbols.includes(this.readout.symbol)) {
      this.readout = null;
    }
  }

  @Mutation
  setGeneColor(payload: { symbol: string; color: string }) {
    const gene = this.genes.find((gene) => gene.symbol === payload.symbol);
    if (gene) {
      gene.color = payload.color;
    }
  }

  @Mutation
  setMinQv(minQv: number) {
    this.minQv = Math.max(0, minQv);
  }

  @Mutation
  setMode(mode: TTranscriptRenderMode) {
    this.mode = mode;
  }

  @Mutation
  setPointBudget(pointBudget: number) {
    this.pointBudget = pointBudget;
  }

  @Mutation
  setStatus(status: ITranscriptOverlayStatus | null) {
    this.status = status;
  }

  @Mutation
  setReadout(readout: ITranscriptReadout | null) {
    this.readout = readout;
  }

  @Action
  async refreshSchema(): Promise<void> {
    const datasetId = main.dataset?.id;
    if (!datasetId) {
      this.setSchema({ datasetId: "", schema: null });
      return;
    }
    this.setLoading(true);
    this.setError(null);
    try {
      const schema = await main.spatialAPI.fetchTranscriptsSchema(datasetId);
      // A dataset switch during the await would make this answer stale.
      if (main.dataset?.id === datasetId) {
        this.setSchema({ datasetId, schema });
      }
    } catch (error) {
      logError("Failed to fetch the transcript store registration:", error);
      if (main.dataset?.id === datasetId) {
        this.setError("Could not read the dataset's transcript store.");
      }
    } finally {
      this.setLoading(false);
    }
  }

  /** refreshSchema unless the answer for this dataset is already known. */
  @Action
  async ensureSchema(): Promise<void> {
    const datasetId = main.dataset?.id ?? null;
    if (datasetId !== null && this.schemaDatasetId === datasetId) {
      return;
    }
    await this.refreshSchema();
  }

  /** Navigate to the cell a molecule was clicked in. */
  @Action({ rawError: true })
  async goToCell(annotationId: string): Promise<void> {
    await goToAnnotationLocation(annotationId);
  }
}

export default getModule(Transcripts);
