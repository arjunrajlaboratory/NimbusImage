import { RestClientInstance } from "@/girder";
import { IAnnotation, IAnnotationConnection, IGeoJSPoint } from "./model";
import { Promise } from "bluebird";

import { logError } from "@/utils/log";

export default class AnnotationsAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  histogramsLoaded = 0;

  createAnnotation(
    tags: string[],
    shape: string,
    channel: number,
    location: { XY: number; Z: number; Time: number },
    coordinates: IGeoJSPoint[],
    datasetId: string
  ): Promise<IAnnotation | null> {
    return this.client
      .post("upenn_annotation", {
        tags,
        shape,
        channel,
        location,
        coordinates,
        datasetId
      })
      .then(r => this.toAnnotation(r.data))
      .catch(err => {
        logError(`Unable to send new annotation data to server ${err}`);
        return null;
      });
  }

  async getAnnotationsForDatasetId(id: string): Promise<IAnnotation[]> {
    const annotations: IAnnotation[] = [];
    const limit = 25;
    let totalCount = -1;

    const fetchPage = (offset: number) =>
      this.client
        .get(
          `upenn_annotation?datasetId=${id}&limit=${limit}&offset=${offset}&sort=_id`
        )
        .then(res => {
          totalCount = Number(res.headers["girder-total-count"]);
          const newAnnotations = res.data.map(this.toAnnotation);
          annotations.push(...newAnnotations);
        })
        .catch(err => {
          throw err;
        });

    // Fetch first page
    await fetchPage(0);

    // Fetch remaining pages if needed
    const promises = [];
    for (let offset = limit; offset < totalCount; offset += limit) {
      promises.push(fetchPage(offset));
    }
    try {
      await Promise.all(promises);
    } catch (err) {
      logError(`Could not get annotations for dataset ${id}: ${err}`);
      return [];
    }
    return annotations;
  }

  async deleteAnnotation(id: string): Promise<void> {
    // TODO: check response
    return this.client.delete(`upenn_annotation/${id}`);
  }

  async updateAnnotation(annotation: IAnnotation) {
    const newAnnotation = { ...annotation };
    delete newAnnotation.id;
    this.client.put(`upenn_annotation/${annotation.id}`, newAnnotation);
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
      datasetId
    } = item;
    return {
      name,
      tags,
      shape,
      channel,
      location,
      coordinates,
      id: _id,
      datasetId
    };
  };

  createConnection(
    parentId: string,
    childId: string,
    label: string,
    tags: string[],
    datasetId: string
  ): Promise<IAnnotationConnection | null> {
    return this.client
      .post("annotation_connection", {
        label,
        tags,
        childId,
        parentId,
        datasetId
      })
      .then(r => this.toConnection(r.data))
      .catch(err => {
        logError(`Unable to send new annotation data to server ${err}`);
        return null;
      });
  }

  async getConnectionsForDatasetId(id: string): Promise<IAnnotationConnection[]> {
    const connections: IAnnotationConnection[] = [];
    const limit = 1;
    let totalCount = -1;

    const fetchPage = (offset: number) =>
      this.client
        .get(
          `annotation_connection?datasetId=${id}&limit=${limit}&offset=${offset}&sort=_id`
        )
        .then(res => {
          totalCount = Number(res.headers["girder-total-count"]);
          const newConnections = res.data.map(this.toConnection);
          connections.push(...newConnections);
        })
        .catch(err => {
          throw err;
        });

    // Fetch first page
    await fetchPage(0);

    // Fetch remaining pages if needed
    const promises = [];
    for (let offset = limit; offset < totalCount; offset += limit) {
      promises.push(fetchPage(offset));
    }
    try {
      await Promise.all(promises);
    } catch (err) {
      logError(`Could not get connections for dataset ${id}: ${err}`);
      return [];
    }
    return connections;
  }

  async deleteConnection(id: string): Promise<void> {
    // TODO: check response
    return this.client.delete(`annotation_connection/${id}`);
  }

  async updateConnection(connection: IAnnotationConnection) {
    const newConnection = { ...connection };
    delete newConnection.id;
    this.client.put(`annotation_connection/${connection.id}`, newConnection);
  }

  toConnection = (item: any): IAnnotationConnection => {
    const { label, tags, _id, parentId, childId } = item;
    return {
      label,
      tags,
      id: _id,
      parentId,
      childId
    };
  };
}
