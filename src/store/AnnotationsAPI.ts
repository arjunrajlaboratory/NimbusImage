import { RestClientInstance } from "@/girder";
import {
  IAnnotation,
  IAnnotationConnection,
  IAnnotationBase,
  IAnnotationStub,
  IToolConfiguration,
  IAnnotationConnectionBase,
  IWorkerInterfaceValues,
  IAnnotationLocation,
  IDisplayLayer,
  IScales,
  IDataset,
  IAnnotationImportPayload,
  IAnnotationImportResult,
  IAnnotationListQuery,
  IAnnotationListPage,
  IAnnotationListRow,
  IAnnotationListFilters,
  TAnnotationOverviewMode,
  IAnalysisGatePlotRequest,
  IAnalysisHistogramRequest,
  IAnalysisHistogramResponse,
} from "./model";
import type { IAnnotationRasterSelector } from "@/utils/annotationOverview";

import { filtersMatchNothing } from "@/utils/annotationListFilters";
import { logError } from "@/utils/log";
import { fetchAllPages } from "@/utils/fetch";
import { markRaw } from "vue";

export interface IAnnotationRasterUrlOptions {
  datasetId: string;
  selectors: IAnnotationRasterSelector[];
  sizeX: number;
  sizeY: number;
  tileSize: number;
  maxLevel: number;
  mode: TAnnotationOverviewMode;
  color: string;
  version: number;
}

