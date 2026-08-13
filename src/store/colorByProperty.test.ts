import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// These tests dispatch the REAL Vuex actions (no "@/store" mock) so they
// exercise the actual wiring: saveColorByProperty persisting through
// syncConfiguration, and colorAnnotationIds retiring the legend whenever
// colors are assigned by any other means (the legend-honesty invariant from
// codebaseDocumentation/COLOR_BY_PROPERTY.md).
import main from "./index";
import store from "./root";
import annotationStore from "./annotation";
import girderResources from "./girderResources";
import { exampleConfigurationBase, IColorByPropertyState } from "./model";

// The generated module accessor exposes state as non-configurable getters, so
// state has to be set on the underlying Vuex state directly.
function setLoggedIn(loggedIn: boolean) {
  (store.state as any).main.girderUser = loggedIn ? { _id: "u1" } : null;
}

// colorByProperty is keyed by dataset id in the configuration, because a
// configuration can be shared across datasets while the legend describes one
// dataset's values. Seed it for DATASET_ID and read it back through the store's
// per-dataset getter.
const DATASET_ID = "ds1";

function setConfiguration(colorByProperty: IColorByPropertyState | null) {
  (store.state as any).main.configuration = {
    id: "config1",
    name: "config",
    description: "",
    ...exampleConfigurationBase(),
    colorByProperty: colorByProperty ? { [DATASET_ID]: colorByProperty } : {},
  };
}

function setDataset(id: string | null) {
  (store.state as any).main.dataset = id ? { id } : null;
}

const legendFixture: IColorByPropertyState = {
  type: "continuous",
  propertyPath: ["prop1"],
  propertyName: "Prop 1",
  colormap: "viridis",
  stops: ["#440154", "#fde725"],
  min: 0,
  max: 10,
  showLegend: true,
};

