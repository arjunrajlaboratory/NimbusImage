// Real-store regressions for table replacement and in-flight value reads.
import { beforeEach, expect, it, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  dataset: { id: "dataset-a" },
  annotation: {
    stubOnlyMode: true,
    visibleAnnotationIds: new Set(["a"]),
    allAnnotationIds: ["a"],
  },
  values: vi.fn(),
  allValues: vi.fn(),
}));
vi.mock("@/store/index", () => ({
  default: {
    dataset: mocks.dataset,
    isLoggedIn: true,
    propertiesAPI: {
      getPropertyValuesForIds: mocks.values,
      getPropertyValues: mocks.allValues,
    },
    spatialAPI: {
      fetchVersions: vi.fn().mockResolvedValue({
        active: { itemId: "new", label: "new", nObs: 1, nVar: 1 },
        versions: [],
      }),
      fetchStaleness: vi.fn().mockResolvedValue({ upToDate: true }),
    },
    scheduleAnnotationBrowserSave: vi.fn(),
  },
}));
vi.mock("@/store/annotation", () => ({ default: mocks.annotation }));
vi.mock("@/store/spatial", () => ({
  default: {
    hasTable: true,
    refreshInfo: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@/store/jobs", () => ({
  default: {},
  createProgressEventCallback: vi.fn(),
  createErrorEventCallback: vi.fn(),
}));
vi.mock("@/store/progress", () => ({
  default: { create: vi.fn(), complete: vi.fn() },
}));
vi.mock("@/utils/log", () => ({ logError: vi.fn(), logWarning: vi.fn() }));
vi.mock("geojs", () => ({ default: { util: {} } }));

import properties from "@/store/properties";
import CellTableCard from "@/components/CellTableCard.vue";

beforeEach(() => {
  mocks.dataset.id = "dataset-a";
  mocks.annotation.stubOnlyMode = true;
  mocks.values
    .mockReset()
    .mockResolvedValue([
      { annotationId: "a", values: { spatial: { CD3E: 9 } } },
    ]);
  properties.resetPropertyState();
  properties.hydrateDisplayedPropertyPaths([["spatial", "CD3E"]]);
  properties.updatePropertyValues({ a: { spatial: { CD3E: 1 } } });
});

it("table activation refreshes existing virtual values in stub mode", async () => {
  const card = shallowMount(CellTableCard, { props: { visible: false } });
  await (card.vm as any).onRecomputed();
  properties.ensureVisiblePropertyValues();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(properties.propertyValues.a.spatial).toEqual({ CD3E: 9 });
  card.unmount();
});

it("table activation invalidates gate results in wholesale mode", async () => {
  mocks.annotation.stubOnlyMode = false;
  const before = properties.propertyValuesRevision;
  const card = shallowMount(CellTableCard, { props: { visible: false } });
  await (card.vm as any).onRecomputed();
  expect(properties.propertyValues.a.spatial).toEqual({ CD3E: 9 });
  expect(properties.propertyValuesRevision).toBeGreaterThan(before);
  card.unmount();
});

it("a delayed virtual fetch cannot repopulate a different dataset", async () => {
  mocks.annotation.stubOnlyMode = false;
  let resolve!: (value: unknown) => void;
  mocks.values.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = properties.fetchVirtualPropertyValues();
  mocks.dataset.id = "dataset-b";
  properties.resetPropertyState();
  properties.updatePropertyValues({});
  resolve([{ annotationId: "a", values: { spatial: { CD3E: 9 } } }]);
  await pending;
  expect(properties.propertyValues).toEqual({});
});

it("a delayed old-table response cannot overwrite the new table", async () => {
  mocks.annotation.stubOnlyMode = false;
  let resolve!: (value: unknown) => void;
  mocks.values.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const oldRequest = properties.fetchVirtualPropertyValues();
  await properties.refreshVirtualPropertyValues();
  resolve([{ annotationId: "a", values: { spatial: { CD3E: 1 } } }]);
  await oldRequest;
  expect(properties.propertyValues.a.spatial).toEqual({ CD3E: 9 });
});

it("table activation does not discard an in-flight ordinary value load", async () => {
  mocks.annotation.stubOnlyMode = false;
  let resolve!: (value: unknown) => void;
  mocks.allValues.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const ordinary = properties.fetchAllPropertyValues();
  await properties.refreshVirtualPropertyValues();
  resolve({ a: { ordinary: 7 } });
  await ordinary;
  expect(properties.propertyValues.a).toEqual({
    ordinary: 7,
    spatial: { CD3E: 9 },
  });
});