export default class AnnotationsAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  undo(datasetId: string) {
    return this.client.put("history/undo", undefined, {
      params: { datasetId },
    });
  }

  redo(datasetId: string) {
    return this.client.put("history/redo", undefined, {
      params: { datasetId },
    });
  }

  createAnnotation(
    annotationBase: IAnnotationBase,
  ): Promise<IAnnotation | null> {
    return this.client
      .post("upenn_annotation", annotationBase)
      .then((r) => this.toAnnotation(r.data))
      .catch((err) => {
        logError(`Unable to send new annotation to server ${err}`);
        return null;
      });
  }

  createMultipleAnnotations(
    annotationList: IAnnotationBase[],
  ): Promise<IAnnotation[] | null> {
    return this.client
      .post("upenn_annotation/multiple", annotationList)
      .then((response) => {
        const annotations: IAnnotation[] = [];
        for (const item of response.data) {
          annotations.push(this.toAnnotation(item));
        }
        return annotations;
      })
      .catch((err) => {
        logError(`Unable to send multiple new annotations to server ${err}`);
        return null;
      });
  }

  createConnections(
    annotationsIds: string[],
    tags: string[],
    channelId: number | null,
  ): Promise<IAnnotationConnection[] | null> {
    return this.client
      .post("annotation_connection/connectTo", {
        annotationsIds,
        tags,
        channelId,
      })
      .then((res) => {
        return res.data.map((connection: any) => this.toConnection(connection));
      });
  }

  async getAnnotationsForDatasetId(datasetId: string): Promise<IAnnotation[]> {
    const annotations: IAnnotation[] = [];
    const pages = await fetchAllPages(
      this.client,
      "upenn_annotation",
      {
        params: { datasetId, sort: "_id" },
      },
      undefined,
    );
    for (const page of pages) {
      const newAnnotations = page.map(this.toAnnotation);
      annotations.push(...newAnnotations);
    }
    return annotations;
  }

  async getAnnotationStubs(datasetId: string): Promise<IAnnotationStub[]> {
    const response = await this.client.get("upenn_annotation/stubs", {
      params: { datasetId },
    });
    return (response.data as any[]).map(this.toStub);
  }

  annotationRasterTemplateUrl(options: IAnnotationRasterUrlOptions): string {
    const url = new URL(`${this.client.apiRoot}/upenn_annotation/raster/0/0/0`);
    url.searchParams.set("datasetId", options.datasetId);
    url.searchParams.set("selectors", JSON.stringify(options.selectors));
    url.searchParams.set("sizeX", options.sizeX.toString());
    url.searchParams.set("sizeY", options.sizeY.toString());
    url.searchParams.set("tileSize", options.tileSize.toString());
    url.searchParams.set("maxLevel", options.maxLevel.toString());
    url.searchParams.set("mode", options.mode);
    url.searchParams.set("color", options.color);
    url.searchParams.set("v", options.version.toString());
    return url.href.replace(
      "/upenn_annotation/raster/0/0/0",
      "/upenn_annotation/raster/{z}/{x}/{y}",
    );
  }

  toListRow = (item: any): IAnnotationListRow => {
    const stub = this.toStub(item);
    return markRaw({
      ...stub,
      name: item.name ?? null,
      values: item.values || {},
    });
  };

  async fetchAnnotationListPage(
    query: IAnnotationListQuery,
  ): Promise<IAnnotationListPage> {
    // An id constraint that is present but empty means "nothing matches", which
    // the API rejects rather than answering (see filtersMatchNothing). The
    // client already knows the answer, so it answers instead of asking.
    if (filtersMatchNothing(query.filters)) {
      return { total: 0, rows: [], offset: null };
    }
    const response = await this.client.post("upenn_annotation/list", query);
    return {
      total: response.data.total,
      rows: (response.data.rows as any[]).map(this.toListRow),
      offset: response.data.offset,
    };
  }

  async fetchAnnotationListIds(
    datasetId: string,
    filters: IAnnotationListFilters,
  ): Promise<string[]> {
    if (filtersMatchNothing(filters)) {
      return [];
    }
    const response = await this.client.post("upenn_annotation/list/ids", {
      datasetId,
      filters,
    });
    return response.data.ids as string[];
  }

  /**
   * Resolve gate polygons server-side (SERVER_GATING.md, Phase 1): each
   * plot's answer is the pure per-annotation predicate over the whole
   * dataset. Returns null on failure — never {} — so the caller can keep
   * same-input gate ids on a transient error instead of resolving every
   * gate to zero matches.
   */
  async fetchAnalysisGateIds(
    datasetId: string,
    plots: IAnalysisGatePlotRequest[],
    // Receives the server's explanation when the request fails. The endpoint
    // enforces id budgets (MAX_GATE_RESPONSE_IDS) that a few broad gates on a
    // 700K dataset can genuinely exceed, and the retry under identical inputs
    // fails identically — so without surfacing the reason, every gate simply
    // stops filtering and the only trace is a console line.
    onError?: (message: string) => void,
  ): Promise<{ [plotId: string]: string[] } | null> {
    if (plots.length === 0) {
      return {};
    }
    try {
      const response = await this.client.post(
        "upenn_annotation/analysis/gate_ids",
        { datasetId, plots },
      );
      return response.data.gateIds as { [plotId: string]: string[] };
    } catch (error) {
      logError("Failed to resolve analysis gates server-side:", error);
      onError?.(
        (error as any)?.response?.data?.message ??
          "The server could not resolve the gates.",
      );
      return null;
    }
  }

  /**
   * Server-binned display data for one over-cap analysis plot
   * (SERVER_GATING.md, Phase 2). Returns null on failure so callers can
   * distinguish "no data" from "request failed".
   */
  async fetchAnalysisHistogram(
    datasetId: string,
    request: IAnalysisHistogramRequest,
  ): Promise<IAnalysisHistogramResponse | null> {
    try {
      const response = await this.client.post(
        "upenn_annotation/analysis/histogram2d",
        { datasetId, ...request },
      );
      return response.data as IAnalysisHistogramResponse;
    } catch (error) {
      logError("Failed to fetch analysis histogram:", error);
      return null;
    }
  }

  async hydrateAnnotations(
    annotationIds: string[],
    signal?: AbortSignal,
  ): Promise<IAnnotation[]> {
    if (annotationIds.length === 0) {
      return [];
    }
    const response = await this.client.post(
      "upenn_annotation/hydrate",
      annotationIds,
      { signal },
    );
    return (response.data as any[]).map(this.toAnnotation);
  }

  async deleteAnnotation(id: string): Promise<void> {
    return this.client.delete(`upenn_annotation/${id}`);
  }

  async deleteMultipleAnnotations(annotationIds: string[]) {
    return this.client.delete("upenn_annotation/multiple", {
      data: annotationIds,
    });
  }

  updateAnnotations(annotations: (Partial<IAnnotation> & { id: string })[]) {
    return this.client.put("upenn_annotation/multiple", annotations);
  }

  updateAnnotation(annotation: IAnnotation) {
    const newAnnotation: Partial<IAnnotation> = { ...annotation };
    delete newAnnotation.id;
    return this.client.put(`upenn_annotation/${annotation.id}`, newAnnotation);
  }

  toAnnotation = (item: any): IAnnotation => {
    const {
      name,
      tags,
      shape,
      channel,
      location,
      coordinates,
      _id,
      datasetId,
      color,
    } = item;
    const annotation: IAnnotation = markRaw({
      name,
      tags,
      shape,
      channel,
      location,
      coordinates,
      id: _id,
      datasetId,
      color: color ?? null,
    });
    return annotation;
  };

  createConnection(
    annotationConnectionBase: IAnnotationConnectionBase,
  ): Promise<IAnnotationConnection | null> {
    return this.client
      .post("annotation_connection", annotationConnectionBase)
      .then((r) => this.toConnection(r.data))
      .catch((err) => {
        logError(`Unable to send new annotation connection to server ${err}`);
        return null;
      });
  }

  createMultipleConnections(
    annotationConnectionBases: IAnnotationConnectionBase[],
  ): Promise<IAnnotationConnection[] | null> {
    return this.client
      .post("annotation_connection/multiple", annotationConnectionBases)
      .then((response) => {
        const connections: IAnnotationConnection[] = [];
        for (const item of response.data) {
          connections.push(this.toConnection(item));
        }
        return connections;
      })
      .catch((err) => {
        logError(
          `Unable to send multiple new annotation connections to server ${err}`,
        );
        return null;
      });
  }

  deleteMultipleConnections(connectionIds: string[]) {
    return this.client.delete("annotation_connection/multiple", {
      data: connectionIds,
    });
  }

  async getConnectionsForDatasetId(
    datasetId: string,
  ): Promise<IAnnotationConnection[]> {
    const connections: IAnnotationConnection[] = [];
    const pages = await fetchAllPages(
      this.client,
      "annotation_connection",
      {
        params: { datasetId, sort: "_id" },
      },
      undefined,
    );
    for (const page of pages) {
      const newConnections = page.map(this.toConnection);
      connections.push(...newConnections);
    }
    return connections;
  }

  async deleteConnection(id: string): Promise<void> {
    return this.client.delete(`annotation_connection/${id}`);
  }

  async updateConnection(connection: IAnnotationConnection) {
    const newConnection: Partial<IAnnotationConnection> = { ...connection };
    delete newConnection.id;
    this.client.put(`annotation_connection/${connection.id}`, newConnection);
  }

  async computeAnnotationWithWorker(
    tool: IToolConfiguration,
    dataset: Pick<IDataset, "id">,
    metadata: {
      channel: Number;
      location: IAnnotationLocation;
      tile: IAnnotationLocation;
    },
    workerInterface: IWorkerInterfaceValues,
    layers: IDisplayLayer[],
    scales: IScales,
  ) {
    const datasetId = dataset.id;
    const { id, name, type, values } = tool;
    const image = values.image.image;
    const { annotation = {}, connectTo = {}, jobDateTag } = values;
    let tags = annotation.tags ?? [];
    if (jobDateTag) {
      const date = new Date(Date.now());
      const timeZone = date.getTimezoneOffset() / 60;
      const dateString =
        [date.getFullYear(), date.getMonth() + 1, date.getDate()].join("-") +
        " " +
        [date.getHours(), date.getMinutes(), date.getSeconds()].join(":") +
        " UTC" +
        (timeZone >= 0 ? "+" : "") +
        timeZone;
      const computedTag = image + " job " + dateString;
      tags = [...tags, computedTag];
    }
    const connectToLayerId = connectTo.layer;
    const connectToLayer = connectToLayerId
      ? layers.find((layer) => layer.id === connectToLayerId)
      : null;
    const connectToChannel = connectToLayer ? connectToLayer.channel : null;
    const augmentedConnectTo = {
      tags: [],
      ...connectTo,
      channel: connectToChannel,
    };
    const params = {
      datasetId,
      type,
      id,
      name,
      image,
      channel: metadata.channel,
      assignment: metadata.location,
      tags,
      tile: metadata.tile,
      connectTo: augmentedConnectTo,
      workerInterface,
      scales,
    };
    return this.client.post(
      `upenn_annotation/compute?datasetId=${datasetId}`,
      params,
    );
  }

  toStub = (item: any): IAnnotationStub => {
    // datasetId is intentionally excluded from the stub (redundant — see
    // ANNOTATION-STUBS.md "Resolved Design Decisions" #1).
    const {
      _id,
      tags,
      shape,
      channel,
      location,
      color,
      centroid,
      estimatedRadius,
    } = item;
    return markRaw({
      id: _id,
      tags,
      shape,
      channel,
      location,
      color: color ?? null,
      centroid,
      estimatedRadius,
    });
  };

  toConnection = (item: any): IAnnotationConnection => {
    const { label, tags, _id, parentId, childId, datasetId } = item;
    return markRaw({
      label,
      tags,
      id: _id,
      parentId,
      childId,
      datasetId,
    });
  };

  // Import annotations, connections and property values exported as JSON.
  // The backend sanitizes the raw documents and remaps old ids to the newly
  // created annotations, rolling back everything it created on failure.
  async importAnnotationData(
    payload: IAnnotationImportPayload,
  ): Promise<IAnnotationImportResult> {
    return this.client
      .post("annotation_import", payload)
      .then((response) => response.data);
  }

  // Count endpoints

  async getAnnotationCount(datasetId: string): Promise<number> {
    // Intentionally does NOT swallow errors to 0: a silent 0 is <=
    // stubThreshold and would route a large dataset into the full-fetch (OOM)
    // branch. Callers must handle the rejection (fetchAnnotations falls back to
    // stub-only mode; DatasetInfo shows the count as unknown).
    const res = await this.client.get("upenn_annotation/count", {
      params: { datasetId },
    });
    return res.data.count;
  }

  async getConnectionCount(datasetId: string): Promise<number> {
    return this.client
      .get("annotation_connection/count", { params: { datasetId } })
      .then((res) => res.data.count)
      .catch(() => 0);
  }

  async getPropertyValueCount(datasetId: string): Promise<number> {
    return this.client
      .get("annotation_property_values/count", { params: { datasetId } })
      .then((res) => res.data.count)
      .catch(() => 0);
  }
}
