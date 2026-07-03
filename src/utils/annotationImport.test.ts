import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1" },
    annotationsAPI: {
      importAnnotationData: vi.fn(),
      deleteMultipleAnnotations: vi.fn(),
    },
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotations: [],
    fetchAnnotations: vi.fn(),
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    properties: [],
    createProperty: vi.fn(),
    deleteProperty: vi.fn(),
    fetchPropertyValues: vi.fn(),
    fetchProperties: vi.fn(),
  },
}));

import store from "@/store";
import annotationStore from "@/store/annotation";
import propertyStore from "@/store/properties";
import {
  importAnnotationsFromData,
  ImportOptions,
  defaultImportOptions,
} from "@/utils/annotationImport";
import { ISerializedData } from "@/store/model";

const mockedStore = store as any;
const mockedAnnotationStore = annotationStore as any;
const mockedPropertyStore = propertyStore as any;

function makeSerializedData(
  overrides: Partial<ISerializedData> = {},
): ISerializedData {
  return {
    // Exported annotations only carry `_id`, never `id`.
    annotations: [
      {
        _id: "old-a1",
        name: null,
        tags: [],
        shape: "point" as any,
        channel: 0,
        location: { XY: 0, Z: 0, Time: 0 },
        coordinates: [],
        datasetId: "old-ds",
        color: null,
      },
    ],
    annotationConnections: [
      {
        _id: "old-c1",
        label: "",
        tags: [],
        parentId: "old-a1",
        childId: "old-a2",
        datasetId: "old-ds",
      },
    ],
    annotationProperties: [
      {
        _id: "old-p1",
        name: "Area",
        image: "",
        tags: { tags: [], exclusive: false },
        shape: "point" as any,
        workerInterface: {},
      },
    ],
    annotationPropertyValues: {
      "old-a1": { "old-p1": 42 },
    },
    ...overrides,
  };
}