describe("color-by-property configuration persistence", () => {
  let updateConfigurationKey: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setLoggedIn(true);
    setDataset(DATASET_ID);
    updateConfigurationKey = vi.fn(async () => ({}));
    (main as any).api.updateConfigurationKey = updateConfigurationKey;
  });

  afterEach(() => {
    setConfiguration(null);
    setDataset(null);
    setLoggedIn(false);
    (store.state as any).annotation.stubOnlyMode = false;
    (store.state as any).annotation.annotationStubs = new Map();
    vi.restoreAllMocks();
  });

  it("saveColorByProperty stores the legend and syncs the key", async () => {
    setConfiguration(null);
    await main.saveColorByProperty(legendFixture);
    expect(main.colorByPropertyForCurrentDataset).toEqual(legendFixture);
    // Stored under this dataset's key, not as a single shared slot.
    expect((store.state as any).main.configuration.colorByProperty).toEqual({
      [DATASET_ID]: legendFixture,
    });
    expect(updateConfigurationKey).toHaveBeenCalledTimes(1);
    expect(updateConfigurationKey.mock.calls[0][1]).toBe("colorByProperty");
  });

  // colorAnnotationIds only retires the legend when it actually recolours
  // something, so these tests need an annotation that really gets patched.
  function seedPatchableStub(color: string | null = null) {
    (store.state as any).annotation.stubOnlyMode = true;
    (store.state as any).annotation.annotationStubs = new Map([
      [
        "a1",
        {
          id: "a1",
          color,
          tags: [],
          shape: "point",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 0 },
          centroid: { x: 0, y: 0 },
          estimatedRadius: 1,
        },
      ],
    ]);
    return vi
      .spyOn(annotationStore.annotationsAPI as any, "updateAnnotations")
      .mockResolvedValue([]);
  }

  it("colorAnnotationIds clears an active legend", async () => {
    setConfiguration(legendFixture);
    const updateAnnotations = seedPatchableStub();
    await annotationStore.colorAnnotationIds({
      annotationIds: ["a1"],
      color: "#ff0000",
    });
    expect(updateAnnotations).toHaveBeenCalled();
    expect(main.colorByPropertyForCurrentDataset).toBeNull();
    expect(updateConfigurationKey).toHaveBeenCalledTimes(1);
    expect(updateConfigurationKey.mock.calls[0][1]).toBe("colorByProperty");
  });

  it("keeps the legend when the recolor patches nothing", async () => {
    // "Color Selected" with an empty selection, or a color every target
    // already has, writes nothing — deleting the legend then would leave the
    // canvas correctly colored by the property with nothing explaining it.
    setConfiguration(legendFixture);
    const updateAnnotations = seedPatchableStub("#ff0000");

    await annotationStore.colorAnnotationIds({
      annotationIds: [],
      color: "#ff0000",
    });
    // Same color the stub already has -> no patch.
    await annotationStore.colorAnnotationIds({
      annotationIds: ["a1"],
      color: "#ff0000",
    });

    expect(updateAnnotations).not.toHaveBeenCalled();
    expect(main.colorByPropertyForCurrentDataset).toEqual(legendFixture);
    expect(updateConfigurationKey).not.toHaveBeenCalled();
  });

  it("keeps the legend when not logged in", async () => {
    setConfiguration(legendFixture);
    seedPatchableStub();
    setLoggedIn(false);
    await annotationStore.colorAnnotationIds({
      annotationIds: ["a1"],
      color: "#ff0000",
    });
    expect(main.colorByPropertyForCurrentDataset).toEqual(legendFixture);
    expect(updateConfigurationKey).not.toHaveBeenCalled();
  });

  it("colorAnnotationIds does not write the configuration when no legend is active", async () => {
    setConfiguration(null);
    await annotationStore.colorAnnotationIds({
      annotationIds: ["a1"],
      color: "#ff0000",
    });
    expect(updateConfigurationKey).not.toHaveBeenCalled();
  });

  it("a dataset+configuration switch mid-recolor still retires the captured configuration's legend", async () => {
    // The recolor changed ds1's colors, so ds1's legend is wrong no matter
    // what is open when the write completes. Bailing entirely (the old
    // behavior) left the stale legend to reappear on ds1's next load; the
    // guard must protect the NEWLY opened configuration, not abandon the
    // captured one.
    setConfiguration(legendFixture);
    const capturedConfiguration = (store.state as any).main.configuration;
    seedPatchableStub().mockImplementation(async () => {
      // Simulate the user switching while the write is in flight.
      (store.state as any).main.dataset = { id: "ds2" };
      (store.state as any).main.configuration = {
        ...capturedConfiguration,
        id: "config2",
        colorByProperty: {},
      };
      return [];
    });
    const getConfiguration = vi.fn().mockResolvedValue(capturedConfiguration);
    (girderResources as any).getConfiguration = getConfiguration;

    await annotationStore.colorAnnotationIds({
      annotationIds: ["a1"],
      color: "#ff0000",
    });

    // The captured configuration was fetched and written back without ds1's
    // legend...
    expect(getConfiguration).toHaveBeenCalledWith("config1");
    expect(updateConfigurationKey).toHaveBeenCalledTimes(1);
    const [written, key] = updateConfigurationKey.mock.calls[0];
    expect(key).toBe("colorByProperty");
    expect(written.id).toBe("config1");
    expect(written.colorByProperty).toEqual({});
    // ...and the newly opened configuration was left alone.
    expect((store.state as any).main.configuration.id).toBe("config2");
    expect((store.state as any).main.configuration.colorByProperty).toEqual({});
  });

  it("a dataset switch under the SAME configuration retires the captured dataset's legend only", async () => {
    // A configuration is reusable across datasets, so the switch can keep
    // config1 open while the legend being retired belongs to ds1. The write
    // must target ds1's slot, not the now-current dataset's.
    setConfiguration(legendFixture);
    const otherLegend = { ...legendFixture, propertyName: "Prop 2" };
    (store.state as any).main.configuration.colorByProperty.ds2 = otherLegend;
    seedPatchableStub().mockImplementation(async () => {
      (store.state as any).main.dataset = { id: "ds2" };
      return [];
    });

    await annotationStore.colorAnnotationIds({
      annotationIds: ["a1"],
      color: "#ff0000",
    });

    expect(updateConfigurationKey).toHaveBeenCalledTimes(1);
    expect((store.state as any).main.configuration.colorByProperty).toEqual({
      ds2: otherLegend,
    });
  });
});

