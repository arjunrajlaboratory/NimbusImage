import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import propertyStore from "./properties";
import main from "./index";
import store from "./root";

// fetchProperties loads a configuration's properties in one batch request.
// The server omits ids it cannot resolve, which covers both a deleted
// property (drop it) and one created moments ago whose propertyIds save has
// not landed yet (keep it: dropping it would be persisted by the next
// setProperties).

const property = (id: string) =>
  ({
    id,
    name: id,
    image: "img",
    shape: "point",
    tags: { tags: [], exclusive: false },
    workerInterface: {},
  }) as any;

function setConfiguration(propertyIds: string[], id = "c1") {
  (main as any).setConfigurationImpl({
    id,
    data: {
      id,
      name: "config",
      layers: [],
      tools: [],
      scales: {},
      propertyIds,
    } as any,
  });
}

describe("fetchProperties", () => {
  beforeEach(() => {
    (store.state as any).main.girderUser = { _id: "u1" };
    (propertyStore as any).setPropertiesImpl([]);
    vi.spyOn(propertyStore, "fetchUncomputedCounts").mockResolvedValue(
      undefined,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the returned properties in configuration order", async () => {
    setConfiguration(["p2", "p1"]);
    const getProperties = vi
      .spyOn(propertyStore.propertiesAPI, "getProperties")
      .mockResolvedValue([property("p2"), property("p1")]);

    await propertyStore.fetchProperties();

    expect(getProperties).toHaveBeenCalledWith(["p2", "p1"]);
    expect(propertyStore.properties.map((p) => p.id)).toEqual(["p2", "p1"]);
  });

  it("drops a deleted property that was never loaded", async () => {
    setConfiguration(["p1", "deleted"]);
    vi.spyOn(propertyStore.propertiesAPI, "getProperties").mockResolvedValue([
      property("p1"),
    ]);

    await propertyStore.fetchProperties();

    expect(propertyStore.properties.map((p) => p.id)).toEqual(["p1"]);
  });

  it("keeps a property still being created that the server does not list yet", async () => {
    setConfiguration(["p1"]);
    (propertyStore as any).setPropertiesImpl([property("p1")]);
    vi.spyOn(propertyStore.propertiesAPI, "createProperty").mockResolvedValue(
      property("new"),
    );
    // Hold the propertyIds save open, and fetch while it is in flight.
    let finishSave: () => void = () => {};
    vi.spyOn(main.api, "updateConfigurationKey").mockImplementation(
      () => new Promise<any>((resolve) => (finishSave = () => resolve({}))),
    );
    vi.spyOn(propertyStore.propertiesAPI, "getProperties").mockResolvedValue([
      property("p1"),
    ]);

    const creating = propertyStore.createProperty({ name: "new" } as any);
    await vi.waitFor(() =>
      expect(main.configuration!.propertyIds).toEqual(["p1", "new"]),
    );
    await propertyStore.fetchProperties();

    expect(propertyStore.properties.map((p) => p.id)).toEqual(["p1", "new"]);
    finishSave();
    await creating;
  });

  it("drops a loaded property deleted on the server", async () => {
    // Not being created, so the omission means it is gone.
    (propertyStore as any).setPropertiesImpl([
      property("p1"),
      property("gone"),
    ]);
    setConfiguration(["p1", "gone"]);
    vi.spyOn(propertyStore.propertiesAPI, "getProperties").mockResolvedValue([
      property("p1"),
    ]);

    await propertyStore.fetchProperties();

    expect(propertyStore.properties.map((p) => p.id)).toEqual(["p1"]);
  });

  it("prefers the server's copy of a property it returns", async () => {
    (propertyStore as any).setPropertiesImpl([
      { ...property("p1"), name: "stale" },
    ]);
    setConfiguration(["p1"]);
    vi.spyOn(propertyStore.propertiesAPI, "getProperties").mockResolvedValue([
      { ...property("p1"), name: "fresh" },
    ]);

    await propertyStore.fetchProperties();

    expect(propertyStore.properties.map((p) => p.name)).toEqual(["fresh"]);
  });

  it("ignores a response that arrives after the configuration changed", async () => {
    setConfiguration(["old"]);
    let respond: (properties: any[]) => void = () => {};
    vi.spyOn(propertyStore.propertiesAPI, "getProperties").mockImplementation(
      () => new Promise<any>((resolve) => (respond = resolve)),
    );

    const fetching = propertyStore.fetchProperties();
    // A dataset switch replaces the configuration mid-fetch.
    setConfiguration(["new"], "c2");
    (propertyStore as any).setPropertiesImpl([property("new")]);
    respond([property("old")]);
    await fetching;

    expect(propertyStore.properties.map((p) => p.id)).toEqual(["new"]);
  });
});
