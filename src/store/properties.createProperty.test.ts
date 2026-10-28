import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import propertyStore from "./properties";
import main from "./index";
import store from "./root";
import filters from "./filters";

// Regression tests for the create_property error chain (issue #1239, Codex P2
// on PR #1262).
//
// The AI panel wraps propertyStore.createProperty and reports the failure
// reason to the user. That error crosses FOUR @Action boundaries:
//
//   createProperty -> setProperties -> updateConfigurationProperties
//                                   -> syncConfiguration
//
// vuex-module-decorators replaces a thrown error with a generic
// ERR_ACTION_ACCESS_UNDEFINED message at EVERY boundary that lacks
// { rawError: true }, so all four need it. These tests dispatch the REAL
// actions: the executors test mocks createProperty, which bypasses the
// decorator entirely and cannot catch this.

// `.rejects.toThrow(/regex/)` is a substring match, and the wrapper embeds the
// original error's `.stack` (which contains its message) inside its own
// message -- so a substring assertion passes even when rawError is missing.
// Assert the exact message instead. Same helper as index.test.ts.
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the promise to reject, but it resolved");
}

// Which configuration's fetch filled the loaded property list.
function setListConfiguration(configurationId: string | null) {
  (
    propertyStore as unknown as {
      setPropertiesConfigurationId: (id: string | null) => void;
    }
  ).setPropertiesConfigurationId(configurationId);
}

function setLoggedIn(loggedIn: boolean) {
  (store.state as any).main.girderUser = loggedIn ? { _id: "u1" } : null;
}

