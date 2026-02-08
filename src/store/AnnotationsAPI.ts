import { RestClientInstance } from "@/girder";
import {
  IAnnotation,
  IAnnotationConnection,
  IAnnotationBase,
  IToolConfiguration,
  IAnnotationConnectionBase,
  IWorkerInterfaceValues,
  IAnnotationLocation,
  IDisplayLayer,
  IScales,
  IDataset,
} from "./model";

import { logError } from "@/utils/log";
import { fetchAllPages } from "@/utils/fetch";
import { markRaw } from "vue";

export default class AnnotationsAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  histogramsLoaded = 0;

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
    const augmentedConnectTo = { ...connectTo, channel: connectToChannel };
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

  toConnection = (item: any): IAnnotationConnection => {
    const { label, tags, _id, parentId, childId, datasetId } = item;
    return {
      label,
      tags,
      id: _id,
      parentId,
      childId,
      datasetId,
    };
  };

  // Count endpoints

  async getAnnotationCount(datasetId: string): Promise<number> {
    return this.client
      .get("upenn_annotation/count", { params: { datasetId } })
      .then((res) => res.data.count)
      .catch(() => 0);
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
