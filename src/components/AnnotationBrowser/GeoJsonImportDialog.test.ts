import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1", name: "TestDataset", width: 100, height: 100 },
    isLoggedIn: true,
    xy: 1,
    z: 2,
    time: 3,
    layers: [
      { id: "layer-a", name: "DAPI", channel: 0 },
      { id: "layer-b", name: "CD3", channel: 2 },
    ],
  },
}));

vi.mock("@/utils/annotationImport", () => ({
  importGeoJsonAnnotations: vi.fn().mockResolvedValue(1),
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

import GeoJsonImportDialog from "./GeoJsonImportDialog.vue";
import { importGeoJsonAnnotations } from "@/utils/annotationImport";

// jsdom's File has no text(), so hand the dialog a File-like stand-in.
function geoJsonFile(content: unknown): File {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return { name: "regions.geojson", text: async () => text } as File;
}

const regions = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 0],
          ],
          [
            [1, 1],
            [2, 1],
            [2, 2],
            [1, 1],
          ],
        ],
      },
      properties: { classification: { name: "Tumor" } },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [150, 5] },
      properties: { name: "Outlier" },
    },
    {
      type: "Feature",
      geometry: { type: "GeometryCollection", geometries: [] },
      properties: {},
    },
  ],
};

async function mountWithFile(content: unknown) {
  const wrapper = shallowMount(GeoJsonImportDialog);
  wrapper.vm.dialog = true;
  await flushPromises();
  wrapper.vm.file = geoJsonFile(content);
  await flushPromises();
  return wrapper;
}

describe("GeoJsonImportDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("previews shapes, classes, skips, holes and out-of-bounds", async () => {
    const wrapper = await mountWithFile(regions);
    expect(wrapper.vm.parseError).toBe("");
    expect(wrapper.vm.parsed?.annotations).toHaveLength(2);
    expect(wrapper.vm.preview.byShape).toEqual({ polygon: 1, point: 1 });
    expect(wrapper.vm.preview.byClass).toEqual({ Tumor: 1, Outlier: 1 });
    expect(wrapper.vm.preview.outOfBounds).toBe(1);
    expect(wrapper.vm.skippedSummary).toBe(
      "1 GeometryCollection, 1 polygon hole (outer boundaries only)",
    );
    expect(wrapper.vm.canImport).toBe(true);
  });

  it("shows the parser's message for invalid input", async () => {
    const wrapper = await mountWithFile({ type: "Topology" });
    expect(wrapper.vm.parsed).toBeNull();
    expect(wrapper.vm.parseError).toMatch(/Unsupported GeoJSON type/);
    expect(wrapper.vm.canImport).toBe(false);

    wrapper.vm.file = geoJsonFile("{not json");
    await flushPromises();
    expect(wrapper.vm.parseError).toMatch(/not valid JSON/);
  });

  it("warns when the extra tag is not region", async () => {
    // Spatial analyses leave out only "region"-tagged polygons.
    const wrapper = await mountWithFile(regions);
    expect(wrapper.vm.extraTag).toBe("region");
    expect(wrapper.vm.extraTagHint).toBe("");
    wrapper.vm.extraTag = "pathology";
    await flushPromises();
    expect(wrapper.vm.extraTagHint).toMatch(/treat these polygons as cells/);
    wrapper.vm.extraTag = "";
    await flushPromises();
    expect(wrapper.vm.extraTagHint).toMatch(/need the tag "region"/);
  });

  it("cannot import a file with nothing importable", async () => {
    const wrapper = await mountWithFile({
      type: "FeatureCollection",
      features: [],
    });
    expect(wrapper.vm.parseError).toMatch(/no geometries/);
    expect(wrapper.vm.canImport).toBe(false);
  });

  it("imports at the current location with the chosen layer's channel", async () => {
    const wrapper = await mountWithFile(regions);
    expect(wrapper.vm.layerId).toBe("layer-a");
    wrapper.vm.layerId = "layer-b";
    wrapper.vm.extraTag = "pathology";
    await wrapper.vm.submit();

    const [bases] = (importGeoJsonAnnotations as any).mock.calls[0];
    expect(bases).toHaveLength(2);
    expect(bases[0]).toMatchObject({
      datasetId: "ds1",
      channel: 2,
      location: { XY: 1, Z: 2, Time: 3 },
      tags: ["Tumor", "pathology"],
      shape: "polygon",
    });
    expect(bases[1].tags).toEqual(["Outlier", "pathology"]);
    expect(wrapper.vm.dialog).toBe(false);
  });

  it("keeps the dialog open with the error when the import fails", async () => {
    (importGeoJsonAnnotations as any).mockRejectedValueOnce(
      new Error("Creating annotations failed after 0 of 2"),
    );
    const wrapper = await mountWithFile(regions);
    await wrapper.vm.submit();
    expect(wrapper.vm.dialog).toBe(true);
    expect(wrapper.vm.importError).toMatch(/failed after 0 of 2/);
  });
});
