import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/fetch", () => ({
  fetchAllPages: vi.fn(),
}));

vi.mock("@/store/progress", () => ({
  default: {},
}));

import GirderAPI, { setBaseCollectionValues } from "./GirderAPI";
import { DEFAULT_VISIBILITY_CONFIG, type IDatasetConfiguration } from "./model";

function makeConfiguration(
  visibilityConfig = { ...DEFAULT_VISIBILITY_CONFIG },
): IDatasetConfiguration {
  return {
    id: "configuration-1",
    name: "Configuration",
    description: "",
    compatibility: {
      xyDimensions: "multiple",
      zDimensions: "multiple",
      tDimensions: "multiple",
      channels: {},
    },
    layers: [],
    tools: [],
    snapshots: [],
    propertyIds: [],
    pipelines: [],
    scales: {
      pixelSize: { value: 1, unit: "m" },
      zStep: { value: 1, unit: "m" },
      tStep: { value: 1, unit: "s" },
    },
    visibilityConfig,
  };
}

describe("configuration visibility metadata", () => {
  it("hydrates persisted visibility settings over shipped defaults", () => {
    const persisted = {
      maxVisible: 75000,
      globalThreshold: false,
    };

    const configuration = setBaseCollectionValues({
      _id: "configuration-1",
      name: "Configuration",
      description: "",
      meta: { visibilityConfig: persisted },
    } as any);

    expect(configuration.visibilityConfig).toEqual({
      ...DEFAULT_VISIBILITY_CONFIG,
      ...persisted,
    });
  });

  it("falls back to shipped defaults for older configurations", () => {
    const configuration = setBaseCollectionValues({
      _id: "configuration-1",
      name: "Configuration",
      description: "",
      meta: {},
    } as any);

    expect(configuration.visibilityConfig).toEqual(DEFAULT_VISIBILITY_CONFIG);
    expect(configuration.visibilityConfig).not.toBe(DEFAULT_VISIBILITY_CONFIG);
  });

  it("serializes visibility settings through the configuration sync API", async () => {
    const client = {
      put: vi.fn().mockResolvedValue({ data: {} }),
    } as any;
    const api = new GirderAPI(client);
    const configuration = makeConfiguration({
      ...DEFAULT_VISIBILITY_CONFIG,
      coverageTarget: 0.5,
    });

    await api.updateConfigurationKey(configuration, "visibilityConfig");

    const formData = client.put.mock.calls[0][1] as FormData;
    expect(client.put).toHaveBeenCalledWith(
      "upenn_collection/configuration-1/metadata",
      expect.any(FormData),
    );
    expect(JSON.parse(formData.get("metadata") as string)).toEqual({
      visibilityConfig: configuration.visibilityConfig,
    });
  });
});
