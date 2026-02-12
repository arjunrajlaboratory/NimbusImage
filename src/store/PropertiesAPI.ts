import { RestClientInstance } from "@/girder";
import {
  IAnnotationProperty,
  IWorkerInterface,
  IToolConfiguration,
  IAnnotationPropertyValues,
  IWorkerImageList,
  IAnnotationPropertyConfiguration,
  IWorkerInterfaceValues,
  IAnnotationLocation,
  IDisplayLayer,
  TPropertyHistogram,
  IScales,
  TPropertyValue,
} from "./model";

import { fetchAllPages } from "@/utils/fetch";

export type TAnnotationPropertyValuesAggregation = {
  datasetId: string;
  annotationId: string;
  values: { [propertyId: string]: TPropertyValue };
}[];

export default class PropertiesAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  histogramsLoaded = 0;

  async createProperty(
    property: IAnnotationPropertyConfiguration,
  ): Promise<IAnnotationProperty> {
    return this.client
      .post("annotation_property", this.fromPropertyConfiguration(property))
      .then((res) => {
        return this.toProperty(res.data);
      });
  }

  async getProperties(propertyIds: string[]): Promise<IAnnotationProperty[]> {
    const promises: Promise<IAnnotationProperty>[] = [];
    for (const id of propertyIds) {
      const propertyPromise = this.client
        .get(`annotation_property/${id}`)
        .then((res) => this.toProperty(res.data));
      promises.push(propertyPromise);
    }
    return Promise.all(promises);
  }

  async getPropertyHistogram(
    datasetId: string,
    propertyPath: string[],
    buckets: number = 255,
  ): Promise<TPropertyHistogram> {
    const joinedPath = propertyPath.join(".");
    return this.client
      .get(
        `annotation_property_values/histogram?datasetId=${datasetId}&propertyPath=${joinedPath}&buckets=${buckets}`,
      )
      .then((res) => res.data);
  }

  async addAggregatedPropertyValues(
    aggregatedPropertyValues: TAnnotationPropertyValuesAggregation,
  ): Promise<TAnnotationPropertyValuesAggregation> {
    const response = await this.client.post(
      `annotation_property_values/multiple`,
      aggregatedPropertyValues,
    );
    return response.data;
  }

  async computeProperty(
    propertyId: string,
    datasetId: string,
    property: IAnnotationProperty,
    scales: IScales,
  ) {
    const params = {
      ...property,
      scales,
    };
    return this.client.post(
      `annotation_property/${propertyId}/compute?datasetId=${datasetId}`,
      params,
    );
  }

  async getPropertyValues(
    datasetId: string,
  ): Promise<IAnnotationPropertyValues> {
    const annotationMapping: IAnnotationPropertyValues = {};

    const pages = await fetchAllPages(
      this.client,
      "annotation_property_values",
      {
        params: { datasetId, sort: "_id" },
      },
    );
    for (const page of pages) {
      for (const { annotationId, values } of page) {
        annotationMapping[annotationId] = {
          ...annotationMapping[annotationId],
          ...values,
        };
      }
    }
    return annotationMapping;
  }

  async deleteProperty(propertyId: string) {
    return this.client.delete(`annotation_property/${propertyId}`);
  }

  async deletePropertyValues(propertyId: string, datasetId: string) {
    return this.client.delete(
      `annotation_property_values?datasetId=${datasetId}&propertyId=${propertyId}`,
    );
  }

  async getPropertyCount(configurationId: string): Promise<number> {
    return this.client
      .get("annotation_property/count", { params: { configurationId } })
      .then((res) => res.data.count)
      .catch(() => 0);
  }

  fromPropertyConfiguration(item: IAnnotationPropertyConfiguration) {
    const { name, image, shape, tags, workerInterface } = item;
    return {
      name,
      image,
      tags,
      shape,
      workerInterface,
    };
  }

  toProperty(item: any): IAnnotationProperty {
    const { _id, name, image, shape, tags, workerInterface } = item;
    return {
      id: _id,
      name,
      image,
      tags,
      shape,
      workerInterface: workerInterface || {},
    };
  }

  async getWorkerImages(): Promise<IWorkerImageList> {
    return this.client.get("worker_interface/available").then((res) => {
      return res.data;
    });
  }

  async requestWorkerInterface(image: string) {
    return this.client.post(
      `worker_interface/request?image=${encodeURIComponent(image)}`,
    );
  }

  async getWorkerInterface(image: string): Promise<IWorkerInterface | null> {
    return this.client
      .get(`worker_interface?image=${encodeURIComponent(image)}`)
      .then((res) => res.data);
  }

  async requestWorkerPreview(
    image: string,
    tool: IToolConfiguration,
    datasetId: string,
    workerInterface: IWorkerInterfaceValues,
    metadata: {
      channel: Number;
      location: IAnnotationLocation;
      tile: IAnnotationLocation;
    },
    layers: IDisplayLayer[],
  ) {
    const { id, name, type, values } = tool;
    const { annotation, connectTo } = values;
    const connectToLayerId = connectTo.layer;
    const connectToLayer = layers.find(
      (layer) => layer.id === connectToLayerId,
    );
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
      tags: annotation.tags,
      tile: metadata.tile,
      connectTo: augmentedConnectTo,
      workerInterface,
    };
    return this.client.post(
      `worker_preview/request?datasetId=${datasetId}&image=${encodeURIComponent(
        image,
      )}`,
      params,
    );
  }

  async getWorkerPreview(
    image: string,
  ): Promise<{ text: string; image: string }> {
    return this.client
      .get(`worker_preview?image=${encodeURIComponent(image)}`)
      .then((res) => {
        return res.data.preview || {};
      });
  }

  async clearWorkerPreview(image: string) {
    this.client.delete(`/worker_preview?image=${encodeURIComponent(image)}`);
  }
}