describe("createProperty propagates the real failure reason", () => {
  beforeEach(() => {
    setLoggedIn(true);
    (main as any).setConfigurationImpl({
      id: "c1",
      data: {
        id: "c1",
        name: "config",
        layers: [],
        tools: [],
        scales: {},
        propertyIds: [],
      } as any,
    });
    // As if c1's properties fetch had landed: setProperties saves only a
    // list a fetch loaded for the loaded configuration.
    setListConfiguration("c1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setListConfiguration(null);
  });

  it("surfaces the backend's message when the property POST fails", async () => {
    vi.spyOn(propertyStore.propertiesAPI, "createProperty").mockRejectedValue(
      new Error("Property name already in use"),
    );

    expect(
      await messageOf(propertyStore.createProperty({ name: "area" } as any)),
    ).toBe("Property name already in use");
  });

  it("surfaces the backend's message when the propertyIds sync fails", async () => {
    // The POST succeeds, then persisting propertyIds to the configuration
    // fails -- the error crosses all four action boundaries.
    vi.spyOn(propertyStore.propertiesAPI, "createProperty").mockResolvedValue({
      id: "p1",
      name: "area",
    } as any);
    vi.spyOn(main.api, "updateConfigurationKey").mockRejectedValue(
      new Error("Read-only collection"),
    );

    expect(
      await messageOf(propertyStore.createProperty({ name: "area" } as any)),
    ).toBe("Read-only collection");
  });

  it("rolls the property list back when the sync fails", async () => {
    const before = propertyStore.properties.length;
    vi.spyOn(propertyStore.propertiesAPI, "createProperty").mockResolvedValue({
      id: "p1",
      name: "area",
    } as any);
    vi.spyOn(main.api, "updateConfigurationKey").mockRejectedValue(
      new Error("Read-only collection"),
    );

    await messageOf(propertyStore.createProperty({ name: "area" } as any));
    expect(propertyStore.properties.length).toBe(before);
  });

  it("registers nothing when another configuration opens during the create request", async () => {
    // The previous configuration's list is still loaded when the request
    // returns (the new one's fetch lands later).
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([{ id: "from-c1", name: "Area" }]);
    vi.spyOn(propertyStore.propertiesAPI, "createProperty").mockImplementation(
      async () => {
        (main as any).setConfigurationImpl({
          id: "c2",
          data: {
            id: "c2",
            name: "other",
            layers: [],
            tools: [],
            scales: {},
            propertyIds: ["from-c2"],
          } as any,
        });
        return { id: "p1", name: "area" } as any;
      },
    );
    const sync = vi
      .spyOn(main.api, "updateConfigurationKey")
      .mockResolvedValue({} as any);

    expect(
      await messageOf(propertyStore.createProperty({ name: "area" } as any)),
    ).toContain("Another configuration was opened");
    // c1's list is not saved as c2's propertyIds.
    expect(sync).not.toHaveBeenCalled();
    expect(main.configuration!.propertyIds).toEqual(["from-c2"]);
    expect(propertyStore.properties.map((p) => p.id)).toEqual(["from-c1"]);
  });

  it("refuses to save a property list loaded for another configuration", async () => {
    // c1's list is loaded, then c2 opens and its fetch has not landed yet.
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([{ id: "from-c1", name: "Area" }]);
    setListConfiguration("c1");
    (main as any).setConfigurationImpl({
      id: "c2",
      data: {
        id: "c2",
        name: "other",
        layers: [],
        tools: [],
        scales: {},
        propertyIds: ["from-c2"],
      } as any,
    });
    const sync = vi
      .spyOn(main.api, "updateConfigurationKey")
      .mockResolvedValue({} as any);

    expect(await messageOf(propertyStore.deleteProperty("from-c1"))).toContain(
      "have not loaded",
    );
    expect(sync).not.toHaveBeenCalled();
    expect(main.configuration!.propertyIds).toEqual(["from-c2"]);
  });

  it("refuses to save a property list no fetch has loaded", async () => {
    // c1's fetch never landed (still loading, or it failed), then c2 opens
    // before its own fetch lands: the loaded list belongs to neither.
    setListConfiguration(null);
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([]);
    (main as any).setConfigurationImpl({
      id: "c2",
      data: {
        id: "c2",
        name: "other",
        layers: [],
        tools: [],
        scales: {},
        propertyIds: ["from-c2"],
      } as any,
    });
    vi.spyOn(propertyStore.propertiesAPI, "createProperty").mockResolvedValue({
      id: "p1",
      name: "area",
    } as any);
    const sync = vi
      .spyOn(main.api, "updateConfigurationKey")
      .mockResolvedValue({} as any);

    expect(
      await messageOf(propertyStore.createProperty({ name: "area" } as any)),
    ).toContain("have not loaded");
    // Saving would have replaced c2's properties with just the new one.
    expect(sync).not.toHaveBeenCalled();
    expect(main.configuration!.propertyIds).toEqual(["from-c2"]);
  });

  it("saves a property list loaded for the loaded configuration", async () => {
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([
      { id: "p1", name: "Area" },
      { id: "p2", name: "Perimeter" },
    ]);
    const sync = vi
      .spyOn(main.api, "updateConfigurationKey")
      .mockResolvedValue({} as any);

    await propertyStore.deleteProperty("p1");

    expect(sync).toHaveBeenCalledTimes(1);
    expect(main.configuration!.propertyIds).toEqual(["p2"]);
  });

  it("does not reconcile another configuration's plots after a switch during the save", async () => {
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([{ id: "p1", name: "Area" }]);
    vi.spyOn(main.api, "updateConfigurationKey").mockImplementation(
      async () => {
        (main as any).setConfigurationImpl({
          id: "c2",
          data: { id: "c2", propertyIds: [] } as any,
        });
        return {} as any;
      },
    );
    const reconcile = vi.spyOn(filters, "reconcileAnalysisPlotsForPropertyIds");

    await propertyStore.deleteProperty("p1");

    expect(reconcile).not.toHaveBeenCalled();
  });

  it("keeps a list another configuration's fetch loaded during a failed save", async () => {
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([
      { id: "p1", name: "Area" },
      { id: "p2", name: "Perimeter" },
    ]);
    const put = vi.spyOn(main.api, "updateConfigurationKey");
    put.mockImplementationOnce(async () => {
      // c2 opens and its properties fetch lands before c1's save fails.
      (main as any).setConfigurationImpl({
        id: "c2",
        data: {
          id: "c2",
          name: "other",
          layers: [],
          tools: [],
          scales: {},
          propertyIds: ["from-c2"],
        } as any,
      });
      (
        propertyStore as unknown as {
          setPropertiesImpl: (
            properties: { id: string; name: string }[],
          ) => void;
        }
      ).setPropertiesImpl([{ id: "from-c2", name: "Count" }]);
      setListConfiguration("c2");
      throw new Error("Read-only collection");
    });

    await messageOf(propertyStore.deleteProperty("p1"));

    // Not rolled back over c2's list.
    expect(propertyStore.properties.map((p) => p.id)).toEqual(["from-c2"]);
    expect(propertyStore.propertiesConfigurationId).toBe("c2");
    // So a later save on c2 writes c2's ids, not c1's.
    put.mockResolvedValue({} as any);
    await propertyStore.deleteProperties([]);
    expect(put).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "c2" }),
      "propertyIds",
    );
    expect(main.configuration!.propertyIds).toEqual(["from-c2"]);
  });

  it("restores the configuration's propertyIds when the save fails", async () => {
    (main as any).configuration.propertyIds = ["p1", "p2"];
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([
      { id: "p1", name: "Area" },
      { id: "p2", name: "Perimeter" },
    ]);
    vi.spyOn(main.api, "updateConfigurationKey").mockRejectedValue(
      new Error("Read-only collection"),
    );

    await messageOf(propertyStore.deleteProperty("p1"));

    expect(main.configuration!.propertyIds).toEqual(["p1", "p2"]);
    expect(propertyStore.properties.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("keeps a later save's propertyIds when an earlier overlapping save fails", async () => {
    (main as any).configuration.propertyIds = ["p1", "p2", "p3"];
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([
      { id: "p1", name: "Area" },
      { id: "p2", name: "Perimeter" },
      { id: "p3", name: "Count" },
    ]);
    let failFirst!: (error: Error) => void;
    vi.spyOn(main.api, "updateConfigurationKey")
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failFirst = reject;
          }),
      )
      .mockResolvedValue({} as any);

    const first = messageOf(propertyStore.deleteProperty("p1"));
    await propertyStore.deleteProperty("p2");
    failFirst(new Error("Read-only collection"));
    await first;

    // The second save's ids and list stand; the first's rollback is moot.
    expect(main.configuration!.propertyIds).toEqual(["p3"]);
    expect(propertyStore.properties.map((p) => p.id)).toEqual(["p3"]);
  });

  // Two overlapping deletes, neither of which reaches the server, failing in
  // the given order.
  async function failTwoOverlappingDeletes(failOrder: number[]) {
    (main as any).configuration.propertyIds = ["p1", "p2", "p3"];
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([
      { id: "p1", name: "Area" },
      { id: "p2", name: "Perimeter" },
      { id: "p3", name: "Count" },
    ]);
    const fails: ((error: Error) => void)[] = [];
    vi.spyOn(main.api, "updateConfigurationKey").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fails.push(reject);
        }),
    );

    const first = messageOf(propertyStore.deleteProperty("p1"));
    const second = messageOf(propertyStore.deleteProperty("p2"));
    for (const index of failOrder) {
      fails[index](new Error("Read-only collection"));
      await (index === 0 ? first : second);
    }

    // Neither delete reached the server: both stores show all three.
    expect(main.configuration!.propertyIds).toEqual(["p1", "p2", "p3"]);
    expect(propertyStore.properties.map((p) => p.id)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
  }

  it("restores what the server holds when overlapping saves both fail (earlier first)", async () => {
    await failTwoOverlappingDeletes([0, 1]);
  });

  it("restores what the server holds when overlapping saves both fail (out of order)", async () => {
    await failTwoOverlappingDeletes([1, 0]);
  });

  it("ends on an earlier save's value when a later save fails before it is sent", async () => {
    (main as any).configuration.propertyIds = ["p1", "p2", "p3"];
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([
      { id: "p1", name: "Area" },
      { id: "p2", name: "Perimeter" },
      { id: "p3", name: "Count" },
    ]);
    let finishFirst!: (value: any) => void;
    vi.spyOn(main.api, "updateConfigurationKey")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      // Fails at once, while the first is still in flight (as a save does
      // when the session expired, before it reaches the API's queue).
      .mockRejectedValueOnce(new Error("Not logged in"));

    const first = propertyStore.deleteProperty("p1");
    await messageOf(propertyStore.deleteProperty("p2"));
    finishFirst({});
    await first;

    // The server holds the first delete only.
    expect(main.configuration!.propertyIds).toEqual(["p2", "p3"]);
    expect(propertyStore.properties.map((p) => p.id)).toEqual(["p2", "p3"]);
  });

  it("restores onto the reloaded configuration after a switch away and back", async () => {
    (main as any).configuration.propertyIds = ["p1", "p2"];
    const both = [
      { id: "p1", name: "Area" },
      { id: "p2", name: "Perimeter" },
    ];
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl(both);
    let failFirst!: (error: Error) => void;
    vi.spyOn(main.api, "updateConfigurationKey")
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failFirst = reject;
          }),
      )
      .mockResolvedValue({} as any);

    const first = messageOf(propertyStore.deleteProperty("p1"));
    // Away and back: c1 is reloaded from the server as a new object, and its
    // properties fetch lands.
    (main as any).setConfigurationImpl({
      id: "c1",
      data: {
        id: "c1",
        name: "config",
        layers: [],
        tools: [],
        scales: {},
        propertyIds: ["p1", "p2"],
      } as any,
    });
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl(both);
    const second = propertyStore.deleteProperty("p2");
    failFirst(new Error("Read-only collection"));
    await first;
    await second;

    // The server holds the second delete only.
    expect(main.configuration!.propertyIds).toEqual(["p1"]);
    expect(propertyStore.properties.map((p) => p.id)).toEqual(["p1"]);
  });

  it("rebuilds another configuration's list when its save fails while one on the first is pending", async () => {
    (main as any).configuration.propertyIds = ["p1", "p2"];
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([
      { id: "p1", name: "Area" },
      { id: "p2", name: "Perimeter" },
    ]);
    let finishC1!: (value: any) => void;
    vi.spyOn(main.api, "updateConfigurationKey").mockImplementation(
      async (configuration: any) => {
        if (configuration.id === "c1") {
          return new Promise((resolve) => {
            finishC1 = resolve;
          });
        }
        throw new Error("Read-only collection");
      },
    );

    const c1Save = propertyStore.deleteProperty("p1");
    // c2 opens and its properties load while c1's save is pending.
    (main as any).setConfigurationImpl({
      id: "c2",
      data: {
        id: "c2",
        name: "other",
        layers: [],
        tools: [],
        scales: {},
        propertyIds: ["q1", "q2"],
      } as any,
    });
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([
      { id: "q1", name: "Count" },
      { id: "q2", name: "Mean" },
    ]);
    setListConfiguration("c2");
    // c2's save fails first, then c1's succeeds.
    await messageOf(propertyStore.deleteProperty("q1"));
    finishC1({});
    await c1Save;

    // c2's delete never reached the server: its list matches its ids.
    expect(main.configuration!.propertyIds).toEqual(["q1", "q2"]);
    expect(propertyStore.properties.map((p) => p.id)).toEqual(["q1", "q2"]);
  });

  it("rebuilds the list from the restored ids when a fetch landed during a failed save", async () => {
    (main as any).configuration.propertyIds = ["p1", "p2"];
    const both = [
      { id: "p1", name: "Area" },
      { id: "p2", name: "Perimeter" },
    ];
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl(both);
    vi.spyOn(main.api, "updateConfigurationKey").mockImplementation(
      async () => {
        // A fetch of the same configuration reads the not-yet-saved ids
        // (p1 deleted) and replaces the list with them.
        (
          propertyStore as unknown as {
            setPropertiesImpl: (
              properties: { id: string; name: string }[],
            ) => void;
          }
        ).setPropertiesImpl([both[1]]);
        throw new Error("Read-only collection");
      },
    );

    await messageOf(propertyStore.deleteProperty("p1"));

    // The delete failed, so the list matches the restored ids again.
    expect(main.configuration!.propertyIds).toEqual(["p1", "p2"]);
    expect(propertyStore.properties.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("reconciles plots immediately after deleting an attached property", async () => {
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([
      { id: "deleted", name: "Deleted" },
      { id: "kept", name: "Kept" },
    ]);
    const gate = {
      categoryKeyVersion: 1 as const,
      vertices: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      xCategories: null,
      yCategories: null,
    };
    filters.hydrateAnalysisPlots([
      {
        id: "p1",
        xAxis: { type: "property", path: ["deleted", "Area"] },
        yAxis: { type: "categorical", key: "tags" },
        gate,
        gateEnabled: true,
      },
      {
        id: "p2",
        xAxis: { type: "property", path: ["kept", "Area"] },
        yAxis: { type: "categorical", key: "shape" },
        gate,
        gateEnabled: true,
      },
    ]);
    filters.setAnalysisGateIds({ p1: ["a"], p2: ["a"] });
    vi.spyOn(main.api, "updateConfigurationKey").mockResolvedValue({} as any);
    vi.spyOn(main, "scheduleAnnotationBrowserSave").mockImplementation(
      () => undefined,
    );

    await propertyStore.deleteProperty("deleted");

    expect(filters.analysisPlots[0].xAxis).toBeNull();
    expect(filters.analysisPlots[0].gate).toBeNull();
    expect(filters.analysisGateIds).toEqual({});
  });

  it("surfaces the backend's message when deleting a propertyIds sync fails", async () => {
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([{ id: "p1", name: "Area" }]);
    vi.spyOn(main.api, "updateConfigurationKey").mockRejectedValue(
      new Error("Read-only collection"),
    );

    expect(await messageOf(propertyStore.deleteProperty("p1"))).toBe(
      "Read-only collection",
    );
  });

  // A server job (materialize, neighborhood) registered "x" and the client
  // adopted it, then fetched the list as refreshWrittenMeasurements does.
  async function adoptAndFetch(listed: { id: string; name: string }[]) {
    await propertyStore.adoptServerRegisteredProperty("x");
    // Idempotent, also while a save is pending.
    await propertyStore.adoptServerRegisteredProperty("x");
    vi.spyOn(propertyStore.propertiesAPI, "getProperties").mockResolvedValue(
      listed as any,
    );
    await propertyStore.fetchProperties();
  }

  it("keeps a property adopted during a pending save when that save fails", async () => {
    (main as any).configuration.propertyIds = ["p1", "p2"];
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([
      { id: "p1", name: "Area" },
      { id: "p2", name: "Perimeter" },
    ]);
    let failDelete!: (error: Error) => void;
    const saved: string[][] = [];
    vi.spyOn(main.api, "updateConfigurationKey")
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failDelete = reject;
          }),
      )
      .mockImplementation(async (configuration: any, key: string) => {
        if (key === "propertyIds") saved.push([...configuration.propertyIds]);
        return {} as any;
      });

    const deletion = messageOf(propertyStore.deleteProperty("p1"));
    await adoptAndFetch([
      { id: "p2", name: "Perimeter" },
      { id: "x", name: "Gene panel" },
    ]);
    failDelete(new Error("Read-only collection"));
    await deletion;

    // The server holds p1, p2 and the job's x.
    expect(main.configuration!.propertyIds).toEqual(["p1", "p2", "x"]);
    expect(propertyStore.properties.map((p) => p.id)).toEqual([
      "p1",
      "p2",
      "x",
    ]);

    // The next save keeps x registered rather than unregistering it.
    vi.spyOn(propertyStore.propertiesAPI, "createProperty").mockResolvedValue({
      id: "p3",
      name: "Count",
    } as any);
    await propertyStore.createProperty({ name: "Count" } as any);
    expect(saved).toEqual([["p1", "p2", "x", "p3"]]);
  });

  it("keeps a property adopted during a save that succeeds when a later overlapping save fails", async () => {
    (main as any).configuration.propertyIds = ["p1", "p2", "p3"];
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([
      { id: "p1", name: "Area" },
      { id: "p2", name: "Perimeter" },
      { id: "p3", name: "Count" },
    ]);
    let finishFirst!: (value: any) => void;
    let failSecond!: (error: Error) => void;
    const saved: string[][] = [];
    vi.spyOn(main.api, "updateConfigurationKey")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failSecond = reject;
          }),
      )
      .mockImplementation(async (configuration: any, key: string) => {
        if (key === "propertyIds") saved.push([...configuration.propertyIds]);
        return {} as any;
      });

    // The first save was sent before x was adopted, so its value lacks x.
    const first = propertyStore.deleteProperty("p1");
    await adoptAndFetch([
      { id: "p2", name: "Perimeter" },
      { id: "p3", name: "Count" },
      { id: "x", name: "Gene panel" },
    ]);
    const second = messageOf(propertyStore.deleteProperty("p2"));
    finishFirst({});
    await first;
    failSecond(new Error("Read-only collection"));
    await second;

    // The first delete landed; x, adopted after it was sent, stays confirmed
    // when the second delete fails.
    expect(main.configuration!.propertyIds).toEqual(["p2", "p3", "x"]);
    expect(propertyStore.properties.map((p) => p.id)).toEqual([
      "p2",
      "p3",
      "x",
    ]);
    // No save of its own: x is registered on the server already.
    expect(saved).toEqual([]);
  });

  it("carries over an adopted property no fetch has loaded yet when saving", async () => {
    (main as any).configuration.propertyIds = ["p1"];
    (
      propertyStore as unknown as {
        setPropertiesImpl: (properties: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl([{ id: "p1", name: "Area" }]);
    const saved: string[][] = [];
    vi.spyOn(main.api, "updateConfigurationKey").mockImplementation(
      async (configuration: any, key: string) => {
        if (key === "propertyIds") saved.push([...configuration.propertyIds]);
        return {} as any;
      },
    );
    vi.spyOn(propertyStore.propertiesAPI, "createProperty").mockResolvedValue({
      id: "p2",
      name: "Perimeter",
    } as any);

    // A create lands between the adoption and the fetch that loads x.
    await propertyStore.adoptServerRegisteredProperty("x");
    await propertyStore.createProperty({ name: "Perimeter" } as any);

    expect(saved).toEqual([["p1", "p2", "x"]]);
    expect(main.configuration!.propertyIds).toEqual(["p1", "p2", "x"]);
  });
});

describe("updateConfigurationPipelines rollback", () => {
  beforeEach(() => {
    setLoggedIn(true);
    (main as any).setConfigurationImpl({
      id: "c1",
      data: { id: "c1", name: "config", pipelines: [] } as any,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const pipelinesNamed = (name: string) =>
    [{ id: "pipe", name, steps: [] }] as any[];

  it("restores the configuration's pipelines when the save fails", async () => {
    (main as any).configuration.pipelines = pipelinesNamed("saved");
    vi.spyOn(main.api, "updateConfigurationKey").mockRejectedValue(
      new Error("Read-only collection"),
    );

    await messageOf(main.updateConfigurationPipelines(pipelinesNamed("edit")));

    expect(main.configuration!.pipelines[0].name).toBe("saved");
  });

  it("restores the saved pipelines when overlapping saves both fail", async () => {
    (main as any).configuration.pipelines = pipelinesNamed("saved");
    const fails: ((error: Error) => void)[] = [];
    vi.spyOn(main.api, "updateConfigurationKey").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fails.push(reject);
        }),
    );

    const first = messageOf(
      main.updateConfigurationPipelines(pipelinesNamed("first")),
    );
    const second = messageOf(
      main.updateConfigurationPipelines(pipelinesNamed("second")),
    );
    fails[0](new Error("Read-only collection"));
    await first;
    fails[1](new Error("Read-only collection"));
    await second;

    expect(main.configuration!.pipelines[0].name).toBe("saved");
  });

  it("keeps a later save's pipelines when an earlier overlapping save fails", async () => {
    let failFirst!: (error: Error) => void;
    vi.spyOn(main.api, "updateConfigurationKey")
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failFirst = reject;
          }),
      )
      .mockResolvedValue({} as any);

    const first = messageOf(
      main.updateConfigurationPipelines(pipelinesNamed("first")),
    );
    await main.updateConfigurationPipelines(pipelinesNamed("second"));
    failFirst(new Error("Read-only collection"));
    await first;

    expect(main.configuration!.pipelines[0].name).toBe("second");
  });
});

describe("adoptServerRegisteredProperty", () => {
  it("adds a server-registered id locally, once, without a write", async () => {
    (main as any).setConfigurationImpl({
      id: "c1",
      data: {
        id: "c1",
        name: "config",
        layers: [],
        tools: [],
        scales: {},
        propertyIds: ["a"],
      } as any,
    });
    const sync = vi.spyOn(main.api, "updateConfigurationKey");
    await propertyStore.adoptServerRegisteredProperty("b");
    await propertyStore.adoptServerRegisteredProperty("b");
    expect(main.configuration!.propertyIds).toEqual(["a", "b"]);
    expect(sync).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