describe("importAnnotationsFromData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStore.dataset = { id: "ds1" };
    mockedAnnotationStore.annotations = [];
    mockedPropertyStore.properties = [];
    mockedPropertyStore.createProperty.mockImplementation(
      async (property: any) => ({
        id: "new-p1",
        ...property,
      }),
    );
    mockedStore.annotationsAPI.importAnnotationData.mockResolvedValue({
      annotationCount: 1,
      connectionCount: 1,
      propertyValueCount: 1,
    });
  });

  it("throws when no dataset is selected", async () => {
    mockedStore.dataset = null;
    await expect(
      importAnnotationsFromData(makeSerializedData()),
    ).rejects.toThrow("No dataset selected");
    expect(
      mockedStore.annotationsAPI.importAnnotationData,
    ).not.toHaveBeenCalled();
  });

  it("passes the parsed data through to importAnnotationData verbatim, including annotations that only have _id", async () => {
    const serializedData = makeSerializedData();
    await importAnnotationsFromData(serializedData, defaultImportOptions);

    expect(
      mockedStore.annotationsAPI.importAnnotationData,
    ).toHaveBeenCalledTimes(1);
    const payload =
      mockedStore.annotationsAPI.importAnnotationData.mock.calls[0][0];
    expect(payload.datasetId).toBe("ds1");
    // Passed through as-is - same reference, no client-side id remapping.
    expect(payload.annotations).toBe(serializedData.annotations);
    expect(payload.annotations[0]._id).toBe("old-a1");
    expect(payload.annotations[0].id).toBeUndefined();
    expect(payload.connections).toBe(serializedData.annotationConnections);
    expect(payload.propertyValues).toBe(
      serializedData.annotationPropertyValues,
    );
  });

  it("builds propertyIdMap from old property id to created property id", async () => {
    const serializedData = makeSerializedData();
    await importAnnotationsFromData(serializedData, defaultImportOptions);

    expect(mockedPropertyStore.createProperty).toHaveBeenCalledWith(
      serializedData.annotationProperties[0],
    );
    const payload =
      mockedStore.annotationsAPI.importAnnotationData.mock.calls[0][0];
    expect(payload.propertyIdMap).toEqual({ "old-p1": "new-p1" });
  });

  it("omits connections from the payload when importConnections is false", async () => {
    const serializedData = makeSerializedData();
    const options: ImportOptions = {
      ...defaultImportOptions,
      importConnections: false,
    };
    await importAnnotationsFromData(serializedData, options);

    const payload =
      mockedStore.annotationsAPI.importAnnotationData.mock.calls[0][0];
    expect(payload.connections).toBeUndefined();
  });

  it("omits propertyValues and propertyIdMap from the payload when importValues is false", async () => {
    const serializedData = makeSerializedData();
    const options: ImportOptions = {
      ...defaultImportOptions,
      importValues: false,
    };
    await importAnnotationsFromData(serializedData, options);

    const payload =
      mockedStore.annotationsAPI.importAnnotationData.mock.calls[0][0];
    expect(payload.propertyValues).toBeUndefined();
    expect(payload.propertyIdMap).toBeUndefined();
    // Properties are still created even though values aren't imported.
    expect(mockedPropertyStore.createProperty).toHaveBeenCalled();
  });

  it("does not call importAnnotationData when importAnnotations is false", async () => {
    const serializedData = makeSerializedData();
    const options: ImportOptions = {
      ...defaultImportOptions,
      importAnnotations: false,
    };
    await importAnnotationsFromData(serializedData, options);

    expect(
      mockedStore.annotationsAPI.importAnnotationData,
    ).not.toHaveBeenCalled();
  });

  it("on failure, deletes created properties, keeps pre-existing annotations/properties, and re-throws", async () => {
    mockedAnnotationStore.annotations = [{ id: "existing-a1" }];
    mockedPropertyStore.properties = [{ id: "existing-p1" }];
    mockedStore.annotationsAPI.importAnnotationData.mockRejectedValue(
      new Error("backend import failed"),
    );

    const serializedData = makeSerializedData();
    const options: ImportOptions = {
      ...defaultImportOptions,
      overwriteAnnotations: true,
      overwriteProperties: true,
    };

    await expect(
      importAnnotationsFromData(serializedData, options),
    ).rejects.toThrow("backend import failed");

    // The newly created property is cleaned up client-side.
    expect(mockedPropertyStore.deleteProperty).toHaveBeenCalledWith("new-p1");
    // Pre-existing data is NOT deleted since the import failed.
    expect(mockedPropertyStore.deleteProperty).not.toHaveBeenCalledWith(
      "existing-p1",
    );
    expect(
      mockedStore.annotationsAPI.deleteMultipleAnnotations,
    ).not.toHaveBeenCalled();

    // Data is still refreshed after failure.
    expect(mockedAnnotationStore.fetchAnnotations).toHaveBeenCalled();
    expect(mockedPropertyStore.fetchProperties).toHaveBeenCalled();
  });

  it("does not try to delete imported annotations on backend failure", async () => {
    mockedStore.annotationsAPI.importAnnotationData.mockRejectedValue(
      new Error("backend import failed"),
    );

    await expect(
      importAnnotationsFromData(makeSerializedData(), defaultImportOptions),
    ).rejects.toThrow();

    expect(
      mockedStore.annotationsAPI.deleteMultipleAnnotations,
    ).not.toHaveBeenCalled();
  });

  it("deletes old annotations and properties only after a successful overwrite import", async () => {
    mockedAnnotationStore.annotations = [
      { id: "existing-a1" },
      { id: "existing-a2" },
    ];
    mockedPropertyStore.properties = [{ id: "existing-p1" }];

    const options: ImportOptions = {
      ...defaultImportOptions,
      overwriteAnnotations: true,
      overwriteProperties: true,
    };
    await importAnnotationsFromData(makeSerializedData(), options);

    expect(
      mockedStore.annotationsAPI.deleteMultipleAnnotations,
    ).toHaveBeenCalledWith(["existing-a1", "existing-a2"]);
    expect(mockedPropertyStore.deleteProperty).toHaveBeenCalledWith(
      "existing-p1",
    );
  });

  it("does not delete pre-existing annotations/properties when overwrite options are false", async () => {
    mockedAnnotationStore.annotations = [{ id: "existing-a1" }];
    mockedPropertyStore.properties = [{ id: "existing-p1" }];

    await importAnnotationsFromData(makeSerializedData(), defaultImportOptions);

    expect(
      mockedStore.annotationsAPI.deleteMultipleAnnotations,
    ).not.toHaveBeenCalled();
    expect(mockedPropertyStore.deleteProperty).not.toHaveBeenCalledWith(
      "existing-p1",
    );
  });
});