describe("applyColorByProperty / removeColorByProperty store actions", () => {
  let updateConfigurationKey: ReturnType<typeof vi.fn>;
  let colorByPropertyApi: ReturnType<typeof vi.spyOn>;
  let clearColorByPropertyApi: ReturnType<typeof vi.spyOn>;
  let getAnnotationCount: ReturnType<typeof vi.spyOn>;

  const legendResponse = {
    colored: 2,
    uncolored: 0,
    legend: {
      type: "continuous" as const,
      propertyPath: ["prop1"],
      colormap: "viridis",
      stops: ["#440154", "#fde725"],
      min: 0,
      max: 10,
    },
    assignment: [{ color: "#440154", ids: ["a1", "a2"] }],
  };

  beforeEach(() => {
    setLoggedIn(true);
    setConfiguration(null);
    setDataset(DATASET_ID);
    updateConfigurationKey = vi.fn(async () => ({}));
    (main as any).api.updateConfigurationKey = updateConfigurationKey;

    const api = annotationStore.annotationsAPI as any;
    colorByPropertyApi = vi
      .spyOn(api, "colorByProperty")
      .mockResolvedValue(legendResponse);
    clearColorByPropertyApi = vi
      .spyOn(api, "clearColorByProperty")
      .mockResolvedValue({ colored: 0, uncolored: 2, legend: null });
    // fetchAnnotations' first backend call — its invocation is the signal
    // that the refetch ran. The remaining calls resolve to empty data.
    getAnnotationCount = vi
      .spyOn(api, "getAnnotationCount")
      .mockResolvedValue(0);
    vi.spyOn(api, "getAnnotationsForDatasetId").mockResolvedValue([]);
    vi.spyOn(api, "getConnectionsForDatasetId").mockResolvedValue([]);
  });

  afterEach(() => {
    setDataset(null);
    setConfiguration(null);
    setLoggedIn(false);
    vi.restoreAllMocks();
  });

  it("apply posts the mapping, persists the legend, and applies colors locally", async () => {
    (store.state as any).annotation.annotationStubs = new Map([
      ["a1", { id: "a1", color: null, tags: [] }],
      ["a2", { id: "a2", color: null, tags: [] }],
    ]);
    const result = await annotationStore.applyColorByProperty({
      propertyPath: ["prop1"],
      propertyName: "Prop 1",
      mode: "continuous",
      colormap: "viridis",
      rangeMin: 1,
    });
    expect(result).toEqual(legendResponse);
    expect(colorByPropertyApi).toHaveBeenCalledWith({
      datasetId: "ds1",
      propertyPath: ["prop1"],
      mode: "continuous",
      colormap: "viridis",
      rangeMin: 1,
      rangeMax: undefined,
    });
    const persisted = main.colorByPropertyForCurrentDataset;
    expect(persisted).toMatchObject({
      ...legendResponse.legend,
      propertyName: "Prop 1",
      showLegend: true,
    });
    expect(updateConfigurationKey.mock.calls[0][1]).toBe("colorByProperty");
    // The returned assignment replaces the full refetch (12.8s on a 708K
    // dataset). getAnnotationCount is fetchAnnotations' first backend call,
    // so its absence proves the refetch was skipped.
    expect(getAnnotationCount).not.toHaveBeenCalled();
    expect(annotationStore.annotationStubs.get("a1")?.color).toBe("#440154");
  });

  it("a dataset switch mid-request applies nothing locally but persists the captured dataset's legend", async () => {
    // Coloring 700K annotations takes ~10s; the user can switch datasets in
    // that window. The assignment's ids belong to the OLD dataset, so applying
    // it would null every color in the new one — but the backend DID recolor
    // the captured dataset, so its legend must still be persisted to its own
    // slot: an older property coloring's legend left standing would describe
    // colors the dataset no longer has.
    (store.state as any).annotation.annotationStubs = new Map([
      ["other1", { id: "other1", color: "#eeeeee", tags: [] }],
    ]);
    colorByPropertyApi.mockImplementation(async () => {
      // The switch happens while the request is in flight (same
      // configuration — it is reusable across datasets).
      setDataset("ds2");
      return legendResponse;
    });

    await annotationStore.applyColorByProperty({
      propertyPath: ["prop1"],
      propertyName: "Prop 1",
    });

    // The other dataset's loaded colors are untouched...
    expect(annotationStore.annotationStubs.get("other1")?.color).toBe(
      "#eeeeee",
    );
    // ...the current (new) dataset's slot stays empty while the CAPTURED
    // dataset's slot carries the new legend...
    expect(main.colorByPropertyForCurrentDataset).toBeNull();
    expect(updateConfigurationKey).toHaveBeenCalledTimes(1);
    expect(
      (store.state as any).main.configuration.colorByProperty[DATASET_ID],
    ).toMatchObject({ ...legendResponse.legend, propertyName: "Prop 1" });
    // ...and it did not refetch the new dataset either.
    expect(getAnnotationCount).not.toHaveBeenCalled();
  });

  it("a configuration switch mid-apply writes the legend to the captured configuration", async () => {
    // The switched-away configuration has no live store copy, so the legend
    // goes through the direct PUT path — same machinery as manual-recolor
    // retirement, opposite direction (writing a legend, not pruning one).
    const capturedConfiguration = (store.state as any).main.configuration;
    colorByPropertyApi.mockImplementation(async () => {
      setDataset("ds2");
      (store.state as any).main.configuration = {
        ...capturedConfiguration,
        id: "config2",
        colorByProperty: {},
      };
      return legendResponse;
    });
    const getConfiguration = vi.fn().mockResolvedValue(capturedConfiguration);
    (girderResources as any).getConfiguration = getConfiguration;

    await annotationStore.applyColorByProperty({
      propertyPath: ["prop1"],
      propertyName: "Prop 1",
    });

    expect(getConfiguration).toHaveBeenCalledWith("config1");
    expect(updateConfigurationKey).toHaveBeenCalledTimes(1);
    const [written, key] = updateConfigurationKey.mock.calls[0];
    expect(key).toBe("colorByProperty");
    expect(written.id).toBe("config1");
    expect(written.colorByProperty[DATASET_ID]).toMatchObject({
      ...legendResponse.legend,
      propertyName: "Prop 1",
      showLegend: true,
    });
    // The newly opened configuration was left alone.
    expect((store.state as any).main.configuration.colorByProperty).toEqual({});
  });

  it("a dataset switch mid-clear nulls nothing locally but retires the captured dataset's legend", async () => {
    setConfiguration(legendFixture);
    (store.state as any).annotation.annotationStubs = new Map([
      ["other1", { id: "other1", color: "#eeeeee", tags: [] }],
    ]);
    clearColorByPropertyApi.mockImplementation(async () => {
      setDataset("ds2");
      return { colored: 0, uncolored: 2, legend: null };
    });

    await annotationStore.removeColorByProperty();

    expect(annotationStore.annotationStubs.get("other1")?.color).toBe(
      "#eeeeee",
    );
    expect(getAnnotationCount).not.toHaveBeenCalled();
    // The backend cleared the captured dataset's colors, so its legend must
    // not stay behind claiming they come from a property mapping.
    expect(updateConfigurationKey).toHaveBeenCalledTimes(1);
    expect((store.state as any).main.configuration.colorByProperty).toEqual({});
  });

  it("falls back to a full refetch when no assignment comes back", async () => {
    // A backend that didn't include the assignment (returnAssignment ignored)
    // must not leave the canvas showing pre-recolor colors.
    colorByPropertyApi.mockResolvedValue({
      ...legendResponse,
      assignment: undefined,
    });
    await annotationStore.applyColorByProperty({
      propertyPath: ["prop1"],
      propertyName: "Prop 1",
    });
    expect(getAnnotationCount).toHaveBeenCalled();
  });

  it("a 400 rejection propagates unwrapped and skips the refetch", async () => {
    const rejection = {
      response: { status: 400, data: { message: "bad range" } },
    };
    colorByPropertyApi.mockRejectedValue(rejection);
    let caught: unknown = null;
    try {
      await annotationStore.applyColorByProperty({
        propertyPath: ["prop1"],
        propertyName: "Prop 1",
      });
    } catch (error) {
      caught = error;
    }
    // Identity check: with rawError missing, vuex-module-decorators would
    // substitute a generic Error and the dialog would lose the real message.
    expect(caught).toBe(rejection);
    // A 400 is rejected at validation, before the backend's clearing pass —
    // nothing changed, so no (potentially large) refetch.
    expect(getAnnotationCount).not.toHaveBeenCalled();
    expect(main.colorByPropertyForCurrentDataset).toBeNull();
  });

  it("a non-400 failure still refetches (the backend may have recolored)", async () => {
    colorByPropertyApi.mockRejectedValue({ response: { status: 500 } });
    await expect(
      annotationStore.applyColorByProperty({
        propertyPath: ["prop1"],
        propertyName: "Prop 1",
      }),
    ).rejects.toBeTruthy();
    expect(getAnnotationCount).toHaveBeenCalled();
  });

  it("remove clears backend colors, retires the legend, and nulls colors locally", async () => {
    setConfiguration(legendFixture);
    (store.state as any).annotation.annotationStubs = new Map([
      ["a1", { id: "a1", color: "#440154", tags: [] }],
    ]);
    await annotationStore.removeColorByProperty();
    expect(clearColorByPropertyApi).toHaveBeenCalledWith("ds1");
    expect(main.colorByPropertyForCurrentDataset).toBeNull();
    expect(updateConfigurationKey.mock.calls[0][1]).toBe("colorByProperty");
    // Clearing needs no refetch either: an empty assignment nulls everything.
    expect(getAnnotationCount).not.toHaveBeenCalled();
    expect(annotationStore.annotationStubs.get("a1")?.color).toBeNull();
  });
});
