import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// PropertiesAPI -> @/utils/fetch -> @/store/progress -> @/store root, which
// creates a circular import when the API class is loaded in isolation. Mock
// the fetch util (unused by getUncomputedCounts) to break that chain.
vi.mock("@/utils/fetch", () => ({ fetchAllPages: vi.fn() }));

import PropertiesAPI from "./PropertiesAPI";
import type { IAnnotationProperty } from "./model";
import {
  MAX_PROPERTY_COMPUTE_BATCH,
  MAX_SAMPLED_PROPERTIES_PER_REQUEST,
} from "./constants";

const makeProperty = (
  id: string,
  shape: string,
  tags: string[],
  exclusive: boolean,
): IAnnotationProperty =>
  ({
    id,
    name: id,
    image: "img",
    shape,
    tags: { tags, exclusive },
    workerInterface: {},
  }) as unknown as IAnnotationProperty;

describe("PropertiesAPI.getUncomputedCounts", () => {
  it("POSTs the dataset id and reduced property specs and returns the counts", async () => {
    const post = vi.fn().mockResolvedValue({ data: { p1: 3, p2: 0 } });
    const api = new PropertiesAPI({ post } as any);

    const result = await api.getUncomputedCounts("dataset-1", [
      makeProperty("p1", "point", ["nucleus"], false),
      makeProperty("p2", "polygon", [], true),
    ]);

    expect(post).toHaveBeenCalledWith("upenn_annotation/uncomputed_counts", {
      datasetId: "dataset-1",
      properties: [
        {
          id: "p1",
          shape: "point",
          tags: { tags: ["nucleus"], exclusive: false },
        },
        { id: "p2", shape: "polygon", tags: { tags: [], exclusive: true } },
      ],
    });
    expect(result).toEqual({ p1: 3, p2: 0 });
  });

  it("returns an empty map without calling the server when there are no properties", async () => {
    const post = vi.fn();
    const api = new PropertiesAPI({ post } as any);

    const result = await api.getUncomputedCounts("dataset-1", []);

    expect(result).toEqual({});
    expect(post).not.toHaveBeenCalled();
  });
});

describe("PropertiesAPI.computeProperties", () => {
  it("submits every property in one request", async () => {
    const post = vi.fn().mockResolvedValue({ data: [] });
    const api = new PropertiesAPI({ post } as any);
    const properties = [
      makeProperty("p1", "point", ["nucleus"], false),
      makeProperty("p2", "polygon", [], true),
    ];
    const scales = { pixelSize: { value: 1, unit: "um" } } as any;

    await api.computeProperties("dataset-1", properties, scales);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("annotation_property/compute", {
      datasetId: "dataset-1",
      properties: properties.map((property) => ({
        id: property.id,
        parameters: { ...property, scales },
      })),
    });
  });
});

describe("property compute batch cap", () => {
  it("matches the server's MAX_COMPUTE_PROPERTIES", () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "../../devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/property.py",
      ),
      "utf8",
    );
    const serverCap = source.match(/^MAX_COMPUTE_PROPERTIES = (\d+)$/m)?.[1];
    expect(Number(serverCap)).toBe(MAX_PROPERTY_COMPUTE_BATCH);
  });
});

describe("PropertiesAPI.getPropertyValueSamples", () => {
  it("matches the server's MAX_SAMPLED_PROPERTIES", () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "../../devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/helpers/validation.py",
      ),
      "utf8",
    );
    const serverCap = source.match(/^MAX_SAMPLED_PROPERTIES = (\d+)$/m)?.[1];
    expect(Number(serverCap)).toBe(MAX_SAMPLED_PROPERTIES_PER_REQUEST);
  });

  it("splits a configuration over the server's cap across requests", async () => {
    const propertyIds = Array.from(
      { length: MAX_SAMPLED_PROPERTIES_PER_REQUEST + 1 },
      (_, index) => `p${index}`,
    );
    const post = vi.fn(async (_path: string, body: any) => ({
      data: body.propertyIds.map((propertyId: string) => ({
        annotationId: `a-${propertyId}`,
        values: { [propertyId]: { x: 1 } },
      })),
    }));
    const api = new PropertiesAPI({ post } as any);

    const documents = await api.getPropertyValueSamples("ds", propertyIds);

    expect(post.mock.calls.map(([, body]) => body.propertyIds)).toEqual([
      propertyIds.slice(0, MAX_SAMPLED_PROPERTIES_PER_REQUEST),
      propertyIds.slice(MAX_SAMPLED_PROPERTIES_PER_REQUEST),
    ]);
    expect(post.mock.calls.every(([, body]) => body.datasetId === "ds")).toBe(
      true,
    );
    expect(documents.flatMap((doc) => Object.keys(doc.values))).toEqual(
      propertyIds,
    );
  });
});

describe("PropertiesAPI.getProperties", () => {
  it("fetches every property in one batch request", async () => {
    const post = vi.fn().mockResolvedValue({
      data: [
        {
          _id: "p2",
          name: "Area",
          image: "img",
          shape: "polygon",
          tags: { tags: [], exclusive: false },
          workerInterface: { units: "um" },
          _accessLevel: 0,
          _modelType: "annotation_property",
        },
        {
          _id: "p1",
          name: "Count",
          image: "img",
          shape: "point",
          tags: { tags: ["cell"], exclusive: true },
        },
      ],
    });
    const get = vi.fn();
    const api = new PropertiesAPI({ post, get } as any);

    const result = await api.getProperties(["p2", "missing", "p1"]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("annotation_property/batch", {
      ids: ["p2", "missing", "p1"],
    });
    expect(get).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        id: "p2",
        name: "Area",
        image: "img",
        shape: "polygon",
        tags: { tags: [], exclusive: false },
        workerInterface: { units: "um" },
      },
      {
        id: "p1",
        name: "Count",
        image: "img",
        shape: "point",
        tags: { tags: ["cell"], exclusive: true },
        workerInterface: {},
      },
    ]);
  });

  it("skips the request for an empty configuration", async () => {
    const post = vi.fn();
    const api = new PropertiesAPI({ post } as any);

    expect(await api.getProperties([])).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });
});
